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
import rateLimit from "@fastify/rate-limit";
import "../plugins/jobs";
import { query } from "../db/query";
import { pool } from "../db/pool";
import { xionService } from "../services/xionService";
import { diraCircleService } from "../services/diraCircleService";
import { paymentService } from "../services/paymentService";
import { env } from "../config/env";
import { tokenService } from "../services/tokenService";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  xionAnchorQueue
} from "../jobs/queues";

interface CertificateBody {
  countyCode: string;
  periodStart: string; // ISO Date string
  periodEnd: string; // ISO Date string
  conditionType: string;
  confidenceThreshold: number;
}

export default async function adminRoutes(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: 30,
    timeWindow: "1 minute",
    groupId: "admin-group",
    keyGenerator: (request: any) => request.ip,
  } as any);

  // 1. Enforce admin auth hook on all routes inside this plugin
  fastify.addHook("onRequest", fastify.authenticateAdmin);

  // 2. Automate audit logging for successful requests
  fastify.addHook("onResponse", async (request, reply) => {
    if (request.adminUser && request.adminAction) {
      try {
        await query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            request.adminUser.id,
            request.adminAction,
            request.adminEntityType || "system",
            request.adminEntityId || null,
            request.ip,
            request.headers["user-agent"] || null,
            request.adminMetadata ? JSON.stringify(request.adminMetadata) : null
          ]
        );
      } catch (err) {
        request.log.error(err, "Failed to write admin audit log:");
      }
    }
  });

  // 1. GET /api/admin/stats - Retrieve dashboard stats
  fastify.get(
    "/stats",
    async (request, reply) => {
      request.adminAction = "view_stats";
      try {
        const farmersRes = await query("SELECT COUNT(*) AS count FROM users WHERE role = 'farmer'");
        const agentsRes = await query("SELECT COUNT(*) AS count FROM users WHERE role = 'agent'");
        const anchorsRes = await query("SELECT COUNT(*) AS count FROM zkverify_anchors");
        
        return {
          success: true,
          farmersCount: Number(farmersRes.rows[0].count),
          agentsCount: Number(agentsRes.rows[0].count),
          activeAnchors: Number(anchorsRes.rows[0].count)
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve stats." }
        });
      }
    }
  );

  // 2. POST /api/admin/xion-zkverify/anchor - Trigger catchup anchoring for completed weeks
  fastify.post(
    "/xion-zkverify/anchor",
    async (request, reply) => {
      request.adminAction = "xion_anchor";
      try {
        const result = await xionService.anchorAllCompletedWeeks();
        return result;
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to trigger anchoring." }
        });
      }
    }
  );

  // 3. POST /api/admin/xion-zkverify/certificate - Issue certificate
  fastify.post<{ Body: CertificateBody }>(
    "/xion-zkverify/certificate",
    async (request, reply) => {
      request.adminAction = "issue_certificate";
      const { countyCode, periodStart, periodEnd, conditionType, confidenceThreshold } = request.body;

      if (!countyCode || !periodStart || !periodEnd || !conditionType || confidenceThreshold === undefined) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "All certificate fields are required." }
        });
      }

      try {
        const result = await xionService.issueCertificate(
          countyCode,
          new Date(periodStart),
          new Date(periodEnd),
          conditionType,
          confidenceThreshold
        );

        if (result.success && result.certId) {
          // Retrieve UUID of generated certificate
          const certQuery = await query("SELECT id FROM zkverify_certificates WHERE cert_id = $1", [result.certId]);
          if (certQuery.rows.length > 0) {
            request.adminEntityId = certQuery.rows[0].id;
          }
          request.adminEntityType = "zkverify_certificates";
        }

        return result;
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to issue certificate." }
        });
      }
    }
  );

  // 4. GET /api/admin/xion-zkverify/status - Retrieve XION blockchain registry status
  fastify.get(
    "/xion-zkverify/status",
    async (request, reply) => {
      request.adminAction = "view_xion_status";
      try {
        const anchorsRes = await query("SELECT * FROM zkverify_anchors ORDER BY week_number DESC LIMIT 50");
        const certificatesRes = await query("SELECT * FROM zkverify_certificates ORDER BY created_at DESC LIMIT 50");

        return {
          success: true,
          anchors: anchorsRes.rows,
          certificates: certificatesRes.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve XION registry status." }
        });
      }
    }
  );

  // 5. GET /api/admin/jobs - Retrieve BullMQ jobs statistics and queues details
  fastify.get(
    "/jobs",
    async (request, reply) => {
      request.adminAction = "view_jobs";
      const getQueueStats = async (queue: any, name: string) => {
        const [active, waiting, delayed, completed, failed] = await Promise.all([
          queue.getActiveCount(),
          queue.getWaitingCount(),
          queue.getDelayedCount(),
          queue.getCompletedCount(),
          queue.getFailedCount()
        ]);

        const failedList = await queue.getFailed(0, 10);
        const failedJobs = failedList.map((job: any) => ({
          id: job.id,
          name: job.name,
          data: job.data,
          failedReason: job.failedReason,
          finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          attemptsMade: job.attemptsMade
        }));

        const completedJobs = await queue.getCompleted(0, 100);
        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;
        const completedInLastMinute = completedJobs.filter(
          (j: any) => j.finishedOn && j.finishedOn > oneMinuteAgo
        ).length;
        const processingRate = `${completedInLastMinute} jobs/min`;

        return {
          queueName: name,
          sizes: {
            active,
            waiting,
            delayed,
            completed,
            failed,
            total: active + waiting + delayed + completed + failed
          },
          failedJobs,
          processingRate
        };
      };

      try {
        const stats = await Promise.all([
          getQueueStats(photoVerificationQueue, "photo-verification"),
          getQueueStats(atmosphericVerificationQueue, "atmospheric-verification"),
          getQueueStats(notificationsQueue, "notifications"),
          getQueueStats(xionAnchorQueue, "xion-anchor")
        ]);

        return {
          success: true,
          queues: stats
        };
      } catch (err: any) {
        fastify.log.error("Failed to retrieve queue stats:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve job statistics." }
        });
      }
    }
  );

  // 6. POST /api/admin/circle/coordinators - Appoint county coordinator
  fastify.post<{ Body: { agentId?: string; agent_id?: string; countyId?: string; county_id?: string; mpesaNumber?: string; mpesa_number?: string } }>(
    "/circle/coordinators",
    async (request, reply) => {
      request.adminAction = "appoint_coordinator";
      const agentId = request.body.agentId ?? request.body.agent_id;
      const countyId = request.body.countyId ?? request.body.county_id;
      const mpesaNumber = request.body.mpesaNumber ?? request.body.mpesa_number;

      if (!agentId || !countyId || !mpesaNumber) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "agentId, countyId, and mpesaNumber are required." }
        });
      }

      try {
        const userRes = await query("SELECT role FROM users WHERE id = $1", [agentId]);
        if (userRes.rows.length === 0) {
          return reply.status(400).send({
            success: false,
            error: { code: "USER_NOT_FOUND", message: "Specified agent user does not exist." }
          });
        }

        let dataAgentId;
        const agentRes = await query("SELECT id FROM data_agents WHERE user_id = $1", [agentId]);
        if (agentRes.rows.length > 0) {
          dataAgentId = agentRes.rows[0].id;
        } else {
          const insertAgentRes = await query(
            "INSERT INTO data_agents (user_id) VALUES ($1) RETURNING id",
            [agentId]
          );
          dataAgentId = insertAgentRes.rows[0].id;
        }

        // Resolve county name to county UUID
        const countyRes = await query(
          "INSERT INTO counties (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
          [countyId]
        );
        const countyUuid = countyRes.rows[0].id;

        await query(
          `INSERT INTO circle_coordinators (agent_id, county_id, mpesa_number, active_from, active, selected_by_community)
           VALUES ($1, $2, $3, NOW(), TRUE, TRUE)
           ON CONFLICT (county_id) DO UPDATE 
           SET agent_id = EXCLUDED.agent_id, 
               mpesa_number = EXCLUDED.mpesa_number, 
               active = TRUE`,
          [dataAgentId, countyUuid, mpesaNumber]
        );

        request.adminEntityType = "circle_coordinators";
        request.adminEntityId = agentId;

        return {
          success: true,
          message: `Successfully appointed coordinator for county: ${countyId}`
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to appoint coordinator." }
        });
      }
    }
  );

  // 7. GET /api/admin/circle/distributions - List pending and completed distributions
  fastify.get(
    "/circle/distributions",
    async (request, reply) => {
      request.adminAction = "view_distributions";
      try {
        const res = await query(
          `SELECT d.*, 
                  d.total_users_requesting AS total_users, 
                  d.total_tokens_redeemed AS total_tokens, 
                  u.full_name AS coordinator_name
           FROM dira_circle_distributions d
           JOIN circle_coordinators c ON d.coordinator_id = c.id
           JOIN data_agents da ON c.agent_id = da.id
           JOIN users u ON da.user_id = u.id
           ORDER BY d.period_month DESC`
        );
        return {
          success: true,
          distributions: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve distributions." }
        });
      }
    }
  );

  // 8. PATCH /api/admin/circle/distributions/:id/confirm - Mark distribution as paid
  fastify.patch<{ Params: { id: string }; Body: { transferReference: string } }>(
    "/circle/distributions/:id/confirm",
    async (request, reply) => {
      request.adminAction = "confirm_distribution";
      const { id } = request.params;
      const { transferReference } = request.body;

      if (!transferReference) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "transferReference is required." }
        });
      }

      try {
        await diraCircleService.confirmDistribution(id, transferReference);

        request.adminEntityType = "dira_circle_distributions";
        request.adminEntityId = id;

        return {
          success: true,
          message: "Distribution confirmed and paid successfully."
        };
      } catch (err: any) {
        if (err.message === "DISTRIBUTION_NOT_FOUND") {
          return reply.status(404).send({
            success: false,
            error: { code: "NOT_FOUND", message: "Dira Circle distribution not found." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to confirm distribution." }
        });
      }
    }
  );

  // 9. GET /api/admin/users - List users with paginated search and filters
  fastify.get(
    "/users",
    async (request, reply) => {
      request.adminAction = "view_users";
      const {
        page = "1",
        limit = "50",
        search,
        county,
        role,
        active,
        startDate,
        endDate
      } = request.query as any;

      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 50;
      const offset = (pageNum - 1) * limitNum;

      const searchPattern = search ? `%${search}%` : null;
      const isActive = active === "true" ? true : active === "false" ? false : null;
      const roleFilter = role || null;
      const countyFilter = county || null;
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      try {
        const res = await query(
          `SELECT 
             u.id, u.full_name, u.telegram_username, u.telegram_id, u.role, u.language, u.county, u.is_verified, u.is_active, u.created_at, u.last_seen_at, u.email, u.suspension_reason, u.suspended_at,
             (SELECT COALESCE(SUM(amount), 0) FROM token_ledger WHERE user_id = u.id) AS token_balance,
             (SELECT COUNT(*) FROM crop_submissions WHERE user_id = u.id) AS submission_count,
             (SELECT COUNT(*) FROM atmospheric_readings WHERE user_id = u.id) AS sync_count
           FROM users u
           WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.telegram_username ILIKE $1 OR u.email ILIKE $1)
             AND ($2::text IS NULL OR u.county = $2)
             AND ($3::text IS NULL OR u.role::text = $3)
             AND ($4::boolean IS NULL OR u.is_active = $4)
             AND ($5::timestamptz IS NULL OR u.created_at >= $5)
             AND ($6::timestamptz IS NULL OR u.created_at <= $6)
           ORDER BY u.created_at DESC
           LIMIT $7 OFFSET $8`,
          [searchPattern, countyFilter, roleFilter, isActive, start, end, limitNum, offset]
        );

        const countRes = await query(
          `SELECT COUNT(*) AS total
           FROM users u
           WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.telegram_username ILIKE $1 OR u.email ILIKE $1)
             AND ($2::text IS NULL OR u.county = $2)
             AND ($3::text IS NULL OR u.role::text = $3)
             AND ($4::boolean IS NULL OR u.is_active = $4)
             AND ($5::timestamptz IS NULL OR u.created_at >= $5)
             AND ($6::timestamptz IS NULL OR u.created_at <= $6)`,
          [searchPattern, countyFilter, roleFilter, isActive, start, end]
        );

        return {
          success: true,
          users: res.rows,
          total: Number(countRes.rows[0].total),
          page: pageNum,
          limit: limitNum
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve users." }
        });
      }
    }
  );

  // 10. GET /api/admin/users/:id - Get detailed user profile metrics
  fastify.get(
    "/users/:id",
    async (request, reply) => {
      const { id } = request.params as any;
      request.adminAction = "view_user_details";
      request.adminEntityType = "users";
      request.adminEntityId = id;

      try {
        const userRes = await query(
          `SELECT id, telegram_id, telegram_username, 
                  CASE WHEN phone_number IS NOT NULL THEN pgp_sym_decrypt(phone_number::bytea, $1) ELSE NULL END AS phone_number,
                  full_name, role, language, county, is_verified, is_active, created_at, updated_at, last_seen_at, email, suspension_reason, suspended_at
           FROM users WHERE id = $2`,
          [env.PGCRYPTO_SYMMETRIC_KEY, id]
        );

        if (userRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "USER_NOT_FOUND", message: "User not found." }
          });
        }

        const user = userRes.rows[0];

        const balanceRes = await query(
          "SELECT COALESCE(SUM(amount), 0) AS balance FROM token_ledger WHERE user_id = $1",
          [id]
        );
        const tokenBalance = Number(balanceRes.rows[0].balance);

        const subCountRes = await query("SELECT COUNT(*) AS count FROM crop_submissions WHERE user_id = $1", [id]);
        const syncCountRes = await query("SELECT COUNT(*) AS count FROM atmospheric_readings WHERE user_id = $1", [id]);

        const ledgerRes = await query(
          "SELECT id, amount, balance_after, transaction_type, reference_id, notes, created_at FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
          [id]
        );

        const subsRes = await query(
          "SELECT id, crop_type, growth_stage, verification_status, submitted_at, ai_health_score FROM crop_submissions WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 20",
          [id]
        );

        const redemptionsRes = await query(
          "SELECT id, tokens_spent, redemption_type, amount_kes, status, initiated_at, mpesa_receipt FROM redemption_requests WHERE user_id = $1 ORDER BY initiated_at DESC LIMIT 20",
          [id]
        );

        const auditRes = await query(
          "SELECT id, action, entity_type, ip_address, created_at, metadata FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
          [id]
        );

        return {
          success: true,
          user: {
            ...user,
            token_balance: tokenBalance,
            submission_count: Number(subCountRes.rows[0].count),
            sync_count: Number(syncCountRes.rows[0].count)
          },
          history: {
            ledger: ledgerRes.rows,
            submissions: subsRes.rows,
            redemptions: redemptionsRes.rows,
            audit: auditRes.rows
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve user details." }
        });
      }
    }
  );

  // 11. PATCH /api/admin/users/:id - Actions: verify, suspend, adjust balance
  fastify.patch<{ Params: { id: string }; Body: { action: string; reason?: string; amount?: number; notes?: string } }>(
    "/users/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { action, reason, amount, notes } = request.body;

      request.adminEntityType = "users";
      request.adminEntityId = id;

      try {
        const userCheck = await query("SELECT id FROM users WHERE id = $1", [id]);
        if (userCheck.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "USER_NOT_FOUND", message: "User not found." }
          });
        }

        if (action === "verify") {
          request.adminAction = "verify_user";
          await query("UPDATE users SET is_verified = TRUE WHERE id = $1", [id]);
          return { success: true, message: "User verified successfully." };
        } 
        
        if (action === "suspend") {
          request.adminAction = "suspend_user";
          if (!reason || reason.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_REASON", message: "Suspension reason is mandatory and cannot be empty." }
            });
          }
          await query("UPDATE users SET is_active = FALSE, suspension_reason = $1, suspended_at = CURRENT_TIMESTAMP WHERE id = $2", [reason.trim(), id]);
          return { success: true, message: "User suspended successfully." };
        } 
        
        if (action === "unsuspend") {
          request.adminAction = "unsuspend_user";
          await query("UPDATE users SET is_active = TRUE, suspension_reason = NULL, suspended_at = NULL WHERE id = $1", [id]);
          return { success: true, message: "User unsuspended successfully." };
        } 
        
        if (action === "adjust_balance") {
          request.adminAction = "adjust_user_balance";
          if (amount === undefined || isNaN(Number(amount)) || Number(amount) === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "INVALID_AMOUNT", message: "Adjustment amount must be a non-zero number." }
            });
          }
          if (!notes || notes.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_NOTES", message: "Adjustment notes/reason must be provided." }
            });
          }

          await tokenService.awardTokens(id, Number(amount), notes.trim(), "adjustment");
          
          return { 
            success: true, 
            message: `Successfully adjusted token balance by ${amount} tokens. Notes: ${notes}` 
          };
        }

        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_ACTION", message: "Invalid action specified." }
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to perform user action." }
        });
      }
    }
  );

  // 12. GET /api/admin/users/export - Export selected users to CSV
  fastify.get(
    "/users/export",
    async (request, reply) => {
      request.adminAction = "export_users_csv";
      const { search, county, role, active, startDate, endDate } = request.query as any;

      const searchPattern = search ? `%${search}%` : null;
      const isActive = active === "true" ? true : active === "false" ? false : null;
      const roleFilter = role || null;
      const countyFilter = county || null;
      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      try {
        const res = await query(
          `SELECT 
             u.id, u.full_name, u.telegram_username, u.telegram_id, u.role, u.county, u.is_verified, u.is_active, u.created_at, u.last_seen_at, u.email,
             (SELECT COALESCE(SUM(amount), 0) FROM token_ledger WHERE user_id = u.id) AS token_balance,
             (SELECT COUNT(*) FROM crop_submissions WHERE user_id = u.id) AS submission_count,
             (SELECT COUNT(*) FROM atmospheric_readings WHERE user_id = u.id) AS sync_count
           FROM users u
           WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.telegram_username ILIKE $1 OR u.email ILIKE $1)
             AND ($2::text IS NULL OR u.county = $2)
             AND ($3::text IS NULL OR u.role::text = $3)
             AND ($4::boolean IS NULL OR u.is_active = $4)
             AND ($5::timestamptz IS NULL OR u.created_at >= $5)
             AND ($6::timestamptz IS NULL OR u.created_at <= $6)
           ORDER BY u.created_at DESC`,
          [searchPattern, countyFilter, roleFilter, isActive, start, end]
        );

        let csv = "User ID,Full Name,Telegram Username,Telegram ID,Role,County,Verified,Active,Token Balance,Submissions,Syncs,Created At,Last Active,Email\n";
        for (const row of res.rows) {
          const escape = (val: any) => {
            if (val === null || val === undefined) return "";
            const str = String(val).replace(/"/g, '""');
            return str.includes(",") || str.includes("\n") || str.includes('"') ? `"${str}"` : str;
          };

          csv += `${escape(row.id)},${escape(row.full_name)},${escape(row.telegram_username)},${escape(row.telegram_id)},${escape(row.role)},${escape(row.county)},${escape(row.is_verified)},${escape(row.is_active)},${escape(row.token_balance)},${escape(row.submission_count)},${escape(row.sync_count)},${escape(row.created_at)},${escape(row.last_seen_at)},${escape(row.email)}\n`;
        }

        reply
          .header("Content-Type", "text/csv")
          .header("Content-Disposition", "attachment; filename=users-export.csv")
          .send(csv);
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to export users." }
        });
      }
    }
  );

  // 13. GET /api/admin/review-queue - Get review queue crop and atmospheric reading list
  fastify.get(
    "/review-queue",
    async (request, reply) => {
      request.adminAction = "view_review_queue";
      try {
        const cropsRes = await query(
          `SELECT cs.id, cs.user_id, cs.crop_type, cs.growth_stage, cs.verification_status, cs.submitted_at, 
                  cs.photo_url, cs.photo_thumbnail_url, cs.ai_health_score, cs.ai_confidence, cs.ai_detected_issues, 
                  cs.rejection_reason, cs.admin_notes, u.full_name,
                  ST_X(cs.location::geometry) AS longitude, ST_Y(cs.location::geometry) AS latitude
           FROM crop_submissions cs
           LEFT JOIN users u ON cs.user_id = u.id
           WHERE cs.verification_status = 'manual_review'
              OR cs.verification_status = 'escalated'
              OR cs.ai_detected_issues->>'geo_anomaly' = 'true'
              OR cs.ai_detected_issues->>'species_mismatch' = 'true'
           ORDER BY cs.submitted_at DESC`
        );

        const atmosphericRes = await query(
          `SELECT ar.id, ar.user_id, ar.pressure_hpa, ar.altitude_m, ar.temperature_c, ar.humidity_pct, 
                  ar.anomaly_score, ar.verified, ar.network_consensus, ar.recorded_at, ar.admin_notes, ar.verification_status, u.full_name,
                  ST_X(ar.location::geometry) AS longitude, ST_Y(ar.location::geometry) AS latitude
           FROM atmospheric_readings ar
           LEFT JOIN users u ON ar.user_id = u.id
           WHERE ar.anomaly_score > 0.1
              OR ar.verification_status = 'manual_review'
              OR ar.verification_status = 'escalated'
           ORDER BY ar.recorded_at DESC`
        );

        return {
          success: true,
          cropSubmissions: cropsRes.rows,
          atmosphericReadings: atmosphericRes.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve review queue." }
        });
      }
    }
  );

  // 14. POST /api/admin/review-queue/crop/:id - Approve, reject, or escalate crop submission
  fastify.post<{ Params: { id: string }; Body: { action: string; reason?: string; notes?: string } }>(
    "/review-queue/crop/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { action, reason, notes } = request.body;

      request.adminEntityType = "crop_submissions";
      request.adminEntityId = id;

      try {
        const cropRes = await query(
          "SELECT cs.user_id, cs.crop_type, cs.verification_status, u.telegram_id, u.language FROM crop_submissions cs JOIN users u ON cs.user_id = u.id WHERE cs.id = $1",
          [id]
        );

        if (cropRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "SUBMISSION_NOT_FOUND", message: "Crop submission not found." }
          });
        }

        const submission = cropRes.rows[0];

        if (action === "approve") {
          request.adminAction = "approve_crop_submission";
          if (submission.verification_status === "verified") {
            return reply.status(400).send({
              success: false,
              error: { code: "ALREADY_VERIFIED", message: "This submission is already verified." }
            });
          }

          await query("UPDATE crop_submissions SET verification_status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
          
          await tokenService.awardTokens(submission.user_id, 15, "Admin approved crop submission", "crop_photo", id);

          if (submission.telegram_id) {
            const isSw = submission.language === "sw";
            const msg = isSw 
              ? `Picha yako ya ${submission.crop_type} imehakikishwa! Umepata tokens 15.` 
              : `Your ${submission.crop_type} photo is verified! You earned 15 tokens.`;
            
            await fastify.notificationsQueue.add("send-telegram", {
              telegramId: String(submission.telegram_id),
              message: msg
            });
          }

          return { success: true, message: "Submission approved and tokens credited." };
        } 
        
        if (action === "reject") {
          request.adminAction = "reject_crop_submission";
          if (!reason || reason.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_REASON", message: "Rejection reason is required." }
            });
          }

          await query("UPDATE crop_submissions SET verification_status = 'rejected', rejection_reason = $1 WHERE id = $2", [reason.trim(), id]);

          if (submission.telegram_id) {
            const isSw = submission.language === "sw";
            const msg = isSw
              ? `Picha yako ya ${submission.crop_type} imekataliwa. Sababu: ${reason.trim()}`
              : `Your ${submission.crop_type} photo submission was rejected. Reason: ${reason.trim()}`;
            
            await fastify.notificationsQueue.add("send-telegram", {
              telegramId: String(submission.telegram_id),
              message: msg
            });
          }

          return { success: true, message: "Submission rejected and farmer notified." };
        } 
        
        if (action === "escalate") {
          request.adminAction = "escalate_crop_submission";
          if (!notes || notes.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_NOTES", message: "Escalation notes are required." }
            });
          }

          await query("UPDATE crop_submissions SET verification_status = 'escalated', admin_notes = $1, escalated_at = CURRENT_TIMESTAMP WHERE id = $2", [notes.trim(), id]);

          return { success: true, message: "Submission escalated for admin review." };
        }

        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_ACTION", message: "Invalid action." }
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process crop review." }
        });
      }
    }
  );

  // 15. POST /api/admin/review-queue/atmospheric/:id - Approve, reject, or escalate weather sync
  fastify.post<{ Params: { id: string }; Body: { action: string; reason?: string; notes?: string } }>(
    "/review-queue/atmospheric/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { action, reason, notes } = request.body;

      request.adminEntityType = "atmospheric_readings";
      request.adminEntityId = id;

      try {
        const readingRes = await query(
          `SELECT ar.user_id, ar.verified, ar.verification_status, u.telegram_id, u.language 
           FROM atmospheric_readings ar 
           JOIN users u ON ar.user_id = u.id 
           WHERE ar.id = $1`,
          [id]
        );

        if (readingRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "READING_NOT_FOUND", message: "Atmospheric reading not found." }
          });
        }

        const reading = readingRes.rows[0];

        if (action === "approve") {
          request.adminAction = "approve_atmospheric_reading";
          
          await query("UPDATE atmospheric_readings SET verified = TRUE, verification_status = 'verified' WHERE id = $1", [id]);
          
          const ledgerCheck = await query(
            `SELECT id, notes FROM token_ledger WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync'`,
            [id]
          );

          let tokenAwarded = false;
          if (ledgerCheck.rows.length > 0) {
            const hasPending = ledgerCheck.rows.some(r => r.notes === "pending");
            const hasReversed = ledgerCheck.rows.some(r => r.notes === "reversed" || r.notes.includes("reversed") || r.notes.includes("Failed"));
            
            if (hasPending) {
              await query(
                `UPDATE token_ledger SET notes = 'confirmed' WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'pending'`,
                [id]
              );
              tokenAwarded = true;
            } else if (hasReversed) {
              await tokenService.awardTokens(reading.user_id, 1, "Admin approved barometric reading (re-credited)", "atmospheric_sync", id);
              tokenAwarded = true;
            }
          } else {
            await tokenService.awardTokens(reading.user_id, 1, "Admin approved barometric reading", "atmospheric_sync", id);
            tokenAwarded = true;
          }

          if (reading.telegram_id) {
            const isSw = reading.language === "sw";
            const msg = isSw
              ? `Usawazishaji wako wa shinikizo la hewa umekubaliwa! Umepata tokeni 1.`
              : `Your barometric reading has been verified. You earned 1 token.`;
            
            await fastify.notificationsQueue.add("send-telegram", {
              telegramId: String(reading.telegram_id),
              message: msg
            });
          }

          return { success: true, message: "Atmospheric reading approved.", tokenAwarded };
        } 
        
        if (action === "reject") {
          request.adminAction = "reject_atmospheric_reading";
          if (!reason || reason.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_REASON", message: "Rejection reason is required." }
            });
          }

          await query("UPDATE atmospheric_readings SET verified = FALSE, verification_status = 'rejected', admin_notes = $1 WHERE id = $2", [reason.trim(), id]);

          await query(
            `UPDATE token_ledger SET notes = 'reversed' WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'pending'`,
            [id]
          );

          if (reading.telegram_id) {
            const isSw = reading.language === "sw";
            const msg = isSw
              ? `Usawazishaji wako wa shinikizo la hewa umekataliwa. Sababu: ${reason.trim()}`
              : `Your barometric reading was rejected. Reason: ${reason.trim()}`;
            
            await fastify.notificationsQueue.add("send-telegram", {
              telegramId: String(reading.telegram_id),
              message: msg
            });
          }

          return { success: true, message: "Atmospheric reading rejected." };
        } 
        
        if (action === "escalate") {
          request.adminAction = "escalate_atmospheric_reading";
          if (!notes || notes.trim().length === 0) {
            return reply.status(400).send({
              success: false,
              error: { code: "MISSING_NOTES", message: "Escalation notes are required." }
            });
          }

          await query("UPDATE atmospheric_readings SET verification_status = 'escalated', admin_notes = $1, escalated_at = CURRENT_TIMESTAMP WHERE id = $2", [notes.trim(), id]);

          return { success: true, message: "Atmospheric reading escalated." };
        }

        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_ACTION", message: "Invalid action." }
        });
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process atmospheric review." }
        });
      }
    }
  );

  // 16. GET /api/admin/financials - Financial transparency audit stats
  fastify.get(
    "/financials",
    async (request, reply) => {
      request.adminAction = "view_financials";
      const { page = "1", limit = "20", status } = request.query as any;

      const pageNum = parseInt(page, 10) || 1;
      const limitNum = parseInt(limit, 10) || 20;
      const offset = (pageNum - 1) * limitNum;

      try {
        const circulationRes = await query("SELECT COALESCE(SUM(amount), 0) AS total FROM token_ledger");
        const totalCirculation = Number(circulationRes.rows[0].total);

        const redeemedRes = await query(
          `SELECT 
             redemption_type, 
             COALESCE(SUM(tokens_spent), 0) AS total_tokens, 
             COALESCE(SUM(amount_kes), 0) AS total_kes
           FROM redemption_requests 
           WHERE status = 'completed'
           GROUP BY redemption_type`
        );

        const pendingRes = await query(
          `SELECT 
             COUNT(*) AS count, 
             COALESCE(SUM(amount_kes), 0) AS total_kes 
           FROM redemption_requests 
           WHERE status = 'pending' OR status = 'processing'`
        );

        const failedRes = await query(
          `SELECT r.id, r.tokens_spent, r.redemption_type, r.amount_kes, r.initiated_at, r.failure_reason, u.full_name
           FROM redemption_requests r
           JOIN users u ON r.user_id = u.id
           WHERE r.status = 'failed'
           ORDER BY r.initiated_at DESC`
        );

        const velocityRes = await query(
          `SELECT 
             TO_CHAR(created_at, 'YYYY-MM') AS month, 
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS credited, 
             SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS debited
           FROM token_ledger 
           GROUP BY TO_CHAR(created_at, 'YYYY-MM') 
           ORDER BY month DESC 
           LIMIT 12`
        );

        const statusFilter = status || null;
        const listQuery = `
          SELECT r.id, r.tokens_spent, r.redemption_type, r.amount_kes, r.status, r.initiated_at, r.mpesa_receipt, u.full_name,
                 pgp_sym_decrypt(r.phone_number::bytea, $1) AS raw_phone
          FROM redemption_requests r
          JOIN users u ON r.user_id = u.id
          WHERE ($2::text IS NULL OR r.status::text = $2)
          ORDER BY r.initiated_at DESC
          LIMIT $3 OFFSET $4
        `;
        const listRes = await query(listQuery, [env.PGCRYPTO_SYMMETRIC_KEY, statusFilter, limitNum, offset]);

        const countQuery = `
          SELECT COUNT(*) AS total
          FROM redemption_requests
          WHERE ($1::text IS NULL OR status::text = $1)
        `;
        const countRes = await query(countQuery, [statusFilter]);

        const maskPhone = (phone: string | null) => {
          if (!phone) return "";
          const cleaned = phone.trim();
          if (cleaned.length <= 4) return "****";
          return "****" + cleaned.slice(-4);
        };

        const redemptions = listRes.rows.map((row: any) => ({
          id: row.id,
          tokens_spent: row.tokens_spent,
          redemption_type: row.redemption_type,
          amount_kes: row.amount_kes,
          status: row.status,
          initiated_at: row.initiated_at,
          mpesa_receipt: row.mpesa_receipt,
          full_name: row.full_name,
          phone: maskPhone(row.raw_phone)
        }));

        return {
          success: true,
          circulation: totalCirculation,
          redeemed: redeemedRes.rows,
          pending: {
            count: Number(pendingRes.rows[0].count),
            kes: Number(pendingRes.rows[0].total_kes)
          },
          failed: failedRes.rows,
          velocity: velocityRes.rows.reverse(),
          redemptions,
          totalCount: Number(countRes.rows[0].total),
          page: pageNum,
          limit: limitNum
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve financial metrics." }
        });
      }
    }
  );

  // 17. GET /api/admin/reports/partner - Partner downloadable report
  fastify.get(
    "/reports/partner",
    async (request, reply) => {
      request.adminAction = "export_partner_report";
      const { startDate, endDate, format = "json" } = request.query as any;

      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      try {
        const cropPoints = await query(
          `SELECT 
             u.county,
             TO_CHAR(cs.submitted_at, 'YYYY-MM') AS month,
             COUNT(*) AS count
           FROM crop_submissions cs
           JOIN users u ON cs.user_id = u.id
           WHERE cs.verification_status = 'verified'
             AND ($1::timestamptz IS NULL OR cs.submitted_at >= $1)
             AND ($2::timestamptz IS NULL OR cs.submitted_at <= $2)
           GROUP BY u.county, TO_CHAR(cs.submitted_at, 'YYYY-MM')
           ORDER BY month DESC, count DESC`,
          [start, end]
        );

        const syncPoints = await query(
          `SELECT 
             u.county,
             TO_CHAR(ar.recorded_at, 'YYYY-MM') AS month,
             COUNT(*) AS count
           FROM atmospheric_readings ar
           JOIN users u ON ar.user_id = u.id
           WHERE ar.verified = TRUE
             AND ($1::timestamptz IS NULL OR ar.recorded_at >= $1)
             AND ($2::timestamptz IS NULL OR ar.recorded_at <= $2)
           GROUP BY u.county, TO_CHAR(ar.recorded_at, 'YYYY-MM')
           ORDER BY month DESC, count DESC`,
          [start, end]
        );

        const userGrowth = await query(
          `SELECT 
             TO_CHAR(created_at, 'YYYY-MM') AS month,
             role,
             COUNT(*) AS count
           FROM users
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
             AND ($2::timestamptz IS NULL OR created_at <= $2)
           GROUP BY TO_CHAR(created_at, 'YYYY-MM'), role
           ORDER BY month DESC, role`,
          [start, end]
        );

        const aiConfidence = await query(
          `SELECT 
             crop_type,
             TO_CHAR(submitted_at, 'YYYY-MM') AS month,
             AVG(ai_confidence) AS avg_confidence,
             AVG(ai_health_score) AS avg_health,
             COUNT(*) AS total
           FROM crop_submissions
           WHERE ($1::timestamptz IS NULL OR submitted_at >= $1)
             AND ($2::timestamptz IS NULL OR submitted_at <= $2)
           GROUP BY crop_type, TO_CHAR(submitted_at, 'YYYY-MM')
           ORDER BY month DESC, crop_type`,
          [start, end]
        );

        const tokenDistribution = await query(
          `SELECT 
             transaction_type,
             TO_CHAR(created_at, 'YYYY-MM') AS month,
             SUM(amount) AS amount
           FROM token_ledger
           WHERE ($1::timestamptz IS NULL OR created_at >= $1)
             AND ($2::timestamptz IS NULL OR created_at <= $2)
           GROUP BY transaction_type, TO_CHAR(created_at, 'YYYY-MM')
           ORDER BY month DESC, transaction_type`,
          [start, end]
        );

        const kesDisbursed = await query(
          `SELECT 
             redemption_type,
             TO_CHAR(initiated_at, 'YYYY-MM') AS month,
             SUM(amount_kes) AS total_kes
           FROM redemption_requests
           WHERE status = 'completed'
             AND ($1::timestamptz IS NULL OR initiated_at >= $1)
             AND ($2::timestamptz IS NULL OR initiated_at <= $2)
           GROUP BY redemption_type, TO_CHAR(initiated_at, 'YYYY-MM')
           ORDER BY month DESC, redemption_type`,
          [start, end]
        );

        const reportData = {
          verifiedCrops: cropPoints.rows,
          verifiedWeather: syncPoints.rows,
          userGrowth: userGrowth.rows,
          aiConfidence: aiConfidence.rows,
          tokenDistribution: tokenDistribution.rows,
          kesDisbursed: kesDisbursed.rows
        };

        if (format === "csv") {
          let csv = "";
          const escape = (val: any) => {
            if (val === null || val === undefined) return "";
            const str = String(val).replace(/"/g, '""');
            return str.includes(",") || str.includes("\n") || str.includes('"') ? `"${str}"` : str;
          };

          csv += "SECTION: Verified Crop Data Points by County and Month\nCounty,Month,Count\n";
          for (const row of cropPoints.rows) {
            csv += `${escape(row.county)},${escape(row.month)},${escape(row.count)}\n`;
          }

          csv += "\nSECTION: Verified Weather Sync Readings by County and Month\nCounty,Month,Count\n";
          for (const row of syncPoints.rows) {
            csv += `${escape(row.county)},${escape(row.month)},${escape(row.count)}\n`;
          }

          csv += "\nSECTION: User Registrations Growth over Time\nMonth,Role,Registrations\n";
          for (const row of userGrowth.rows) {
            csv += `${escape(row.month)},${escape(row.role)},${escape(row.count)}\n`;
          }

          csv += "\nSECTION: AI Verification Confidence Rates\nCrop Type,Month,Average Confidence,Average Health Score,Total Submissions\n";
          for (const row of aiConfidence.rows) {
            csv += `${escape(row.crop_type)},${escape(row.month)},${parseFloat(row.avg_confidence).toFixed(3)},${parseFloat(row.avg_health).toFixed(3)},${escape(row.total)}\n`;
          }

          csv += "\nSECTION: Token Ledger Distribution by Type\nTransaction Type,Month,Total Tokens\n";
          for (const row of tokenDistribution.rows) {
            csv += `${escape(row.transaction_type)},${escape(row.month)},${escape(row.amount)}\n`;
          }

          csv += "\nSECTION: KES Disbursed Across Four Layers\nRedemption Type,Month,Total KES Disbursed\n";
          for (const row of kesDisbursed.rows) {
            csv += `${escape(row.redemption_type)},${escape(row.month)},${parseFloat(row.total_kes).toFixed(2)}\n`;
          }

          reply
            .header("Content-Type", "text/csv")
            .header("Content-Disposition", "attachment; filename=partner-report.csv")
            .send(csv);
        } else {
          return {
            success: true,
            report: reportData
          };
        }
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to generate report." }
        });
      }
    }
  );

  // === MODULE 5: CIRCULAR ECONOMY ROUTES ===

  // 18. GET /api/admin/agro-dealers - List all agro-dealers
  fastify.get(
    "/agro-dealers",
    async (request, reply) => {
      request.adminAction = "view_agro_dealers";
      try {
        const res = await query(
          `SELECT 
             ad.*,
             COALESCE(
               (SELECT json_agg(category_name) 
                FROM dealer_product_categories 
                WHERE dealer_id = ad.id AND is_active = TRUE), 
               '[]'::json
             ) AS categories
           FROM agro_dealers ad
           ORDER BY ad.created_at DESC`
        );
        return {
          success: true,
          agroDealers: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve agro-dealers." }
        });
      }
    }
  );

  // 19. POST /api/admin/agro-dealers - Add a new agro-dealer
  fastify.post<{
    Body: {
      dealerName: string;
      dealerPhone: string;
      countyId: string;
      bankAccount: string;
      mouSignedAt?: string;
      transactionFeePct?: number;
      categories?: string[];
      dealerLogoUrl?: string;
    };
  }>(
    "/agro-dealers",
    async (request, reply) => {
      request.adminAction = "create_agro_dealer";
      const {
        dealerName,
        dealerPhone,
        countyId,
        bankAccount,
        mouSignedAt,
        transactionFeePct = 3.50,
        categories = [],
        dealerLogoUrl
      } = request.body;

      if (!dealerName || !dealerPhone || !countyId || !bankAccount) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "dealerName, dealerPhone, countyId, and bankAccount are required." }
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const dealerInsert = await client.query(
          `INSERT INTO agro_dealers (dealer_name, dealer_phone, county_id, mou_signed_at, bank_account, transaction_fee_pct, active, dealer_logo_url)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
           RETURNING id`,
          [
            dealerName,
            dealerPhone,
            countyId,
            mouSignedAt ? new Date(mouSignedAt) : null,
            bankAccount,
            transactionFeePct,
            dealerLogoUrl || null
          ]
        );
        const dealerId = dealerInsert.rows[0].id;

        if (categories && categories.length > 0) {
          for (const category of categories) {
            await client.query(
              `INSERT INTO dealer_product_categories (dealer_id, category_name, is_active)
               VALUES ($1, $2, TRUE)`,
              [dealerId, category]
            );
          }
        }

        await client.query("COMMIT");

        request.adminEntityType = "agro_dealers";
        request.adminEntityId = dealerId;

        return {
          success: true,
          message: "Agro-dealer created successfully.",
          dealerId
        };
      } catch (err: any) {
        await client.query("ROLLBACK");
        if (err.code === "23505") { // Unique constraint violation on dealer_phone
          return reply.status(400).send({
            success: false,
            error: { code: "DUPLICATE_PHONE", message: "An agro-dealer with this phone number already exists." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to create agro-dealer." }
        });
      } finally {
        client.release();
      }
    }
  );

  // 20. GET /api/admin/agro-dealers/reconciliation - Calculate pending weekly settlements per dealer
  fastify.get(
    "/agro-dealers/reconciliation",
    async (request, reply) => {
      request.adminAction = "view_agro_dealer_reconciliations";
      try {
        const res = await query(
          `SELECT 
             ad.id AS agro_dealer_id,
             ad.dealer_name,
             ad.dealer_phone,
             ad.county_id,
             ad.transaction_fee_pct,
             ad.bank_account,
             COALESCE(SUM(vr.token_amount), 0)::integer AS total_tokens,
             COALESCE(SUM(vr.kes_value), 0)::numeric AS total_kes_value,
             COALESCE(SUM(vr.kes_value * (ad.transaction_fee_pct / 100.0)), 0)::numeric AS total_fee_retained,
             COALESCE(SUM(vr.kes_value * (1.0 - ad.transaction_fee_pct / 100.0)), 0)::numeric AS total_kes_owed
           FROM agro_dealers ad
           LEFT JOIN voucher_redemptions vr ON ad.id = vr.agro_dealer_id AND vr.status IN ('scanned', 'redeemed') AND vr.reconciled_at IS NULL
           GROUP BY ad.id
           ORDER BY total_kes_owed DESC`
        );
        return {
          success: true,
          reconciliations: res.rows.map(row => ({
            ...row,
            total_tokens: Number(row.total_tokens),
            total_kes_value: Number(row.total_kes_value),
            total_fee_retained: Number(row.total_fee_retained),
            total_kes_owed: Number(row.total_kes_owed)
          }))
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to calculate weekly settlements." }
        });
      }
    }
  );

  // 21. PATCH /api/admin/agro-dealers/reconciliation/:id/settle - Settle pending vouchers for a dealer
  fastify.patch<{ Params: { id: string }; Body: { settlementReference: string } }>(
    "/agro-dealers/reconciliation/:id/settle",
    async (request, reply) => {
      const { id } = request.params;
      const { settlementReference } = request.body;
      request.adminAction = "settle_agro_dealer_vouchers";
      request.adminEntityType = "agro_dealers";
      request.adminEntityId = id;

      if (!settlementReference || settlementReference.trim().length === 0) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_REFERENCE", message: "settlementReference is required." }
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Lock dealer
        const dealerRes = await client.query(
          "SELECT id, dealer_name, transaction_fee_pct FROM agro_dealers WHERE id = $1 FOR UPDATE",
          [id]
        );
        if (dealerRes.rows.length === 0) {
          throw new Error("DEALER_NOT_FOUND");
        }
        const dealer = dealerRes.rows[0];

        // Fetch pending vouchers
        await client.query(
          `SELECT id FROM voucher_redemptions
           WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL
           FOR UPDATE`,
          [id]
        );

        const vouchersRes = await client.query(
          `SELECT COALESCE(SUM(token_amount), 0) AS total_tokens, 
                  COALESCE(SUM(kes_value), 0) AS total_kes_value
           FROM voucher_redemptions
           WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL`,
          [id]
        );

        const totalTokens = Number(vouchersRes.rows[0].total_tokens);
        const totalKesValue = Number(vouchersRes.rows[0].total_kes_value);

        if (totalTokens === 0) {
          throw new Error("NO_PENDING_VOUCHERS");
        }

        // Compute net settlement
        const feePct = Number(dealer.transaction_fee_pct);
        const netMultiplier = 1.0 - (feePct / 100.0);
        const totalKesOwed = totalKesValue * netMultiplier;

        // Find period start
        const lastReconRes = await client.query(
          "SELECT period_end FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1 ORDER BY period_end DESC LIMIT 1",
          [id]
        );
        const periodStart = lastReconRes.rows.length > 0 
          ? new Date(lastReconRes.rows[0].period_end) 
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const periodEnd = new Date();

        // Insert reconciliation log
        await client.query(
          `INSERT INTO agro_dealer_reconciliations (agro_dealer_id, period_start, period_end, total_tokens_redeemed, total_kes_owed, settlement_reference, settled_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'settled')`,
          [id, periodStart, periodEnd, totalTokens, totalKesOwed, settlementReference.trim()]
        );

        // Update vouchers
        await client.query(
          `UPDATE voucher_redemptions
           SET status = 'reconciled', reconciled_at = CURRENT_TIMESTAMP
           WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL`,
          [id]
        );

        await client.query("COMMIT");

        return {
          success: true,
          message: "Agro-dealer vouchers successfully reconciled and settled.",
          settledAmountKes: totalKesOwed,
          totalTokens
        };
      } catch (err: any) {
        await client.query("ROLLBACK");
        if (err.message === "DEALER_NOT_FOUND") {
          return reply.status(404).send({
            success: false,
            error: { code: "DEALER_NOT_FOUND", message: "Agro-dealer not found." }
          });
        }
        if (err.message === "NO_PENDING_VOUCHERS") {
          return reply.status(400).send({
            success: false,
            error: { code: "NO_PENDING_VOUCHERS", message: "No pending/unreconciled vouchers found for this dealer." }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to settle agro-dealer vouchers." }
        });
      } finally {
        client.release();
      }
    }
  );

  // 22. GET /api/admin/circle/coordinators - List circle coordinators with decrypted phone/mpesa
  fastify.get(
    "/circle/coordinators",
    async (request, reply) => {
      request.adminAction = "view_circle_coordinators";
      try {
        const res = await query(
          `SELECT 
             cc.id,
             da.user_id AS agent_id,
             cc.county_id,
             cc.mpesa_number AS mpesa_number,
             cc.active_from,
             cc.active,
             cc.selected_by_community,
             u.full_name AS agent_name,
             u.email AS agent_email,
             u.telegram_username AS agent_telegram
           FROM circle_coordinators cc
           JOIN data_agents da ON cc.agent_id = da.id
           JOIN users u ON da.user_id = u.id
           ORDER BY cc.active_from DESC`
        );
        return {
          success: true,
          coordinators: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve circle coordinators." }
        });
      }
    }
  );

  // 23. GET /api/admin/circle/agents - List active Data Agents not appointed as coordinators
  fastify.get<{ Querystring: { county?: string } }>(
    "/circle/agents",
    async (request, reply) => {
      request.adminAction = "view_available_circle_agents";
      const { county } = request.query;
      try {
        const res = await query(
          `SELECT u.id, u.full_name, u.telegram_username, u.email, u.county
           FROM users u
           WHERE u.role = 'agent'
             AND u.is_active = TRUE
             AND u.id NOT IN (
               SELECT da.user_id 
               FROM circle_coordinators cc 
               JOIN data_agents da ON cc.agent_id = da.id 
               WHERE cc.active = TRUE
             )
             AND ($1::text IS NULL OR u.county = $1)
           ORDER BY u.full_name ASC`,
          [county || null]
        );
        return {
          success: true,
          agents: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve available agents." }
        });
      }
    }
  );

  // 24. GET /api/admin/circle/calculator - Monthly county pool calculator
  fastify.get(
    "/circle/calculator",
    async (request, reply) => {
      request.adminAction = "view_circle_monthly_pools";
      try {
        const res = await query(
          `SELECT 
             cc.county_id,
             cc.id AS coordinator_id,
             u.full_name AS coordinator_name,
             cc.mpesa_number AS coordinator_mpesa,
             COALESCE(SUM(rr.tokens_spent), 0)::integer AS total_tokens,
             COALESCE(SUM(rr.amount_kes), 0)::numeric AS total_kes,
             COUNT(DISTINCT rr.user_id)::integer AS total_users
           FROM circle_coordinators cc
           JOIN data_agents da ON cc.agent_id = da.id
           JOIN users u ON da.user_id = u.id
           LEFT JOIN users fu ON fu.county = cc.county_id
           LEFT JOIN redemption_requests rr ON rr.user_id = fu.id AND rr.redemption_type = 'circle' AND rr.status = 'pending'
           WHERE cc.active = TRUE
           GROUP BY cc.county_id, cc.id, u.full_name, cc.mpesa_number
           ORDER BY total_kes DESC`
        );
        return {
          success: true,
          pools: res.rows.map(row => ({
            ...row,
            total_tokens: Number(row.total_tokens),
            total_kes: Number(row.total_kes),
            total_users: Number(row.total_users)
          }))
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to calculate Dira Circle monthly pools." }
        });
      }
    }
  );

  // 25. POST /api/admin/circle/distributions - Trigger monthly pool aggregation
  fastify.post<{ Body: { countyId: string; periodMonth?: string } }>(
    "/circle/distributions",
    async (request, reply) => {
      request.adminAction = "process_circle_pool";
      const { countyId, periodMonth } = request.body;

      if (!countyId) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "countyId is required." }
        });
      }

      const dateObj = periodMonth ? new Date(periodMonth) : new Date();
      dateObj.setUTCDate(1);
      dateObj.setUTCHours(0, 0, 0, 0);

      try {
        const result = await diraCircleService.processMonthlyCountyPool(countyId, dateObj);

        // Fetch generated distribution ID
        const distRes = await query(
          "SELECT id FROM dira_circle_distributions WHERE county_id = $1 AND period_month = $2 LIMIT 1",
          [countyId, dateObj]
        );
        if (distRes.rows.length > 0) {
          request.adminEntityType = "dira_circle_distributions";
          request.adminEntityId = distRes.rows[0].id;
        }

        return {
          success: true,
          message: `Dira Circle pool aggregation processed for county ${countyId}.`,
          summary: result
        };
      } catch (err: any) {
        if (err.message === "COORDINATOR_NOT_FOUND") {
          return reply.status(400).send({
            success: false,
            error: { code: "COORDINATOR_NOT_FOUND", message: `No active coordinator appointed for county: ${countyId}` }
          });
        }
        if (err.message === "NO_PENDING_REDEMPTIONS") {
          return reply.status(400).send({
            success: false,
            error: { code: "NO_PENDING_REDEMPTIONS", message: `No pending cash redemptions found for users in county: ${countyId}` }
          });
        }
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process monthly county pool." }
        });
      }
    }
  );

  // 26. GET /api/admin/circle/distributions/export-instructions - CSV instructions download
  fastify.get(
    "/circle/distributions/export-instructions",
    async (request, reply) => {
      request.adminAction = "export_circle_instructions";
      try {
        const res = await query(
          `SELECT 
             u.full_name AS coordinator_name,
             d.county_id AS county,
             c.mpesa_number AS mpesa_number,
             d.total_kes_disbursed AS kes_amount
           FROM dira_circle_distributions d
           JOIN circle_coordinators c ON d.coordinator_id = c.id
           JOIN data_agents da ON c.agent_id = da.id
           JOIN users u ON da.user_id = u.id
           WHERE d.status = 'pending'`
        );

        let csv = "Coordinator Name,County,M-Pesa Number,KES Amount\n";
        const escape = (val: any) => {
          if (val === null || val === undefined) return "";
          const str = String(val).replace(/"/g, '""');
          return str.includes(",") || str.includes("\n") || str.includes('"') ? `"${str}"` : str;
        };

        for (const row of res.rows) {
          csv += `${escape(row.coordinator_name)},${escape(row.county)},${escape(row.mpesa_number)},${parseFloat(row.kes_amount).toFixed(2)}\n`;
        }

        reply
          .header("Content-Type", "text/csv")
          .header("Content-Disposition", "attachment; filename=circle-transfer-instructions.csv")
          .send(csv);
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to export transfer instructions." }
        });
      }
    }
  );

  // 27. GET /api/admin/mpesa-settings - Read settings & environment variable flag
  fastify.get(
    "/mpesa-settings",
    async (request, reply) => {
      request.adminAction = "view_mpesa_settings";
      try {
        const settingsRes = await query("SELECT key, value FROM mpesa_activation_settings");
        const settings: Record<string, boolean> = {};
        for (const row of settingsRes.rows) {
          settings[row.key] = row.value;
        }

        return {
          success: true,
          darajaProductionActive: env.DARAJA_PRODUCTION_ACTIVE,
          settings
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve M-Pesa settings." }
        });
      }
    }
  );

  // 28. PATCH /api/admin/mpesa-settings - Update DB settings (does not touch env flag)
  fastify.patch<{ Body: { key: string; value: boolean } }>(
    "/mpesa-settings",
    async (request, reply) => {
      request.adminAction = "update_mpesa_settings";
      const { key, value } = request.body;

      if (!key || value === undefined) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "key and value are required." }
        });
      }

      const allowedKeys = ["daraja_credentials_approved", "first_b2b_revenue_received"];
      if (!allowedKeys.includes(key)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_KEY", message: `Key must be one of: ${allowedKeys.join(", ")}` }
        });
      }

      try {
        await query(
          `INSERT INTO mpesa_activation_settings (key, value, updated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [key, value]
        );

        request.adminEntityType = "mpesa_activation_settings";
        request.adminEntityId = undefined;
        request.adminMetadata = { key, value };

        return {
          success: true,
          message: `Successfully updated ${key} to ${value}.`
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to update M-Pesa settings." }
        });
      }
    }
  );

  // 29. POST /api/admin/redemptions/:id/retry - Re-deduct and re-trigger failed M-Pesa redemptions
  fastify.post<{ Params: { id: string } }>(
    "/redemptions/:id/retry",
    async (request, reply) => {
      const { id } = request.params;
      request.adminAction = "retry_mpesa_redemption";
      request.adminEntityType = "redemption_requests";
      request.adminEntityId = id;

      try {
        // 1. Fetch original redemption request & decrypt phone number
        const reqRes = await query(
          `SELECT id, user_id, tokens_spent, amount_kes, status,
                  pgp_sym_decrypt(phone_number::bytea, $1) AS decrypted_phone
           FROM redemption_requests
           WHERE id = $2 AND redemption_type = 'mpesa'`,
          [env.PGCRYPTO_SYMMETRIC_KEY, id]
        );

        if (reqRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "NOT_FOUND", message: "M-Pesa redemption request not found." }
          });
        }

        const redemption = reqRes.rows[0];

        if (redemption.status !== "failed") {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_STATUS", message: "Only failed redemption requests can be retried." }
          });
        }

        // 2. Validate current user balance
        const userId = redemption.user_id;
        const tokensSpent = Number(redemption.tokens_spent);
        const amountKes = Number(redemption.amount_kes);
        const phone = redemption.decrypted_phone;

        const { balance } = await tokenService.getBalance(userId);
        if (balance < tokensSpent) {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_TOKENS", message: `User balance (${balance}) is insufficient to cover the retry amount (${tokensSpent}).` }
          });
        }

        // 3. Deduct tokens from user's ledger (deduct-first pattern)
        try {
          await tokenService.deductTokens(userId, tokensSpent, "redeem_mpesa", id);
        } catch (err: any) {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_TOKENS", message: "Failed to deduct tokens from user balance." }
          });
        }

        // 4. Trigger B2C payout request via Safaricom Daraja
        const triggerRes = await paymentService.triggerMpesaB2C(phone, amountKes);

        if (triggerRes.success && triggerRes.conversationId) {
          // 5. Update request status to 'processing' and save ConversationID
          await query(
            `UPDATE redemption_requests
             SET status = 'processing',
                 at_transaction_id = $1,
                 failure_reason = NULL,
                 completed_at = NULL
             WHERE id = $2`,
            [triggerRes.conversationId, id]
          );

          return {
            success: true,
            message: "M-Pesa retry successfully initiated. Processing callback.",
            conversationId: triggerRes.conversationId
          };
        } else {
          const errMsg = triggerRes.errorMessage || "Failed to trigger Safaricom Daraja request";
          
          // Roll back: credit tokens back to the user
          await tokenService.creditTokens(
            userId,
            tokensSpent,
            "adjustment",
            id,
            `M-Pesa retry failed refund: ${errMsg}`
          );

          // Update failure reason in db
          await query(
            `UPDATE redemption_requests
             SET failure_reason = $1
             WHERE id = $2`,
            [`Retry failed: ${errMsg}`, id]
          );

          return reply.status(500).send({
            success: false,
            error: { code: "MPESA_RETRY_FAILED", message: errMsg }
          });
        }
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retry M-Pesa redemption." }
        });
      }
    }
  );

  // 30. GET /api/admin/reports/token-economic-activity - Token Economic Activity Report (Annex A)
  fastify.get(
    "/reports/token-economic-activity",
    async (request, reply) => {
      request.adminAction = "export_token_economic_report";
      const { startDate, endDate, format = "json" } = request.query as any;

      const start = startDate ? new Date(startDate) : null;
      const end = endDate ? new Date(endDate) : null;

      try {
        // 1. Summary statistics
        const earnedRes = await query(
          `SELECT COALESCE(SUM(amount), 0)::integer AS total
           FROM token_ledger
           WHERE amount > 0
             AND ($1::timestamptz IS NULL OR created_at >= $1)
             AND ($2::timestamptz IS NULL OR created_at <= $2)`,
          [start, end]
        );
        const totalEarned = Number(earnedRes.rows[0].total);

        const redeemedRes = await query(
          `SELECT COALESCE(SUM(tokens_spent), 0)::integer AS total,
                  COALESCE(SUM(amount_kes), 0)::numeric AS total_kes
           FROM redemption_requests
           WHERE status = 'completed'
             AND ($1::timestamptz IS NULL OR initiated_at >= $1)
             AND ($2::timestamptz IS NULL OR initiated_at <= $2)`,
          [start, end]
        );
        const totalRedeemed = Number(redeemedRes.rows[0].total);
        const totalKesDisbursed = Number(redeemedRes.rows[0].total_kes);

        const uniqueEarnersRes = await query(
          `SELECT COUNT(DISTINCT user_id)::integer AS count
           FROM token_ledger
           WHERE amount > 0
             AND ($1::timestamptz IS NULL OR created_at >= $1)
             AND ($2::timestamptz IS NULL OR created_at <= $2)`,
          [start, end]
        );
        const uniqueEarners = Number(uniqueEarnersRes.rows[0].count);

        const uniqueRedeemersRes = await query(
          `SELECT COUNT(DISTINCT user_id)::integer AS count
           FROM redemption_requests
           WHERE status = 'completed'
             AND ($1::timestamptz IS NULL OR initiated_at >= $1)
             AND ($2::timestamptz IS NULL OR initiated_at <= $2)`,
          [start, end]
        );
        const uniqueRedeemers = Number(uniqueRedeemersRes.rows[0].count);

        // Conversion velocity (average days to redeem)
        const velocityRes = await query(
          `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (rr.initiated_at - tl.created_at)) / 86400.0), 0)::numeric AS avg_days
           FROM redemption_requests rr
           JOIN LATERAL (
             SELECT created_at 
             FROM token_ledger 
             WHERE user_id = rr.user_id 
               AND amount > 0 
               AND created_at <= rr.initiated_at
             ORDER BY created_at DESC 
             LIMIT 1
           ) tl ON TRUE
           WHERE rr.status = 'completed'
             AND ($1::timestamptz IS NULL OR rr.initiated_at >= $1)
             AND ($2::timestamptz IS NULL OR rr.initiated_at <= $2)`,
          [start, end]
        );
        const conversionVelocity = Number(velocityRes.rows[0].avg_days);

        const summary = {
          totalEarned,
          totalRedeemed,
          totalKesDisbursed,
          uniqueEarners,
          uniqueRedeemers,
          conversionVelocity
        };

        // 2. Earning breakdown by type
        const earnedBreakdownRes = await query(
          `SELECT transaction_type::text AS type, COALESCE(SUM(amount), 0)::integer AS tokens
           FROM token_ledger
           WHERE amount > 0
             AND ($1::timestamptz IS NULL OR created_at >= $1)
             AND ($2::timestamptz IS NULL OR created_at <= $2)
           GROUP BY transaction_type
           ORDER BY tokens DESC`,
          [start, end]
        );
        const earnedBreakdown = earnedBreakdownRes.rows;

        // 3. Redemption breakdown by layer/type
        const redeemedBreakdownRes = await query(
          `SELECT redemption_type::text AS type, 
                  COALESCE(SUM(tokens_spent), 0)::integer AS tokens,
                  COALESCE(SUM(amount_kes), 0)::numeric AS kes
           FROM redemption_requests
           WHERE status = 'completed'
             AND ($1::timestamptz IS NULL OR initiated_at >= $1)
             AND ($2::timestamptz IS NULL OR initiated_at <= $2)
           GROUP BY redemption_type
           ORDER BY tokens DESC`,
          [start, end]
        );
        const redeemedBreakdown = redeemedBreakdownRes.rows.map(row => ({
          ...row,
          tokens: Number(row.tokens),
          kes: Number(row.kes)
        }));

        // 4. County performance breakdown (CTE approach to prevent Cartesian product)
        const countyBreakdownRes = await query(
          `WITH county_earns AS (
             SELECT 
               u.county,
               COALESCE(SUM(tl.amount), 0)::integer AS tokens_earned,
               COUNT(DISTINCT tl.user_id)::integer AS unique_earners
             FROM users u
             JOIN token_ledger tl ON u.id = tl.user_id
             WHERE tl.amount > 0
               AND ($1::timestamptz IS NULL OR tl.created_at >= $1)
               AND ($2::timestamptz IS NULL OR tl.created_at <= $2)
             GROUP BY u.county
           ),
           county_redeems AS (
             SELECT 
               u.county,
               COALESCE(SUM(rr.tokens_spent), 0)::integer AS tokens_redeemed,
               COALESCE(SUM(rr.amount_kes), 0)::numeric AS kes_disbursed,
               COUNT(DISTINCT rr.user_id)::integer AS unique_redeemers
             FROM users u
             JOIN redemption_requests rr ON u.id = rr.user_id
             WHERE rr.status = 'completed'
               AND ($1::timestamptz IS NULL OR rr.initiated_at >= $1)
               AND ($2::timestamptz IS NULL OR rr.initiated_at <= $2)
             GROUP BY u.county
           )
           SELECT 
             COALESCE(e.county, r.county, 'Unknown') AS county,
             COALESCE(e.tokens_earned, 0)::integer AS tokens_earned,
             COALESCE(e.unique_earners, 0)::integer AS unique_earners,
             COALESCE(r.tokens_redeemed, 0)::integer AS tokens_redeemed,
             COALESCE(r.kes_disbursed, 0)::numeric AS kes_disbursed,
             COALESCE(r.unique_redeemers, 0)::integer AS unique_redeemers
           FROM county_earns e
           FULL OUTER JOIN county_redeems r ON e.county = r.county
           ORDER BY tokens_earned DESC`,
          [start, end]
        );
        const countyBreakdown = countyBreakdownRes.rows.map(row => ({
          ...row,
          tokens_earned: Number(row.tokens_earned),
          unique_earners: Number(row.unique_earners),
          tokens_redeemed: Number(row.tokens_redeemed),
          kes_disbursed: Number(row.kes_disbursed),
          unique_redeemers: Number(row.unique_redeemers)
        }));

        if (format === "csv") {
          let csv = "SECTION: Token Economic Activity Summary\nMetric,Value\n";
          csv += `Total Tokens Earned,${summary.totalEarned}\n`;
          csv += `Total Tokens Redeemed,${summary.totalRedeemed}\n`;
          csv += `Total KES Disbursed,${parseFloat(String(summary.totalKesDisbursed)).toFixed(2)}\n`;
          csv += `Unique Earners,${summary.uniqueEarners}\n`;
          csv += `Unique Redeemers,${summary.uniqueRedeemers}\n`;
          csv += `Average Conversion Velocity (Days),${parseFloat(String(summary.conversionVelocity)).toFixed(2)}\n`;

          csv += "\nSECTION: Tokens Earned by Activity Type\nActivity Type,Tokens Earned\n";
          for (const row of earnedBreakdown) {
            csv += `${escape(row.type)},${escape(row.tokens)}\n`;
          }

          csv += "\nSECTION: Tokens Redeemed by Layer\nRedemption Layer,Tokens Spent,KES Disbursed\n";
          for (const row of redeemedBreakdown) {
            csv += `${escape(row.type)},${escape(row.tokens)},${parseFloat(String(row.kes)).toFixed(2)}\n`;
          }

          csv += "\nSECTION: County Performance Breakdown\nCounty,Tokens Earned,Unique Earners,Tokens Redeemed,KES Disbursed,Unique Redeemers\n";
          for (const row of countyBreakdown) {
            csv += `${escape(row.county)},${escape(row.tokens_earned)},${escape(row.unique_earners)},${escape(row.tokens_redeemed)},${parseFloat(String(row.kes_disbursed)).toFixed(2)},${escape(row.unique_redeemers)}\n`;
          }

          reply
            .header("Content-Type", "text/csv")
            .header("Content-Disposition", "attachment; filename=token-economic-activity.csv")
            .send(csv);
        } else {
          return {
            success: true,
            summary,
            earnedBreakdown,
            redeemedBreakdown,
            countyBreakdown
          };
        }
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to generate report." }
        });
      }
    }
  );
}

