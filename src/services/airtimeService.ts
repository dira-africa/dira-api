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

export class AirtimeService {
  async sendAirtime(
    phoneNumber: string,
    amountKes: number
  ): Promise<{ success: boolean; txId?: string; errorMessage?: string }> {
    const formattedPhoneNumber = phoneNumber.startsWith("0")
      ? `+254${phoneNumber.substring(1)}`
      : phoneNumber;

    if (!env.AFRICAS_TALKING_API_KEY) {
      console.log(`[AT-AIRTIME MOCK] Simulating sending KES ${amountKes} to ${formattedPhoneNumber}`);
      const txId = `at_mock_tx_${createHash("sha256").update(`${formattedPhoneNumber}_${amountKes}_${Date.now()}`).digest("hex").substring(0, 16)}`;
      return { success: true, txId };
    }

    try {
      const isSandbox = env.AFRICAS_TALKING_USERNAME === "sandbox";
      const domain = isSandbox ? "sandbox.africastalking.com" : "api.africastalking.com";
      const url = `https://${domain}/version1/airtime/send`;

      const recipients = JSON.stringify([
        {
          phoneNumber: formattedPhoneNumber,
          amount: `KES ${amountKes.toFixed(2)}`
        }
      ]);

      const params = new URLSearchParams();
      params.append("username", env.AFRICAS_TALKING_USERNAME);
      params.append("recipients", recipients);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "apiKey": env.AFRICAS_TALKING_API_KEY
        },
        body: params.toString(),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        throw new Error(`Africa's Talking HTTP error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Response format structure: { errorMessage: string, numSent: number, totalAmount: string, totalDiscount: string, responses: [{ phoneNumber: string, errorMessage: string, status: string, requestId: string, discount: string }] }
      if (data.errorMessage && data.errorMessage !== "None") {
        throw new Error(data.errorMessage);
      }

      const airtimeResponse = data.responses?.[0];
      if (airtimeResponse && airtimeResponse.status === "Sent") {
        return {
          success: true,
          txId: airtimeResponse.requestId
        };
      } else {
        throw new Error(airtimeResponse?.errorMessage || "Airtime disbursement failed status.");
      }
    } catch (err: any) {
      console.error("Africa's Talking Airtime failure:", err);
      return {
        success: false,
        errorMessage: err.message || "Failed to disburse airtime."
      };
    }
  }
}

export const airtimeService = new AirtimeService();
