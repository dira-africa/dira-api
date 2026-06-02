/*
 * Copyright 2026 Blockchain & Climate Institute
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import AfricaTalking from "africastalking";
import { randomUUID, createHash } from "crypto";
import { query } from "../db/query";
import { tokenService } from "./tokenService";
import { env } from "../config/env";
import { notificationsQueue } from "../jobs/queues";

// Initialize Africa's Talking SDK.
const at = AfricaTalking({
  apiKey: env.AFRICAS_TALKING_API_KEY || "mock",
  username: env.AFRICAS_TALKING_USERNAME || "sandbox"
});

export class AirtimeService {
  /**
   * Initiates airtime redemption utilizing the official Africa's Talking SDK.
   * Enforces deduct-first pattern to prevent double-spending, with auto-refund on failure.
   */
  async initiateAirtimeRedemption(
    userId: string,
    tokenAmount: number,
    phoneNumber: string
  ): Promise<{ success: boolean; kes_disbursed: number; phone: string; transactionId: string }> {
    // 1. Validation Checks
    if (tokenAmount < 20) {
      throw new Error("BELOW_MINIMUM_TOKENS");
    }

    const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
    if (!phoneRegex.test(phoneNumber)) {
      throw new Error("INVALID_PHONE_NUMBER");
    }

    const formattedPhoneNumber = phoneNumber.startsWith("0")
      ? `+254${phoneNumber.substring(1)}`
      : phoneNumber;

    const kesAmount = tokenAmount * 0.55;

    // 1.1 Verify token balance >= tokenAmount
    const { balance } = await tokenService.getBalance(userId);
    if (balance < tokenAmount) {
      throw new Error("INSUFFICIENT_TOKENS");
    }

    // 2. Generate redemptionId (UUID)
    const redemptionId = randomUUID();

    // Insert pending record in redemption_requests
    await query(
      `INSERT INTO redemption_requests (id, user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
       VALUES ($1, $2, $3, 'airtime', $4, pgp_sym_encrypt($5, $6), 'pending')`,
      [redemptionId, userId, tokenAmount, kesAmount, formattedPhoneNumber, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    // 3. Deduct tokens immediately using deductTokens()
    try {
      await tokenService.deductTokens(userId, tokenAmount, "redeem_airtime", redemptionId);
    } catch (err: any) {
      // Token deduction failed (likely insufficient balance due to a concurrent request)
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        ["INSUFFICIENT_TOKENS", redemptionId]
      );
      throw new Error("INSUFFICIENT_TOKENS");
    }

    // 4. Call AT Airtime API
    let atRequestId = "";
    let sendStatus = "";
    let errorMsg = "";

    try {
      const useMock = 
        !env.AFRICAS_TALKING_API_KEY || 
        env.AFRICAS_TALKING_API_KEY === "mock" || 
        phoneNumber.includes("999999") || 
        phoneNumber === "+254700000000";

      if (useMock) {
        console.log(`[AT-AIRTIME MOCK] Simulating sending KES ${kesAmount} to ${formattedPhoneNumber}`);
        if (phoneNumber.includes("999999") || env.AFRICAS_TALKING_API_KEY === "mock-fail") {
          sendStatus = "Failed";
          errorMsg = "Mock Africa's Talking API Failure";
        } else {
          sendStatus = "Sent";
          atRequestId = `at_mock_tx_${createHash("sha256").update(`${formattedPhoneNumber}_${kesAmount}_${Date.now()}`).digest("hex").substring(0, 16)}`;
        }
      } else {
        const response = await at.AIRTIME.send({
          recipients: [
            {
              phoneNumber: formattedPhoneNumber,
              currencyCode: "KES",
              amount: kesAmount
            }
          ]
        });

        if (response && response.responses && response.responses.length > 0) {
          const atRes = response.responses[0];
          sendStatus = atRes.status;
          atRequestId = atRes.requestId;
          errorMsg = atRes.errorMessage;
        } else {
          sendStatus = "Failed";
          errorMsg = response?.errorMessage || "Empty response from Africa's Talking";
        }
      }
    } catch (err: any) {
      console.error("Africa's Talking API Error:", err);
      sendStatus = "Failed";
      errorMsg = err.message || "Failed to communicate with Africa's Talking API";
    }

    // 5. If AT returns status !== 'Sent'
    if (sendStatus !== "Sent") {
      console.warn(`Disbursement failed: ${errorMsg}. Rolling back transaction...`);

      // Update request status to failed
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [errorMsg || "Africa's Talking Send Failed", redemptionId]
      );

      // Refund tokens using creditTokens() with type 'adjustment'
      await tokenService.creditTokens(
        userId,
        tokenAmount,
        "adjustment",
        redemptionId,
        `Refund: Failed airtime redemption to ${formattedPhoneNumber}`
      );

      throw new Error("AIRTIME_SEND_FAILED");
    }

    // 6. On success: record AT requestId in redemption_requests table
    await query(
      `UPDATE redemption_requests 
       SET status = 'completed', 
           at_transaction_id = $1, 
           completed_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [atRequestId, redemptionId]
    );

    // Send success notification via Telegram
    try {
      const userRes = await query("SELECT telegram_id, language FROM users WHERE id = $1", [userId]);
      const user = userRes.rows[0];
      if (user && user.telegram_id) {
        const isSw = user.language === "sw";
        const msg = isSw 
          ? `Hongera! Ombi lako la kukomboa hewani la KES ${kesAmount.toFixed(2)} limefaulu. Utapokea salio hivi karibuni kwenye nambari ${formattedPhoneNumber}.`
          : `Congratulations! Your airtime redemption request of KES ${kesAmount.toFixed(2)} was successful. You will receive the airtime shortly on ${formattedPhoneNumber}.`;
        
        await notificationsQueue.add("send-telegram", {
          telegramId: String(user.telegram_id),
          message: msg
        });
      }
    } catch (notifErr) {
      console.error("Failed to queue Telegram notification:", notifErr);
    }

    // 7. Return success object
    return {
      success: true,
      kes_disbursed: kesAmount,
      phone: formattedPhoneNumber,
      transactionId: atRequestId
    };
  }

  /**
   * Keep sendAirtime for backward compatibility with external integrations
   */
  async sendAirtime(
    phoneNumber: string,
    amountKes: number
  ): Promise<{ success: boolean; txId?: string; errorMessage?: string }> {
    const formattedPhoneNumber = phoneNumber.startsWith("0")
      ? `+254${phoneNumber.substring(1)}`
      : phoneNumber;

    if (!env.AFRICAS_TALKING_API_KEY || env.AFRICAS_TALKING_API_KEY === "mock") {
      console.log(`[AT-AIRTIME MOCK] Simulating sending KES ${amountKes} to ${formattedPhoneNumber}`);
      const txId = `at_mock_tx_${createHash("sha256").update(`${formattedPhoneNumber}_${amountKes}_${Date.now()}`).digest("hex").substring(0, 16)}`;
      return { success: true, txId };
    }

    try {
      const response = await at.AIRTIME.send({
        recipients: [
          {
            phoneNumber: formattedPhoneNumber,
            currencyCode: "KES",
            amount: amountKes
          }
        ]
      });

      if (response && response.responses && response.responses.length > 0) {
        const atRes = response.responses[0];
        if (atRes.status === "Sent") {
          return { success: true, txId: atRes.requestId };
        } else {
          return { success: false, errorMessage: atRes.errorMessage };
        }
      }
      return { success: false, errorMessage: "Empty response from Africa's Talking" };
    } catch (err: any) {
      return { success: false, errorMessage: err.message || "Failed to disburse airtime." };
    }
  }
}

export const airtimeService = new AirtimeService();
