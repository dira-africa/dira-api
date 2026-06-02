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
import { query } from "../db/query";
import { tokenService } from "../services/tokenService";

export default async function tokensRoutes(fastify: FastifyInstance) {
  // 1. GET /api/tokens/balance - Retrieve actual token balance, KES equivalents, and pending tokens
  fastify.get(
    "/balance",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const { balance } = await tokenService.getBalance(userId);

        // Calculate KES equivalents
        const kesEquivalentAirtime = Number((balance * 0.55).toFixed(2));
        const kesEquivalentCash = Number((balance * 0.50).toFixed(2));

        // Calculate pending tokens:
        // A. Sum of pending tokens in token_ledger
        const pendingLedgerRes = await query(
          "SELECT COALESCE(SUM(amount), 0) AS pending_ledger FROM token_ledger WHERE user_id = $1 AND notes = 'pending'",
          [userId]
        );
        const pendingLedger = Number(pendingLedgerRes.rows[0].pending_ledger);

        // B. Sum of pending crop submissions (valued at 5 tokens each standard reward)
        const pendingCropRes = await query(
          "SELECT COUNT(*) AS pending_count FROM crop_submissions WHERE user_id = $1 AND verification_status = 'pending'",
          [userId]
        );
        const pendingCropCount = Number(pendingCropRes.rows[0].pending_count);
        const pendingCropTokens = pendingCropCount * 5;

        const pendingTokens = pendingLedger + pendingCropTokens;

        return {
          success: true,
          balance,
          kes_equivalent_airtime: kesEquivalentAirtime,
          kes_equivalent_cash: kesEquivalentCash,
          pending_tokens: pendingTokens
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve balance." }
        });
      }
    }
  );

  // 2. GET /api/tokens/history - Retrieve user's transaction ledger history (paginated)
  fastify.get(
    "/history",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { page = "1", limit = "10" } = request.query as { page?: string; limit?: string };

      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
      const offset = (pageNum - 1) * limitNum;

      try {
        // Get total count
        const countRes = await query(
          "SELECT COUNT(*) AS total FROM token_ledger WHERE user_id = $1",
          [userId]
        );
        const total = parseInt(countRes.rows[0].total, 10) || 0;

        // Get paginated transactions
        const res = await query(
          `SELECT id, amount, balance_after, transaction_type, reference_id, notes, created_at 
           FROM token_ledger 
           WHERE user_id = $1 
           ORDER BY created_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limitNum, offset]
        );

        return {
          success: true,
          transactions: res.rows,
          total,
          page: pageNum,
          limit: limitNum
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve ledger history." }
        });
      }
    }
  );

  // 3. GET /api/tokens/rates - Retrieve redemption rates
  fastify.get(
    "/rates",
    async (request, reply) => {
      const rates = {
        airtime: 0.55,
        voucher: 0.55,
        circle: 0.50,
        mpesa: 0.50
      };

      return {
        success: true,
        airtime: rates.airtime,
        voucher: rates.voucher,
        circle: rates.circle,
        mpesa: rates.mpesa,
        rates
      };
    }
  );
}
