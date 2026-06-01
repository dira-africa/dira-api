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
import { query } from "../../db/query";
import { tokenService } from "../../services/tokenService";
import { paymentService } from "../../services/paymentService";
import { env } from "../../config/env";

interface CashoutMpesaBody {
  tokenAmount: number;
  phoneNumber: string;
}

export default async function mpesaRoutes(fastify: FastifyInstance) {
  
  // POST /api/payments/mpesa/cashout
  fastify.post<{ Body: CashoutMpesaBody }>(
    "/cashout",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      // 1. Gating Check
      if (!env.DARAJA_PRODUCTION_ACTIVE) {
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

      if (tokenAmount < 100) {
        return reply.status(400).send({
          success: false,
          error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 100 Climate Tokens for M-Pesa." }
        });
      }

      const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
      if (!phoneRegex.test(phoneNumber)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_PHONE", message: "Please provide a valid Kenyan mobile number." }
        });
      }

      const amountKes = tokenAmount * 1.0; // 1:1 conversion rate

      try {
        // 3. Insert redemption request as 'pending'
        const reqRes = await query(
          `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
           VALUES ($1, $2, 'mpesa', $3, pgp_sym_encrypt($4, $5), 'pending')
           RETURNING id`,
          [userId, tokenAmount, amountKes, phoneNumber, env.PGCRYPTO_SYMMETRIC_KEY]
        );
        const requestId = reqRes.rows[0].id;

        // 4. Deduct tokens from user's ledger
        try {
          await tokenService.awardTokens(
            userId,
            -tokenAmount,
            `Redeemed ${tokenAmount} tokens for Safaricom B2C M-Pesa KES ${amountKes.toFixed(2)} cashout`,
            "redeem_mpesa",
            requestId
          );
        } catch (err: any) {
          await query(
            "UPDATE redemption_requests SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2",
            ["Insufficient token balance.", requestId]
          );
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient token balance." }
          });
        }

        // 5. Trigger Safaricom Daraja B2C Payment request
        const b2cResult = await paymentService.triggerMpesaB2C(phoneNumber, amountKes);

        if (b2cResult.success) {
          // B2C request triggered successfully. We wait for asynchronous callback response.
          // Set status to 'processing'
          await query(
            `UPDATE redemption_requests 
             SET status = 'processing', 
                 at_transaction_id = $1 
             WHERE id = $2`,
            [b2cResult.conversationId || null, requestId]
          );

          return {
            success: true,
            message: "Cashout request submitted to M-Pesa. Processing transaction.",
            amountKes,
            conversationId: b2cResult.conversationId
          };
        } else {
          // API failed -> mark failed and refund tokens
          await query(
            `UPDATE redemption_requests 
             SET status = 'failed', 
                 failure_reason = $1, 
                 completed_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [b2cResult.errorMessage || "M-Pesa B2C Payment request failed", requestId]
          );

          // Refund tokens
          await tokenService.awardTokens(
            userId,
            tokenAmount,
            `Refund: Failed M-Pesa cashout of ${tokenAmount} tokens`,
            "adjustment",
            requestId
          );

          return reply.status(502).send({
            success: false,
            error: { code: "API_DISBURSEMENT_FAILED", message: b2cResult.errorMessage || "Daraja API failed." }
          });
        }
      } catch (err: any) {
        console.error("M-Pesa cashout route error:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process M-Pesa cashout." }
        });
      }
    }
  );
}
