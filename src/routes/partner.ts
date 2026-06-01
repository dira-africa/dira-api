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
import { voucherService } from "../services/voucherService";
import { env } from "../config/env";

interface ValidateVoucherBody {
  voucherCode: string;
  qrHash: string;
}

interface RedeemVoucherBody {
  voucherCode: string;
  qrHash: string;
  agroDealerId?: string;
}

export default async function partnerRoutes(fastify: FastifyInstance) {
  
  // Helper: Retrieve agro-dealer linked to user's phone number
  async function getLinkedDealerId(userId: string): Promise<string | null> {
    const res = await query(
      `SELECT id FROM agro_dealers
       WHERE active = TRUE
         AND dealer_phone = (SELECT pgp_sym_decrypt(phone_number::bytea, $1) FROM users WHERE id = $2)`,
      [env.PGCRYPTO_SYMMETRIC_KEY, userId]
    );
    return res.rows[0]?.id || null;
  }

  fastify.post<{ Body: ValidateVoucherBody }>(
    "/vouchers/validate",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const userRole = request.user.role;
      const { voucherCode, qrHash } = request.body;

      // Auth check: must be admin or a linked active dealer
      const linkedDealerId = await getLinkedDealerId(userId);
      if (!linkedDealerId && userRole !== "admin") {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not have permission to access this resource." }
        });
      }

      if (!voucherCode || !qrHash) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "voucherCode and qrHash are required." }
        });
      }

      try {
        const valResult = await voucherService.validateVoucher(voucherCode, qrHash);

        if (!valResult.valid) {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_VOUCHER", message: valResult.errorReason || "Voucher validation failed." }
          });
        }

        return {
          success: true,
          valid: true,
          voucher: valResult.voucher
        };
      } catch (err: any) {
        console.error("Partner voucher validation error:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to validate voucher." }
        });
      }
    }
  );

  fastify.post<{ Body: RedeemVoucherBody }>(
    "/vouchers/redeem",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const userRole = request.user.role;
      const { voucherCode, qrHash, agroDealerId } = request.body;

      // Determine the scanning agro-dealer ID
      let dealerId = agroDealerId || null;
      if (!dealerId) {
        dealerId = await getLinkedDealerId(userId);
      }

      // Auth check: must be admin or a linked active dealer
      if (!dealerId && userRole !== "admin") {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not have permission to access this resource." }
        });
      }

      if (!voucherCode || !qrHash) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "voucherCode and qrHash are required." }
        });
      }

      try {
        // Determine the scanning agro-dealer ID
        let dealerId = agroDealerId || null;
        if (!dealerId) {
          dealerId = await getLinkedDealerId(userId);
        }

        if (!dealerId) {
          return reply.status(403).send({
            success: false,
            error: {
              code: "UNLINKED_DEALER",
              message: "Your partner account is not linked to any active agro-dealer business. Please specify agroDealerId."
            }
          });
        }

        const redResult = await voucherService.redeemVoucher(voucherCode, qrHash, dealerId);

        if (!redResult.success) {
          return reply.status(400).send({
            success: false,
            error: { code: "REDEMPTION_FAILED", message: redResult.errorReason || "Failed to redeem voucher." }
          });
        }

        return {
          success: true,
          message: "Voucher scanned and redeemed successfully."
        };
      } catch (err: any) {
        console.error("Partner voucher redemption error:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process voucher redemption." }
        });
      }
    }
  );
}
