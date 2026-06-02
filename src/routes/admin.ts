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

  // 9. GET /api/admin/users - List recent users
  fastify.get(
    "/users",
    async (request, reply) => {
      request.adminAction = "view_users";
      try {
        const res = await query(
          "SELECT id, full_name, role, county, is_verified, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 100"
        );
        return {
          success: true,
          users: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve users." }
        });
      }
    }
  );

  // 10. GET /api/admin/submissions - List recent crop submissions
  fastify.get(
    "/submissions",
    async (request, reply) => {
      request.adminAction = "view_submissions";
      try {
        const res = await query(
          `SELECT cs.id, cs.crop_type, cs.verification_status, cs.submitted_at, u.full_name 
           FROM crop_submissions cs 
           LEFT JOIN users u ON cs.user_id = u.id 
           ORDER BY cs.submitted_at DESC LIMIT 100`
        );
        return {
          success: true,
          submissions: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve submissions." }
        });
      }
    }
  );

  // 11. GET /api/admin/redemptions - List recent redemptions
  fastify.get(
    "/redemptions",
    async (request, reply) => {
      request.adminAction = "view_redemptions";
      try {
        const res = await query(
          `SELECT r.id, r.redemption_type, r.amount_kes, r.status, r.initiated_at, u.full_name 
           FROM redemption_requests r 
           LEFT JOIN users u ON r.user_id = u.id 
           ORDER BY r.initiated_at DESC LIMIT 100`
        );
        return {
          success: true,
          redemptions: res.rows
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve redemptions." }
        });
      }
    }
  );
}
