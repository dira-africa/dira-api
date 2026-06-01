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

      // 1. Validation Checks
      if (tokenAmount === undefined || !phoneNumber) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and phoneNumber are required." }
        });
      }

      if (tokenAmount < 20) {
        return reply.status(400).send({
          success: false,
          error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 20 Climate Tokens." }
        });
      }

      const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
      if (!phoneRegex.test(phoneNumber)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_PHONE", message: "Please provide a valid Kenyan mobile number." }
        });
      }

      const amountKes = tokenAmount * 0.55;

      try {
        // 2. Insert redemption request as 'pending'
        const reqRes = await query(
          `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
           VALUES ($1, $2, 'airtime', $3, pgp_sym_encrypt($4, $5), 'pending')
           RETURNING id`,
          [userId, tokenAmount, amountKes, phoneNumber, env.PGCRYPTO_SYMMETRIC_KEY]
        );
        const requestId = reqRes.rows[0].id;

        // 3. Deduct tokens from user's ledger
        // Due to check constraints, this throws an error if balance goes negative
        try {
          await tokenService.awardTokens(
            userId,
            -tokenAmount,
            `Redeemed ${tokenAmount} tokens for KES ${amountKes.toFixed(2)} airtime`,
            "redeem_airtime",
            requestId
          );
        } catch (err: any) {
          // Token deduction failed (likely insufficient balance)
          await query(
            "UPDATE redemption_requests SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2",
            ["Insufficient token balance.", requestId]
          );
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient token balance." }
          });
        }

        // 4. Trigger Africa's Talking disbursement
        const atResult = await airtimeService.sendAirtime(phoneNumber, amountKes);

        if (atResult.success) {
          // Update status to completed
          await query(
            `UPDATE redemption_requests 
             SET status = 'completed', 
                 at_transaction_id = $1, 
                 completed_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [atResult.txId || null, requestId]
          );

          return {
            success: true,
            message: "Airtime sent successfully.",
            amountKes,
            txId: atResult.txId
          };
        } else {
          // API failed -> update status to failed and refund tokens
          await query(
            `UPDATE redemption_requests 
             SET status = 'failed', 
                 failure_reason = $1, 
                 completed_at = CURRENT_TIMESTAMP 
             WHERE id = $2`,
            [atResult.errorMessage || "Africa's Talking API failed", requestId]
          );

          // Refund tokens back to user ledger
          await tokenService.awardTokens(
            userId,
            tokenAmount,
            `Refund: Failed airtime redemption of ${tokenAmount} tokens`,
            "adjustment",
            requestId
          );

          return reply.status(502).send({
            success: false,
            error: { code: "API_DISBURSEMENT_FAILED", message: atResult.errorMessage || "Airtime disbursement failed." }
          });
        }
      } catch (err: any) {
        console.error("Airtime redemption route error:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process airtime redemption." }
        });
      }
    }
  );
}
