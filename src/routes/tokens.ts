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
import { airtimeService } from "../services/airtimeService";

interface RedeemAirtimeRouteBody {
  token_amount: number;
  phone_number: string;
}

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

  // 4. POST /api/tokens/redeem/airtime - Redeem Climate Tokens for Airtime
  fastify.post<{ Body: RedeemAirtimeRouteBody }>(
    "/redeem/airtime",
    {
      onRequest: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        },
      },
      attachValidation: true,
      schema: {
        body: {
          type: "object",
          required: ["token_amount", "phone_number"],
          properties: {
            token_amount: { type: "integer", minimum: 20 },
            phone_number: { 
              type: "string", 
              pattern: "^(\\+?254|0)[17][0-9]{8}$" 
            }
          }
        }
      }
    },
    async (request, reply) => {
      const userId = request.user.id;
      
      // Handle schema validation errors and map to specific code/messages
      if (request.validationError) {
        const validation = request.validationError.validation;
        if (validation && validation.length > 0) {
          const firstErr = validation[0];
          const path = firstErr.instancePath;
          const missingProp = firstErr.params?.missingProperty;
          
          if (path.includes("token_amount") || missingProp === "token_amount") {
            return reply.status(400).send({
              success: false,
              error: { code: "BELOW_MINIMUM_TOKENS", message: "Token amount must be at least 20." }
            });
          }
          if (path.includes("phone_number") || missingProp === "phone_number") {
            return reply.status(400).send({
              success: false,
              error: { code: "INVALID_PHONE_NUMBER", message: "Invalid Kenyan phone number format." }
            });
          }
        }
        return reply.status(400).send({
          success: false,
          error: { code: "VALIDATION_ERROR", message: request.validationError.message }
        });
      }

      const { token_amount, phone_number } = request.body;

      // Duplicate/Fallback manual validation just to be fully secure
      if (token_amount === undefined || token_amount < 20) {
        return reply.status(400).send({
          success: false,
          error: { code: "BELOW_MINIMUM_TOKENS", message: "Token amount must be at least 20." }
        });
      }

      const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
      if (!phone_number || !phoneRegex.test(phone_number)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_PHONE_NUMBER", message: "Invalid Kenyan phone number format." }
        });
      }

      try {
        const result = await airtimeService.initiateAirtimeRedemption(
          userId,
          token_amount,
          phone_number
        );
        return result;
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "BELOW_MINIMUM_TOKENS", message: "Token amount must be at least 20." }
          });
        }
        if (err.message === "INVALID_PHONE_NUMBER") {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_PHONE_NUMBER", message: "Invalid Kenyan phone number format." }
          });
        }
        if (err.message === "INSUFFICIENT_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_TOKENS", message: "Insufficient tokens for redemption." }
          });
        }
        if (err.message === "AIRTIME_SEND_FAILED") {
          return reply.status(502).send({
            success: false,
            error: { code: "AIRTIME_SEND_FAILED", message: "Airtime disbursement failed." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "An unexpected error occurred." }
        });
      }
    }
  );
}
