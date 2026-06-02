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

import { env } from "../config/env";
import { createHash, randomUUID } from "crypto";
import { query } from "../db/query";
import { tokenService } from "./tokenService";
import { redis } from "../db/redis";

export class PaymentService {
  /**
   * Fetches the OAuth Access Token from Safaricom Daraja API
   */
  async getDarajaOAuthToken(): Promise<string> {
    try {
      const cachedToken = await redis.get("daraja:oauth_token");
      if (cachedToken) {
        return cachedToken;
      }
    } catch (redisErr) {
      console.warn("Failed to read from Redis cache for Daraja token:", redisErr);
    }

    const consumerKey = env.DARAJA_CONSUMER_KEY;
    const consumerSecret = env.DARAJA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      throw new Error("Daraja Consumer Key and Consumer Secret must be set.");
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const isProduction = env.DARAJA_PRODUCTION_ACTIVE;
    const host = isProduction ? "api.safaricom.co.ke" : "sandbox.safaricom.co.ke";
    const url = `https://${host}/oauth/v1/generate?grant_type=client_credentials`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Daraja Access Token: HTTP ${response.status}`);
    }

    const data = await response.json();
    const token = data.access_token;
    
    // Cache in Redis for 55 minutes
    try {
      await redis.set("daraja:oauth_token", token, "EX", 55 * 60);
    } catch (redisErr) {
      console.warn("Failed to write Daraja token to Redis cache:", redisErr);
    }

    return token;
  }

  /**
   * Triggers a B2C disbursement to the recipient phone number (Legacy method wrapper)
   */
  async triggerMpesaB2C(
    phoneNumber: string,
    amountKes: number
  ): Promise<{
    success: boolean;
    conversationId?: string;
    errorMessage?: string;
  }> {
    const formattedPhoneNumber = phoneNumber.startsWith("+")
      ? phoneNumber.substring(1)
      : phoneNumber.startsWith("0")
      ? `254${phoneNumber.substring(1)}`
      : phoneNumber;

    if (!env.DARAJA_CONSUMER_KEY || !env.DARAJA_CONSUMER_SECRET) {
      console.log(`[DARAJA-MPESA MOCK] Simulating B2C disbursement of KES ${amountKes} to ${formattedPhoneNumber}`);
      const conversationId = `mpesa_mock_conv_${createHash("sha256").update(`${formattedPhoneNumber}_${amountKes}_${Date.now()}`).digest("hex").substring(0, 16)}`;
      return {
        success: true,
        conversationId
      };
    }

    try {
      const accessToken = await this.getDarajaOAuthToken();
      const host = env.DARAJA_PRODUCTION_ACTIVE ? "api.safaricom.co.ke" : "sandbox.safaricom.co.ke";
      const url = `https://${host}/mpesa/b2c/v3/paymentrequest`;

      const payload = {
        InitiatorName: env.DARAJA_INITIATOR_NAME || "testapi",
        SecurityCredential: env.DARAJA_SECURITY_CREDENTIAL || "test_cred",
        CommandID: "BusinessPayment",
        Amount: Math.floor(amountKes),
        PartyA: env.DARAJA_SHORTCODE || "600000",
        PartyB: formattedPhoneNumber,
        Remarks: "Legacy_Cashout",
        QueueTimeOutURL: "https://app.dira.africa/api/webhooks/daraja/timeout",
        ResultURL: "https://app.dira.africa/api/webhooks/daraja/result",
        Occasion: "ClimateReward"
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`Daraja B2C Payment request HTTP error: ${response.status}`);
      }

      const data = await response.json();

