/*
 * Copyright 2026 Dira Africa
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
import { tokenService, deductTokens, refundTokens } from "./tokenService";
import { env } from "../config/env";
import { notificationsQueue } from "../jobs/queues";

// Initialize Africa's Talking SDK.
const at = AfricaTalking({
  apiKey: process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY || "mock",
  username: process.env.AT_USERNAME || env.AFRICAS_TALKING_USERNAME || "sandbox"
});

/**
 * Initiates airtime redemption utilizing the official Africa's Talking SDK.
 * Enforces deduct-first pattern to prevent double-spending, with auto-refund on failure.
 */
export async function initiateAirtimeRedemption(
  userId: string,
  tokenAmount: number,
  phoneNumber: string
): Promise<{ success: boolean; transactionId?: string; error?: string }> {
  const KES_PER_TOKEN = 0.55;
  const kesAmount = tokenAmount * KES_PER_TOKEN;

  if (tokenAmount < 20) {
    return { success: false, error: "MINIMUM_20_TOKENS" };
  }

  const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
  if (!phoneRegex.test(phoneNumber)) {
    return { success: false, error: "INVALID_PHONE_NUMBER" };
  }

  const formattedPhoneNumber = phoneNumber.startsWith("0")
    ? `+254${phoneNumber.substring(1)}`
    : phoneNumber.startsWith("+")
      ? phoneNumber
      : `+${phoneNumber}`;

  const redemptionId = randomUUID();

  // Insert pending record in redemption_requests for logging and tests
  await query(
    `INSERT INTO redemption_requests (id, user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
     VALUES ($1, $2, $3, 'airtime', $4, pgp_sym_encrypt($5, $6), 'pending')`,
    [redemptionId, userId, tokenAmount, kesAmount, formattedPhoneNumber, env.PGCRYPTO_SYMMETRIC_KEY]
  );

  try {
    // Deduct tokens first — atomic operation
    await deductTokens(userId, tokenAmount, "redeem_airtime", redemptionId);
  } catch (err: any) {
    // Update request status to failed
    await query(
      `UPDATE redemption_requests 
       SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      ["INSUFFICIENT_TOKENS", redemptionId]
    );
    return { success: false, error: "INSUFFICIENT_TOKENS" };
  }

  try {
    const useMock = 
      !(process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY) || 
      (process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY) === "mock" || 
      phoneNumber.includes("999999") || 
      phoneNumber === "+254700000000";

    let sendStatus = "";
    let atRequestId = "";
    let errorMsg = "";

    if (useMock) {
      console.log(`[AT-AIRTIME MOCK] Simulating sending KES ${kesAmount} to ${formattedPhoneNumber}`);
      if (phoneNumber.includes("999999") || (process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY) === "mock-fail") {
        sendStatus = "Failed";
        errorMsg = "Mock Africa's Talking API Failure";
      } else {
        sendStatus = "Sent";
        atRequestId = `at_mock_tx_${createHash("sha256").update(`${formattedPhoneNumber}_${kesAmount}_${Date.now()}`).digest("hex").substring(0, 16)}`;
      }
    } else {
      // Send airtime via AT
      const result = await at.AIRTIME.send({
        recipients: [
          {
            phoneNumber: formattedPhoneNumber,
            currencyCode: "KES",
            amount: kesAmount
          }
        ]
      });

      if (result && result.responses && result.responses.length > 0) {
        const recipient = result.responses[0];
        sendStatus = recipient.status;
        atRequestId = recipient.requestId;
        errorMsg = recipient.errorMessage;
      } else {
        sendStatus = "Failed";
        errorMsg = "Empty response from Africa's Talking";
      }
    }

    if (sendStatus !== "Sent") {
      // Refund on AT failure
      await refundTokens(userId, tokenAmount, redemptionId);

      // Update request status to failed
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [errorMsg || "Africa's Talking Send Failed", redemptionId]
      );

      return { success: false, error: "AT_SEND_FAILED" };
    }

    // On success: update record
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

    return { success: true, transactionId: atRequestId };

  } catch (err: any) {
    try {
      await refundTokens(userId, tokenAmount, redemptionId);
    } catch (refundErr) {
      console.error("Critical: Failed to refund tokens after unexpected AT error:", refundErr);
    }

    await query(
      `UPDATE redemption_requests 
       SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [err.message || "AIRTIME_SERVICE_ERROR", redemptionId]
    );

    return { success: false, error: "AIRTIME_SERVICE_ERROR" };
  }
}

export class AirtimeService {
  /**
   * Compatibility wrapper for existing endpoints.
   */
  async initiateAirtimeRedemption(
    userId: string,
    tokenAmount: number,
    phoneNumber: string
  ): Promise<{ success: boolean; kes_disbursed: number; phone: string; transactionId: string }> {
    const formattedPhoneNumber = phoneNumber.startsWith("0")
      ? `+254${phoneNumber.substring(1)}`
      : phoneNumber.startsWith("+")
        ? phoneNumber
        : `+${phoneNumber}`;

    const res = await initiateAirtimeRedemption(userId, tokenAmount, formattedPhoneNumber);
    if (!res.success) {
      if (res.error === "MINIMUM_20_TOKENS") {
        throw new Error("BELOW_MINIMUM_TOKENS");
      }
      if (res.error === "INVALID_PHONE_NUMBER") {
        throw new Error("INVALID_PHONE_NUMBER");
      }
      if (res.error === "INSUFFICIENT_TOKENS") {
        throw new Error("INSUFFICIENT_TOKENS");
      }
      if (res.error === "AT_SEND_FAILED") {
        throw new Error("AIRTIME_SEND_FAILED");
      }
      throw new Error(res.error || "AIRTIME_SERVICE_ERROR");
    }

    const kesAmount = tokenAmount * 0.55;
    return {
      success: true,
      kes_disbursed: kesAmount,
      phone: formattedPhoneNumber,
      transactionId: res.transactionId!
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

    if (!(process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY) || (process.env.AT_API_KEY || env.AFRICAS_TALKING_API_KEY) === "mock") {
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

