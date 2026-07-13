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
import { voucherService } from "../../services/voucherService";
import { env } from "../../config/env";

interface RedeemVoucherBody {
  tokenAmount: number;
  agroDealerId: string;
}

export default async function vouchersRoutes(fastify: FastifyInstance) {
  
  // POST /api/payments/vouchers/redeem
  fastify.post<{ Body: RedeemVoucherBody }>(
    "/redeem",
    { onRequest: [fastify.authenticate, fastify.requireRole(["farmer"])] },
    async (request, reply) => {
      const userId = request.user.id;
      const { tokenAmount, agroDealerId } = request.body;

      // 1. Validation
      if (tokenAmount === undefined || !agroDealerId) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and agroDealerId are required." }
        });
      }

      if (tokenAmount < 50) {
        return reply.status(400).send({
          success: false,
          error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 50 Climate Tokens for input vouchers." }
        });
      }

      try {
        const voucherRes = await voucherService.generateVoucher(userId, tokenAmount, agroDealerId);

        // 4. Save general redemption request as completed
        await query(
          `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
           VALUES ($1, $2, 'voucher', $3, pgp_sym_encrypt('Voucher Code: ' || $4, 'SuperSecureDiraSecretPassphrase'), 'completed', CURRENT_TIMESTAMP)`,
          [userId, tokenAmount, voucherRes.kesValue, voucherRes.voucherCode]
        );

        return {
          success: true,
          code: voucherRes.voucherCode,
          expiresAt: voucherRes.expiresAt,
          qrHash: voucherRes.qrHash,
          kesValue: voucherRes.kesValue
        };
      } catch (err: any) {
        if (err.message === "BELOW_MINIMUM_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "MINIMUM_REDEMPTION", message: "Minimum redemption is 50 Climate Tokens for input vouchers." }
          });
        }
        if (err.message === "DEALER_NOT_FOUND") {
          return reply.status(400).send({
            success: false,
            error: { code: "DEALER_NOT_FOUND", message: "Agro-dealer is not active or does not exist." }
          });
        }
        if (err.message === "INSUFFICIENT_TOKENS") {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient token balance." }
          });
        }
        console.error("Voucher redemption route error:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to issue farm input voucher." }
        });
      }
    }
  );

  interface ScanVoucherBody {
    qrPayload: string;
    agroDealerId?: string;
  }

  // POST /api/payments/vouchers/scan - Dealer scans farmer's QR
  fastify.post<{ Body: ScanVoucherBody }>(
    "/scan",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      if (!env.VOUCHERS_ACTIVE) {
        return reply.status(400).send({
          success: false,
          error: { code: "VOUCHER_NOT_YET_ACTIVE", message: "Agro-dealer vouchers are not yet active." }
        });
      }

      const userId = request.user.id;
      const userRole = request.user.role;
      const { qrPayload, agroDealerId } = request.body;

      if (!qrPayload) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "qrPayload is required." }
        });
      }

      // Check for dealer link
      const res = await query(
        `SELECT id FROM agro_dealers
         WHERE active = TRUE
           AND dealer_phone = (SELECT pgp_sym_decrypt(phone_number::bytea, $1) FROM users WHERE id = $2)`,
        [env.PGCRYPTO_SYMMETRIC_KEY, userId]
      );
      const linkedDealerId = res.rows[0]?.id || null;

      const dealerId = userRole === "admin" ? (agroDealerId || linkedDealerId) : linkedDealerId;
      if (!dealerId) {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not have permission to scan vouchers." }
        });
      }

      try {
        const result = await voucherService.scanVoucher(qrPayload, dealerId);
        return {
          success: true,
          farmerId: result.farmerId,
          kesValue: result.kesValue,
          message: `Voucher valid — KES ${result.kesValue.toFixed(2)} credit to your account`
        };
      } catch (err: any) {
        const code = err.message || "REDEMPTION_FAILED";
        const status = (code === "VOUCHER_ALREADY_REDEEMED" || code === "VOUCHER_EXPIRED" || code === "INVALID_SIGNATURE") ? 400 : 500;
        return reply.status(status).send({
          success: false,
          error: { code, message: err.message || "Failed to process voucher scan." }
        });
      }
    }
  );
}