      if (data.ResponseCode === "0") {
        return {
          success: true,
          conversationId: data.ConversationID
        };
      } else {
        throw new Error(data.ResponseDescription || "Daraja disbursement request rejected.");
      }
    } catch (err: any) {
      console.error("Daraja B2C Payment Request failed:", err);
      return {
        success: false,
        errorMessage: err.message || "Failed to trigger Daraja payment request."
      };
    }
  }

  /**
   * Initiates the B2C cashout process: inserts request, deducts tokens, calls Daraja, and handles rollback.
   */
  async initiateMpesaB2C(
    userId: string,
    tokenAmount: number,
    phoneNumber: string
  ): Promise<{
    success: boolean;
    message: string;
    amountKes: number;
    conversationId: string;
    redemptionId: string;
  }> {
    // 1. Gating check
    const isProductionActive = process.env.DARAJA_PRODUCTION_ACTIVE === "true" || env.DARAJA_PRODUCTION_ACTIVE;
    if (!isProductionActive) {
      throw new Error("MPESA_NOT_YET_ACTIVE");
    }

    // 2. Validate tokenAmount minimum (100 tokens)
    if (tokenAmount < 100) {
      throw new Error("BELOW_MINIMUM_TOKENS");
    }

    // 3. Validate phone format
    const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
    if (!phoneRegex.test(phoneNumber)) {
      throw new Error("INVALID_PHONE_NUMBER");
    }

    const formattedPhoneNumber = phoneNumber.startsWith("+")
      ? phoneNumber.substring(1)
      : phoneNumber.startsWith("0")
      ? `254${phoneNumber.substring(1)}`
      : phoneNumber;

    const amountKes = tokenAmount * 0.50; // 1 token = 0.50 KES

    // 4. Generate redemption UUID
    const redemptionId = randomUUID();

    // 5. Insert pending request to database
    await query(
      `INSERT INTO redemption_requests (id, user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
       VALUES ($1, $2, $3, 'mpesa', $4, pgp_sym_encrypt($5, $6), 'pending')`,
      [redemptionId, userId, tokenAmount, amountKes, `+${formattedPhoneNumber}`, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    // 6. Deduct tokens immediately (deduct-first pattern)
    try {
      await tokenService.deductTokens(userId, tokenAmount, "redeem_mpesa", redemptionId);
    } catch (err: any) {
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', 
             failure_reason = $1, 
             completed_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        ["INSUFFICIENT_TOKENS", redemptionId]
      );
      throw new Error("INSUFFICIENT_TOKENS");
    }

    // 7. Invoke Daraja API (or mock if key not present)
    const consumerKey = env.DARAJA_CONSUMER_KEY;
    const consumerSecret = env.DARAJA_CONSUMER_SECRET;
    const useMock = !consumerKey || !consumerSecret || consumerKey === "mock" || phoneNumber.includes("999999");

    if (useMock) {
      console.log(`[DARAJA-MPESA B2C MOCK] Simulating B2C disbursement of KES ${amountKes} to ${formattedPhoneNumber}`);
      const mockConversationId = `mpesa_mock_conv_${createHash("sha256").update(`${formattedPhoneNumber}_${amountKes}_${Date.now()}`).digest("hex").substring(0, 16)}`;

      await query(
        `UPDATE redemption_requests 
         SET status = 'processing', 
             at_transaction_id = $1 
         WHERE id = $2`,
        [mockConversationId, redemptionId]
      );

      return {
        success: true,
        message: "Cashout request submitted to M-Pesa. Processing transaction.",
        amountKes,
        conversationId: mockConversationId,
        redemptionId
      };
    }

    try {
      const accessToken = await this.getDarajaOAuthToken();
      const host = env.DARAJA_PRODUCTION_ACTIVE ? "api.safaricom.co.ke" : "sandbox.safaricom.co.ke";
      const url = `https://${host}/mpesa/b2c/v3/paymentrequest`;

      const payload = {
        InitiatorName: env.DARAJA_INITIATOR_NAME || "testapi",
        SecurityCredential: env.DARAJA_SECURITY_CREDENTIAL || "test_cred",
        CommandID: "BusinessPayment",
        Amount: Math.floor(amountKes),
        PartyA: env.DARAJA_SHORTCODE || "600000",
        PartyB: formattedPhoneNumber,
        Remarks: redemptionId,
        QueueTimeOutURL: "https://app.dira.africa/api/webhooks/daraja/timeout",
        ResultURL: "https://app.dira.africa/api/webhooks/daraja/result",
        Occasion: "ClimateReward"
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`Daraja B2C Payment request HTTP error: ${response.status}`);
      }

      const data = await response.json();

      if (data.ResponseCode === "0") {
        const conversationId = data.ConversationID;
        await query(
          `UPDATE redemption_requests 
           SET status = 'processing', 
               at_transaction_id = $1 
           WHERE id = $2`,
          [conversationId, redemptionId]
        );

        return {
          success: true,
          message: "Cashout request submitted to M-Pesa. Processing transaction.",
          amountKes,
          conversationId,
          redemptionId
        };
      } else {
        throw new Error(data.ResponseDescription || "Daraja disbursement request rejected.");
      }
    } catch (err: any) {
      console.error("Daraja B2C Request Failure: rolling back tokens. Error details:", err);

      // Refund tokens immediately
      await tokenService.creditTokens(
        userId,
        tokenAmount,
        "adjustment",
        redemptionId,
        `M-Pesa refund: ${err.message || "Failed to trigger Daraja request"}`
      );

      // Update database status
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', 
             failure_reason = $1, 
             completed_at = CURRENT_TIMESTAMP 
         WHERE id = $2`,
        [err.message || "Failed to trigger Safaricom Daraja request", redemptionId]
      );

      throw new Error("API_DISBURSEMENT_FAILED");
    }
  }
}

export const paymentService = new PaymentService();
