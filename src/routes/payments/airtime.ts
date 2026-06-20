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

import { FastifyInstance } from "fastify";
import { query } from "../../db/query";
import { tokenService } from "../../services/tokenService";
import { airtimeService } from "../../services/airtimeService";
import { env } from "../../config/env";

interface RedeemAirtimeBody {
  tokenAmount: number;
  phoneNumber: string;
}

export default async function airtimeRoutes(fastify: FastifyInstance) {
  
  // POST /api/payments/airtime/redeem
  fastify.post<{ Body: RedeemAirtimeBody }>(
    "/redeem",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { tokenAmount, phoneNumber } = request.body;

      // 1. Validation Checks for missing fields
      if (tokenAmount === undefined || !phoneNumber) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and phoneNumber are required." }
        });
      }

      try {
        const result = await airtimeService.initiateAirtimeRedemption(userId, tokenAmount, phoneNumber);
        return {
          success: true,
          message: "Airtime sent successfully.",
          amountKes: result.kes_disbursed,
          txId: result.transactionId
        };
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 20 Climate Tokens." }
          });
        }
        if (err.message === "INVALID_PHONE_NUMBER") {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_PHONE", message: "Please provide a valid Kenyan mobile number." }
          });
        }
        if (err.message === "INSUFFICIENT_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient token balance." }
          });
        }
        if (err.message === "AIRTIME_SEND_FAILED") {
          return reply.status(502).send({
            success: false,
            error: { code: "API_DISBURSEMENT_FAILED", message: "Airtime disbursement failed." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process airtime redemption." }
        });
      }
    }
  );
}
