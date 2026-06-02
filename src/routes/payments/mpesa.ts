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

import { FastifyInstance } from "fastify";
import { paymentService } from "../../services/paymentService";
import { env } from "../../config/env";

interface CashoutMpesaBody {
  tokenAmount: number;
  phoneNumber: string;
}

export default async function mpesaRoutes(fastify: FastifyInstance) {
  
  // POST /api/payments/mpesa/cashout (Legacy endpoint wrapper)
  fastify.post<{ Body: CashoutMpesaBody }>(
    "/cashout",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      // 1. Gating Check
      const isProductionActive = process.env.DARAJA_PRODUCTION_ACTIVE === "true" || env.DARAJA_PRODUCTION_ACTIVE;
      if (!isProductionActive) {
        return reply.status(503).send({
          success: false,
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Safaricom B2C M-Pesa integration is not active in this environment."
          }
        });
      }

      const userId = request.user.id;
      const { tokenAmount, phoneNumber } = request.body;

      // 2. Validation
      if (tokenAmount === undefined || !phoneNumber) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and phoneNumber are required." }
        });
      }

      try {
        const result = await paymentService.initiateMpesaB2C(userId, tokenAmount, phoneNumber);
        return {
          success: true,
          message: "Cashout request submitted to M-Pesa. Processing transaction.",
          amountKes: result.amountKes,
          conversationId: result.conversationId
        };
      } catch (err: any) {
        if (err.message === "MPESA_NOT_YET_ACTIVE") {
          return reply.status(503).send({
            success: false,
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Safaricom B2C M-Pesa integration is not active in this environment."
            }
          });
        }
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 100 Climate Tokens for M-Pesa." }
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
        if (err.message === "API_DISBURSEMENT_FAILED") {
          return reply.status(502).send({
            success: false,
            error: { code: "API_DISBURSEMENT_FAILED", message: "Daraja B2C Payment request failed." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process M-Pesa cashout." }
        });
      }
    }
  );
}
