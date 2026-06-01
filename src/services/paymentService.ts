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
import { createHash } from "crypto";

export class PaymentService {
  /**
   * Fetches the OAuth Access Token from Safaricom Daraja API
   */
  private async getAccessToken(): Promise<string> {
    const consumerKey = env.DARAJA_CONSUMER_KEY;
    const consumerSecret = env.DARAJA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      throw new Error("Daraja Consumer Key and Consumer Secret must be set.");
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

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
    return data.access_token;
  }

  /**
   * Triggers a B2C disbursement to the recipient phone number
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

    // Use Mock fallback if credentials are not configured
    if (!env.DARAJA_CONSUMER_KEY || !env.DARAJA_CONSUMER_SECRET) {
      console.log(`[DARAJA-MPESA MOCK] Simulating B2C disbursement of KES ${amountKes} to ${formattedPhoneNumber}`);
      const conversationId = `mpesa_mock_conv_${createHash("sha256").update(`${formattedPhoneNumber}_${amountKes}_${Date.now()}`).digest("hex").substring(0, 16)}`;
      return {
        success: true,
        conversationId
      };
    }

    try {
      const accessToken = await this.getAccessToken();
      const url = "https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest";

      const payload = {
        InitiatorName: env.DARAJA_INITIATOR_NAME || "testapi",
        SecurityCredential: env.DARAJA_SECURITY_CREDENTIAL || "test_cred",
        CommandID: "BusinessPayment",
        Amount: amountKes,
        PartyA: env.DARAJA_SHORTCODE || "600000",
        PartyB: formattedPhoneNumber,
        Remarks: "Dira Climate Tokens Cashout",
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

      // Successful request returns: { ConversationID: string, OriginatorConversationID: string, ResponseDescription: string, ResponseCode: "0" }
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
}

export const paymentService = new PaymentService();
