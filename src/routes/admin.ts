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
import { midnightService } from "../services/midnightService";
import { diraCircleService } from "../services/diraCircleService";
import { env } from "../config/env";
import { tokenService } from "../services/tokenService";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  midnightAnchorQueue
} from "../jobs/queues";

interface CertificateBody {
  countyCode: string;
  periodStart: string; // ISO Date string
  periodEnd: string; // ISO Date string
  conditionType: string;
  confidenceThreshold: number;
}

export default async function adminRoutes(fastify: FastifyInstance) {
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
        const anchorsRes = await query("SELECT COUNT(*) AS count FROM midnight_anchors");
        
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

  // 2. POST /api/admin/midnight/anchor - Trigger catchup anchoring for completed weeks
  fastify.post(
    "/midnight/anchor",
    async (request, reply) => {
      request.adminAction = "midnight_anchor";
      try {
        const result = await midnightService.anchorAllCompletedWeeks();
        return result;
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to trigger anchoring." }
        });
      }
    }
  );

  // 3. POST /api/admin/midnight/certificate - Issue certificate
  fastify.post<{ Body: CertificateBody }>(
    "/midnight/certificate",
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
        const result = await midnightService.issueCertificate(
          countyCode,
          new Date(periodStart),
          new Date(periodEnd),
          conditionType,
          confidenceThreshold
        );

        if (result.success && result.certId) {
          // Retrieve UUID of generated certificate
          const certQuery = await query("SELECT id FROM midnight_certificates WHERE cert_id = $1", [result.certId]);
          if (certQuery.rows.length > 0) {
            request.adminEntityId = certQuery.rows[0].id;
          }
          request.adminEntityType = "midnight_certificates";
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

  // 4. GET /api/admin/midnight/status - Retrieve Midnight blockchain registry status
  fastify.get(
    "/midnight/status",
    async (request, reply) => {
      request.adminAction = "view_midnight_status";
      try {
        const anchorsRes = await query("SELECT * FROM midnight_anchors ORDER BY week_number DESC LIMIT 50");
        const certificatesRes = await query("SELECT * FROM midnight_certificates ORDER BY created_at DESC LIMIT 50");

        return {
          success: true,
          anchors: anchorsRes.rows,
          certificates: certificatesRes.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve Midnight registry status." }
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
          getQueueStats(midnightAnchorQueue, "midnight-anchor")
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

        await query(
          `INSERT INTO circle_coordinators (agent_id, county_id, mpesa_number, active_from, active)
           VALUES ($1, $2, pgp_sym_encrypt($3, $4), CURRENT_DATE, TRUE)
           ON CONFLICT (county_id) DO UPDATE 
           SET agent_id = EXCLUDED.agent_id, 
               mpesa_number = EXCLUDED.mpesa_number, 
               active = TRUE`,
          [agentId, countyId, mpesaNumber, env.PGCRYPTO_SYMMETRIC_KEY]
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
          `SELECT d.*, u.full_name AS coordinator_name
           FROM dira_circle_distributions d
           JOIN circle_coordinators c ON d.coordinator_id = c.id
           JOIN users u ON c.agent_id = u.id
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
}

