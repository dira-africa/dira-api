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
import { query } from "../db/query";
import { tokenService } from "../services/tokenService";
import { airtimeService } from "../services/airtimeService";
import { voucherService } from "../services/voucherService";
import { diraCircleService } from "../services/diraCircleService";
import { paymentService } from "../services/paymentService";
import { env } from "../config/env";
import { sanitizePhone } from "../lib/sanitize";

interface RedeemAirtimeRouteBody {
  token_amount: number;
  phone_number: string;
  redemption_id?: string;
}

interface RedeemVoucherRouteBody {
  token_amount: number;
  agro_dealer_id: string;
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
          groupId: "tokens-redeem",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        } as any,
      },
      schema: {
        body: {
          type: "object",
          required: ["token_amount", "phone_number"],
          properties: {
            token_amount: { type: "integer", minimum: 20 },
            phone_number: { 
              type: "string", 
              pattern: "^(\\+?254|0)[17][0-9]{8}$" 
            },
            redemption_id: {
              type: "string",
              format: "uuid"
            }
          }
        }
      }
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { token_amount, phone_number, redemption_id } = request.body;
      const sanitizedPhone = sanitizePhone(phone_number);

      // Duplicate/Fallback manual validation just to be fully secure
      if (token_amount === undefined || token_amount < 20) {
        return reply.status(400).send({
          success: false,
          error: { code: "BELOW_MINIMUM_TOKENS", message: "Token amount must be at least 20." }
        });
      }

      if (token_amount > 2000) {
        return reply.status(400).send({
          success: false,
          error: { code: "EXCEEDS_MAX_LIMIT", message: "Maximum airtime redemption limit is 2000 Climate Tokens per request." }
        });
      }

      const phoneRegex = /^(\+?254|0)[17][0-9]{8}$/;
      if (!sanitizedPhone || !phoneRegex.test(sanitizedPhone)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_PHONE_NUMBER", message: "Invalid Kenyan phone number format." }
        });
      }

      try {
        const result = await airtimeService.initiateAirtimeRedemption(
          userId,
          token_amount,
          sanitizedPhone,
          redemption_id
        );
        return result;
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "BELOW_MINIMUM_TOKENS", message: "Token amount must be at least 20." }
          });
        }
        if (err.message === "EXCEEDS_MAX_LIMIT") {
          return reply.status(400).send({
            success: false,
            error: { code: "EXCEEDS_MAX_LIMIT", message: "Maximum airtime redemption limit is 2000 Climate Tokens per request." }
          });
        }
        if (err.message === "TRANSACTION_FAILED") {
          return reply.status(400).send({
            success: false,
            error: { code: "TRANSACTION_FAILED", message: "This redemption transaction previously failed." }
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

  // 5. POST /api/tokens/redeem/voucher - Redeem Climate Tokens for Farm Input Voucher
  fastify.post<{ Body: RedeemVoucherRouteBody }>(
    "/redeem/voucher",
    {
      onRequest: [fastify.authenticate, fastify.requireRole(["farmer"])],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          groupId: "tokens-redeem",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        } as any,
      },
      schema: {
        body: {
          type: "object",
          required: ["token_amount", "agro_dealer_id"],
          properties: {
            token_amount: { type: "integer", minimum: 50 },
            agro_dealer_id: { type: "string", format: "uuid" }
          }
        }
      }
    },
    async (request, reply) => {
      const userId = request.user.id;
      const { token_amount, agro_dealer_id } = request.body;

      if (!env.VOUCHERS_ACTIVE) {
        return reply.status(400).send({
          success: false,
          error: { code: "VOUCHER_NOT_YET_ACTIVE", message: "Agro-dealer vouchers are not yet active." }
        });
      }

      // Manual validations for precise error codes
      if (token_amount === undefined || token_amount < 50) {
        return reply.status(400).send({
          success: false,
          error: { code: "BELOW_MINIMUM_TOKENS", message: "Minimum redemption is 50 Climate Tokens." }
        });
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!agro_dealer_id || !uuidRegex.test(agro_dealer_id)) {
        return reply.status(400).send({
          success: false,
          error: { code: "DEALER_NOT_FOUND", message: "Active agro-dealer not found." }
        });
      }

      try {
        const result = await voucherService.generateVoucher(
          userId,
          token_amount,
          agro_dealer_id
        );

        // Save general redemption request as completed (matching schema)
        await query(
          `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
           VALUES ($1, $2, 'voucher', $3, pgp_sym_encrypt('Voucher Code: ' || $4, $5), 'completed', CURRENT_TIMESTAMP)`,
          [userId, token_amount, result.kesValue, result.voucherCode, env.PGCRYPTO_SYMMETRIC_KEY]
        );

        return {
          success: true,
          qrDataUrl: result.qrDataUrl,
          voucherCode: result.voucherCode,
          kesValue: result.kesValue,
          expiresAt: result.expiresAt
        };
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "BELOW_MINIMUM_TOKENS", message: "Minimum redemption is 50 Climate Tokens." }
          });
        }
        if (err.message === "DEALER_NOT_FOUND") {
          return reply.status(400).send({
            success: false,
            error: { code: "DEALER_NOT_FOUND", message: "Active agro-dealer not found." }
          });
        }
        if (err.message === "INSUFFICIENT_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_TOKENS", message: "Insufficient tokens for redemption." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "An unexpected error occurred." }
        });
      }
    }
  );

  // 6. GET /api/tokens/redeem/voucher/dealers - Retrieve active agro-dealers with categories
  fastify.get(
    "/redeem/voucher/dealers",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      try {
        const res = await query(
          `SELECT ad.id, ad.dealer_name, ad.county_id, ad.dealer_logo_url, 
                  COALESCE(array_agg(dpc.category_name) FILTER (WHERE dpc.is_active = TRUE), '{}') AS categories
           FROM agro_dealers ad
           LEFT JOIN dealer_product_categories dpc ON ad.id = dpc.dealer_id
           WHERE ad.active = TRUE
           GROUP BY ad.id, ad.dealer_name, ad.county_id, ad.dealer_logo_url
           ORDER BY ad.dealer_name ASC`
        );
        return {
          success: true,
          dealers: res.rows.map(row => ({
            id: row.id,
            name: row.dealer_name,
            county: row.county_id,
            logoUrl: row.dealer_logo_url,
            categories: row.categories
          }))
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to fetch agro-dealers." }
        });
      }
    }
  );

  // 7. POST /api/tokens/redeem/circle - Redeem Climate Tokens for Dira Circle Cash Pool
  fastify.post<{ Body: { token_amount?: number; tokenAmount?: number } }>(
    "/redeem/circle",
    {
      onRequest: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          groupId: "tokens-redeem",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        } as any,
      },
    },
    async (request, reply) => {
      if (!env.DIRA_CIRCLE_ACTIVE) {
        return reply.status(503).send({
          success: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "Dira Circle redemption is currently disabled in this environment." }
        });
      }

      const userId = request.user.id;
      const tokenAmount = request.body.token_amount ?? request.body.tokenAmount;

      if (tokenAmount === undefined) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount is required." }
        });
      }

      try {
        const result = await diraCircleService.registerCircleRedemption(userId, tokenAmount);
        return result;
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "BELOW_MINIMUM_TOKENS", message: "Minimum redemption is 100 Climate Tokens." }
          });
        }
        if (err.message === "NO_ACTIVE_COORDINATOR") {
          return reply.status(400).send({
            success: false,
            error: { code: "NO_ACTIVE_COORDINATOR", message: "No active Dira Circle coordinator appointed for your county." }
          });
        }
        if (err.message === "INSUFFICIENT_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_TOKENS", message: "Insufficient tokens for redemption." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "An unexpected error occurred." }
        });
      }
    }
  );

  // 8. GET /api/tokens/redeem/circle/status - Retrieve circle redemption status & coordinator info
  fastify.get(
    "/redeem/circle/status",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;

      try {
        const userRes = await query("SELECT county FROM users WHERE id = $1", [userId]);
        const county = userRes.rows[0]?.county;

        let coordinator = null;
        if (county) {
          const countyRes = await query("SELECT id FROM counties WHERE name = $1", [county]);
          const countyUuid = countyRes.rows[0]?.id;
          if (countyUuid) {
            const coordRes = await query(
              `SELECT u.full_name AS name, cc.mpesa_number AS phone
               FROM circle_coordinators cc
               JOIN data_agents da ON cc.agent_id = da.id
               JOIN users u ON da.user_id = u.id
               WHERE cc.county_id = $1 AND cc.active = TRUE`,
              [countyUuid]
            );
            if (coordRes.rows.length > 0) {
              coordinator = {
                name: coordRes.rows[0].name,
                mpesaNumber: coordRes.rows[0].phone
              };
            }
          }
        }

        const requestRes = await query(
          `SELECT status, amount_kes::float AS amount_kes, tokens_spent, initiated_at, completed_at, mpesa_receipt
           FROM redemption_requests
           WHERE user_id = $1 AND redemption_type = 'circle'
           ORDER BY initiated_at DESC LIMIT 1`,
          [userId]
        );

        const lastRequest = requestRes.rows.length > 0 ? {
          status: requestRes.rows[0].status,
          amountKes: requestRes.rows[0].amount_kes,
          tokensSpent: requestRes.rows[0].tokens_spent,
          initiatedAt: requestRes.rows[0].initiated_at,
          completedAt: requestRes.rows[0].completed_at,
          mpesaReceipt: requestRes.rows[0].mpesa_receipt
        } : null;

        return {
          success: true,
          county,
          coordinator,
          lastRequest
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve circle status." }
        });
      }
    }
  );

  // 9. POST /api/tokens/redeem/mpesa - Redeem Climate Tokens for Mobile Money Cashout (Pretium pending)
  fastify.post<{ Body: { tokenAmount?: number; token_amount?: number; phoneNumber?: string; phone_number?: string } }>(
    "/redeem/mpesa",
    {
      onRequest: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 hour",
          groupId: "tokens-redeem",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        } as any,
      },
    },
    async (request, reply) => {
      const isPretiumActive = false;
      if (!isPretiumActive) {
        return reply.status(503).send({
          error: {
            code: "MPESA_NOT_YET_ACTIVE",
            message: "Mobile money payouts are coming soon. Use airtime redemption now."
          }
        });
      }

      const userId = request.user.id;
      const tokenAmount = request.body.tokenAmount ?? request.body.token_amount;
      const phoneNumber = request.body.phoneNumber ?? request.body.phone_number;

      if (tokenAmount === undefined || !phoneNumber) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and phoneNumber are required." }
        });
      }

      try {
        const result = await paymentService.initiateMpesaB2C(userId, tokenAmount, phoneNumber);
        return result;
      } catch (err: any) {
        if (err.message === "MPESA_NOT_YET_ACTIVE") {
          return reply.status(503).send({
            success: false,
            error: { code: "MPESA_NOT_YET_ACTIVE", message: "M-Pesa payouts are coming soon. Use airtime redemption now." }
          });
        }
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "BELOW_MINIMUM_TOKENS", message: "Minimum redemption is 100 Climate Tokens." }
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
        if (err.message === "API_DISBURSEMENT_FAILED") {
          return reply.status(502).send({
            success: false,
            error: { code: "API_DISBURSEMENT_FAILED", message: "M-Pesa B2C Payment request failed." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "An unexpected error occurred." }
        });
      }
    }
  );

  // 10. GET /api/tokens/redeem/mpesa/status - Retrieve user profile phone & last M-Pesa cashout status
  fastify.get(
    "/redeem/mpesa/status",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const userRes = await query(
          `SELECT pgp_sym_decrypt(phone_number::bytea, $1) AS phone 
           FROM users WHERE id = $2`,
          [env.PGCRYPTO_SYMMETRIC_KEY, userId]
        );
        const phone = userRes.rows[0]?.phone || "";
        
        const requestRes = await query(
          `SELECT id, status, amount_kes::float AS amount_kes, tokens_spent, initiated_at, completed_at, mpesa_receipt, failure_reason
           FROM redemption_requests
           WHERE user_id = $1 AND redemption_type = 'mpesa'
           ORDER BY initiated_at DESC LIMIT 1`,
          [userId]
        );

        const lastRequest = requestRes.rows.length > 0 ? {
          id: requestRes.rows[0].id,
          status: requestRes.rows[0].status,
          amountKes: requestRes.rows[0].amount_kes,
          tokensSpent: requestRes.rows[0].tokens_spent,
          initiatedAt: requestRes.rows[0].initiated_at,
          completedAt: requestRes.rows[0].completed_at,
          mpesaReceipt: requestRes.rows[0].mpesa_receipt,
          failureReason: requestRes.rows[0].failure_reason
        } : null;

        return {
          success: true,
          phone,
          lastRequest
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve status." }
        });
      }
    }
  );
}
