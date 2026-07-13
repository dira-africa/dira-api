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
import { voucherService } from "../services/voucherService";
import { env } from "../config/env";
import { createHash } from "crypto";

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
      if (!env.VOUCHERS_ACTIVE) {
        return reply.status(400).send({
          success: false,
          error: { code: "VOUCHER_NOT_YET_ACTIVE", message: "Agro-dealer vouchers are not yet active." }
        });
      }

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
      if (!env.VOUCHERS_ACTIVE) {
        return reply.status(400).send({
          success: false,
          error: { code: "VOUCHER_NOT_YET_ACTIVE", message: "Agro-dealer vouchers are not yet active." }
        });
      }

      const userId = request.user.id;
      const userRole = request.user.role;
      const { voucherCode, qrHash, agroDealerId } = request.body;

      const linkedDealerId = await getLinkedDealerId(userId);
      if (userRole !== "admin" && (!linkedDealerId || (agroDealerId && linkedDealerId !== agroDealerId))) {
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
        const dealerId = userRole === "admin" ? (agroDealerId || linkedDealerId) : linkedDealerId;
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

  // Helper to verify dealer API token (aligned with database schema)
  async function verifyDealerApiToken(request: any, reply: any) {
    const authHeader = request.headers.authorization || request.headers["x-api-key"] || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      token = authHeader;
    }

    if (!token) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "API key token is missing." }
      });
    }

    const keyHash = createHash("sha256").update(token).digest("hex");
    const res = await query(
      "SELECT id, permissions, is_active FROM api_clients WHERE key_hash = $1 AND is_active = TRUE",
      [keyHash]
    );

    if (res.rows.length === 0) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid or unauthorized API token." }
      });
    }

    const client = res.rows[0];
    const permissions = client.permissions || [];
    if (!permissions.includes("dealer") && !permissions.includes("admin")) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid or unauthorized API token." }
      });
    }

    request.apiClient = client;
  }

  // Helper to verify partner API key with scoping and database rate limiting
  async function verifyPartnerApiKey(request: any, reply: any) {
    const authHeader = request.headers.authorization || request.headers["x-api-key"] || "";
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    } else {
      token = authHeader;
    }

    if (!token) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "API key token is missing." }
      });
    }

    const keyHash = createHash("sha256").update(token).digest("hex");
    const res = await query(
      "SELECT id, client_name, permissions, rate_limit_per_hour, is_active FROM api_clients WHERE key_hash = $1 AND is_active = TRUE",
      [keyHash]
    );

    if (res.rows.length === 0) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Invalid or unauthorized API token." }
      });
    }

    const client = res.rows[0];
    const permissions = client.permissions || [];
    if (!permissions.includes("verify_provenance") && !permissions.includes("admin")) {
      return reply.status(403).send({
        success: false,
        error: { code: "FORBIDDEN", message: "Forbidden: Client lacks 'verify_provenance' scope." }
      });
    }

    // Rate Limiting Check
    const limit = client.rate_limit_per_hour || 1000;
    const usageRes = await query(
      "SELECT COUNT(*) AS count FROM api_usage_logs WHERE client_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'",
      [client.id]
    );
    const count = Number(usageRes.rows[0]?.count || 0);
    if (count >= limit) {
      return reply.status(429).send({
        success: false,
        error: { code: "RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded. Try again later." }
      });
    }

    request.apiClient = client;
  }

  interface ScanVoucherBody {
    qrPayload?: string;
    qr_payload?: string;
    agroDealerId?: string;
    agro_dealer_id?: string;
  }

  // 3. POST /api/partner/voucher/scan - Agro-dealer scans farmer's QR
  fastify.post<{ Body: ScanVoucherBody }>(
    "/voucher/scan",
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
      const qrPayload = request.body.qrPayload || request.body.qr_payload;
      const agroDealerId = request.body.agroDealerId || request.body.agro_dealer_id;

      if (!qrPayload) {
        if (request.body.qr_payload !== undefined) {
          return reply.status(400).send({ error: "INVALID_VOUCHER" });
        }
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "qrPayload is required." }
        });
      }

      const linkedDealerId = await getLinkedDealerId(userId);
      if (userRole !== "admin" && (!linkedDealerId || (agroDealerId && linkedDealerId !== agroDealerId))) {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "You do not have permission to scan vouchers." }
        });
      }

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
          farmer_id: result.farmerId,
          kesValue: result.kesValue,
          kes_value: result.kesValue,
          message: `Voucher valid — KES ${result.kesValue.toFixed(2)} credit to your account`
        };
      } catch (err: any) {
        const code = err.message || "REDEMPTION_FAILED";
        
        // If request used snake_case qr_payload (guide client), return guide-style JSON response directly
        if (request.body.qr_payload !== undefined) {
          const status = (code === "VOUCHER_ALREADY_REDEEMED" || code === "VOUCHER_EXPIRED" || code === "INVALID_SIGNATURE") ? 400 : 500;
          let guideErr = "INVALID_VOUCHER";
          if (code === "VOUCHER_EXPIRED") {
            guideErr = "VOUCHER_EXPIRED";
          }
          return reply.status(status).send({ error: guideErr });
        }

        const status = (code === "VOUCHER_ALREADY_REDEEMED" || code === "VOUCHER_EXPIRED" || code === "INVALID_SIGNATURE") ? 400 : 500;
        return reply.status(status).send({
          success: false,
          error: { code, message: err.message || "Failed to process voucher scan." }
        });
      }
    }
  );

  // 4. GET /api/partner/voucher/scan - Dealer gets scanned voucher logs (requires API Token Auth)
  fastify.get(
    "/voucher/scan",
    { preHandler: [verifyDealerApiToken] },
    async (request, reply) => {
      if (!env.VOUCHERS_ACTIVE) {
        return reply.status(400).send({
          success: false,
          error: { code: "VOUCHER_NOT_YET_ACTIVE", message: "Agro-dealer vouchers are not yet active." }
        });
      }
      const res = await query(
        `SELECT id, farmer_id, token_amount, kes_value, voucher_code, expires_at, scanned_at, status 
         FROM voucher_redemptions 
         WHERE status = 'redeemed' 
         ORDER BY scanned_at DESC`
      );
      return {
        success: true,
        vouchers: res.rows
      };
    }
  );

  interface VerifyQuery {
    hash?: string;
    topic?: string;
    seq?: string;
  }

  // 5. GET /api/partner/verify - Insurers verify provenance against Hedera attestations
  fastify.get<{ Querystring: VerifyQuery }>(
    "/verify",
    { preHandler: [verifyPartnerApiKey] },
    async (request, reply) => {
      const { hash, topic, seq } = request.query;
      const client = (request as any).apiClient;

      if (!hash && (!topic || !seq)) {
        const errCode = 400;
        await query(
          "INSERT INTO api_usage_logs (client_id, endpoint, response_code) VALUES ($1, $2, $3)",
          [client.id, "/api/partner/verify", errCode]
        );
        return reply.status(errCode).send({
          success: false,
          error: {
            code: "MISSING_PARAMETERS",
            message: "You must provide either a 'hash' query parameter or both 'topic' and 'seq' query parameters."
          }
        });
      }

      try {
        let res: any;
        if (hash) {
          res = await query(
            `SELECT consensus_timestamp, sequence_number, hcs_topic_id, network 
             FROM hedera_attestations 
             WHERE sha256 = $1`,
            [hash.toLowerCase().trim()]
          );
        } else {
          res = await query(
            `SELECT consensus_timestamp, sequence_number, hcs_topic_id, network 
             FROM hedera_attestations 
             WHERE hcs_topic_id = $1 AND sequence_number = $2`,
            [topic!.trim(), Number(seq)]
          );
        }

        if (res.rows.length === 0) {
          const errCode = 404;
          await query(
            "INSERT INTO api_usage_logs (client_id, endpoint, response_code) VALUES ($1, $2, $3)",
            [client.id, "/api/partner/verify", errCode]
          );
          await query(
            `INSERT INTO audit_log (action, entity_type, metadata)
             VALUES ($1, $2, $3)`,
            [
              "partner_verify_attestation_failed",
              "hedera_attestations",
              JSON.stringify({
                clientId: client.id,
                query: request.query
              })
            ]
          );
          return reply.status(errCode).send({
            success: false,
            error: {
              code: "NOT_FOUND",
              message: "Attestation record not found."
            }
          });
        }

        const attestation = res.rows[0];
        const network = attestation.network || env.HEDERA_NETWORK || "testnet";
        const hashscanBase = `https://hashscan.io/${network.toLowerCase()}`;

        const responsePayload = {
          success: true,
          verified: true,
          attestation: {
            consensusTimestamp: attestation.consensus_timestamp,
            sequenceNumber: Number(attestation.sequence_number),
            network: attestation.network,
            topicId: attestation.hcs_topic_id,
            hashscanLink: `${hashscanBase}/topic/${attestation.hcs_topic_id}`
          }
        };

        // Log to usage & audit tables
        await query(
          "INSERT INTO api_usage_logs (client_id, endpoint, response_code) VALUES ($1, $2, $3)",
          [client.id, "/api/partner/verify", 200]
        );
        await query(
          `INSERT INTO audit_log (action, entity_type, metadata)
           VALUES ($1, $2, $3)`,
          [
            "partner_verify_attestation_success",
            "hedera_attestations",
            JSON.stringify({
              clientId: client.id,
              query: request.query,
              attestationTopic: attestation.hcs_topic_id,
              sequenceNumber: attestation.sequence_number
            })
          ]
        );

        return responsePayload;
      } catch (err: any) {
        console.error("Partner verification error:", err);
        const errCode = 500;
        await query(
          "INSERT INTO api_usage_logs (client_id, endpoint, response_code) VALUES ($1, $2, $3)",
          [client.id, "/api/partner/verify", errCode]
        );
        return reply.status(errCode).send({
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: err.message || "An unexpected error occurred."
          }
        });
      }
    }
  );
}
