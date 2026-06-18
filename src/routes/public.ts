import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { redis } from "../db/redis";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  xionAnchorQueue
} from "../jobs/queues";

export default async function publicRoutes(fastify: FastifyInstance) {
  // Caching helper
  const getCachedOrRun = async (cacheKey: string, expirySeconds: number, runQuery: () => Promise<any>) => {
    if (redis.status === "ready") {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (err) {
        fastify.log.warn(err, `Redis read failure for key ${cacheKey}`);
      }
    }

    const data = await runQuery();

    if (redis.status === "ready") {
      try {
        await redis.set(cacheKey, JSON.stringify(data), "EX", expirySeconds);
      } catch (err) {
        fastify.log.warn(err, `Redis write failure for key ${cacheKey}`);
      }
    }

    return data;
  };

  fastify.get("/health", async (request, reply) => {
    return {
      status: "ok",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get(
    "/public/stats",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const stats = await getCachedOrRun("dira:public:stats", 60, async () => {
        const verifiedRes = await query(
          `SELECT (
             (SELECT COUNT(*) FROM crop_submissions WHERE verification_status = 'verified') +
             (SELECT COUNT(*) FROM atmospheric_readings WHERE verified = TRUE)
           ) AS total_verified`
        );
        const activeUsersRes = await query(
          `SELECT COUNT(DISTINCT user_id) AS active_users FROM (
             SELECT user_id FROM crop_submissions WHERE submitted_at >= CURRENT_DATE - INTERVAL '7 days'
             UNION
             SELECT user_id FROM atmospheric_readings WHERE recorded_at >= CURRENT_DATE - INTERVAL '7 days'
           ) AS active_users`
        );
        const countiesRes = await query(
          `SELECT COUNT(DISTINCT county) AS counties_covered FROM users WHERE county IS NOT NULL AND county <> ''`
        );
        const cropsThisMonthRes = await query(
          `SELECT COUNT(*) AS crops_this_month FROM crop_submissions WHERE date_trunc('month', submitted_at) = date_trunc('month', CURRENT_DATE)`
        );
        const disbursedRes = await query(
          `SELECT COALESCE(SUM(amount_kes), 0) AS total_disbursed_kes FROM redemption_requests WHERE status = 'completed'`
        );

        return {
          totalVerifiedDataPoints: Number(verifiedRes.rows[0]?.total_verified || 0),
          activeUsers7Days: Number(activeUsersRes.rows[0]?.active_users || 0),
          countiesCovered: Number(countiesRes.rows[0]?.counties_covered || 0),
          cropSubmissionsMonth: Number(cropsThisMonthRes.rows[0]?.crops_this_month || 0),
          tokensDisbursedKes: Number(disbursedRes.rows[0]?.total_disbursed_kes || 0)
        };
      });

      return { success: true, stats };
    } catch (err: any) {
      fastify.log.error("Failed to fetch public stats:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to fetch network statistics." }
      });
    }
  });

  fastify.get(
    "/public/coverage-map",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const mapData = await getCachedOrRun("dira:public:coverage-map", 300, async () => {
        const gridsRes = await query(
          `SELECT 
             floor(ST_X(location::geometry) / 0.05) * 0.05 AS grid_lon,
             floor(ST_Y(location::geometry) / 0.05) * 0.05 AS grid_lat,
             COUNT(*) AS density_count
           FROM (
             SELECT location FROM atmospheric_readings WHERE verified = TRUE AND recorded_at >= CURRENT_DATE - INTERVAL '30 days'
             UNION ALL
             SELECT location FROM crop_submissions WHERE verification_status = 'verified' AND submitted_at >= CURRENT_DATE - INTERVAL '30 days'
           ) AS combined_data
           GROUP BY grid_lon, grid_lat`
         );

         const activeCountiesRes = await query(
           `SELECT DISTINCT county FROM (
             SELECT DISTINCT county FROM farms f
             JOIN crop_submissions cs ON f.id = cs.farm_id
             WHERE cs.verification_status = 'verified' AND cs.submitted_at >= CURRENT_DATE - INTERVAL '30 days'
             UNION
             SELECT DISTINCT u.county FROM users u
             JOIN atmospheric_readings ar ON u.id = ar.user_id
             WHERE ar.verified = TRUE AND ar.recorded_at >= CURRENT_DATE - INTERVAL '30 days'
           ) AS active_counties WHERE county IS NOT NULL AND county <> ''`
         );

         const activeCounties = activeCountiesRes.rows.map((row: any) => row.county);
         const grids = gridsRes.rows.map((row: any) => ({
           lon: Number(row.grid_lon),
           lat: Number(row.grid_lat),
           density: Number(row.density_count)
         }));

         return { activeCounties, grids };
       });

       return { success: true, activeCounties: mapData.activeCounties, grids: mapData.grids };
     } catch (err: any) {
       fastify.log.error("Failed to generate coverage map:", err);
       return reply.status(500).send({
         success: false,
         error: { code: "SERVER_ERROR", message: "Failed to generate coverage map." }
       });
     }
   });

  fastify.get(
    "/public/circular-economy-summary",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const summary = await getCachedOrRun("dira:public:circular-economy-summary", 300, async () => {
        const airtimeRes = await query(
          `SELECT COALESCE(SUM(amount_kes), 0) AS total FROM redemption_requests WHERE redemption_type = 'airtime' AND status = 'completed' AND initiated_at >= CURRENT_DATE - INTERVAL '30 days'`
        );
        const vouchersRes = await query(
          `SELECT COALESCE(SUM(amount_kes), 0) AS total FROM redemption_requests WHERE redemption_type = 'voucher' AND status = 'completed'`
        );
        const circleRes = await query(
          `SELECT COALESCE(SUM(amount_kes), 0) AS total FROM redemption_requests WHERE redemption_type = 'circle' AND status = 'completed'`
        );
        const mpesaRes = await query(
          `SELECT COALESCE(SUM(amount_kes), 0) AS total FROM redemption_requests WHERE redemption_type = 'mpesa' AND status = 'completed'`
        );

        return {
          airtime30Days: Number(airtimeRes.rows[0]?.total || 0),
          vouchersAllTime: Number(vouchersRes.rows[0]?.total || 0),
          circleAllTime: Number(circleRes.rows[0]?.total || 0),
          mpesaAllTime: Number(mpesaRes.rows[0]?.total || 0)
        };
      });

      return { success: true, summary };
    } catch (err: any) {
      fastify.log.error("Failed to fetch circular economy summary:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to fetch circular economy statistics." }
      });
    }
  });

  fastify.get(
    "/public/activity-feed",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const activities = await getCachedOrRun("dira:public:activity-feed", 30, async () => {
        const res = await query(
          `SELECT timestamp, role, county, crop_type FROM (
             (
               SELECT cs.submitted_at AS timestamp, 'farmer' AS role, f.county, cs.crop_type 
               FROM crop_submissions cs 
               JOIN farms f ON cs.farm_id = f.id 
               WHERE cs.verification_status = 'verified'
               ORDER BY cs.submitted_at DESC LIMIT 10
             )
             UNION ALL
             (
               SELECT ar.recorded_at AS timestamp, 'agent' AS role, u.county, NULL::VARCHAR AS crop_type 
               FROM atmospheric_readings ar 
               JOIN users u ON ar.user_id = u.id 
               WHERE ar.verified = TRUE 
               ORDER BY ar.recorded_at DESC LIMIT 10
             )
           ) AS combined_activity
           ORDER BY timestamp DESC
           LIMIT 10`
        );

        return res.rows.map((row: any) => ({
          role: row.role,
          county: row.county,
          cropType: row.crop_type,
          timestamp: row.timestamp
        }));
      });

      return { success: true, activities };
    } catch (err: any) {
      fastify.log.error("Failed to fetch activity feed:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to fetch activity feed." }
      });
    }
  });

  fastify.get(
    "/public/quality-metrics",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const metrics = await getCachedOrRun("dira:public:quality-metrics", 3600, async () => {
        const res = await query(
          `SELECT 
             recorded_at::DATE AS day,
             COALESCE(COUNT(CASE WHEN verified = TRUE AND anomaly_score < 0.02 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS pct_high,
             COALESCE(COUNT(CASE WHEN verified = TRUE AND anomaly_score >= 0.02 AND anomaly_score <= 0.05 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS pct_medium,
             COALESCE(COUNT(CASE WHEN verified = FALSE OR anomaly_score > 0.05 THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS pct_low,
             COALESCE(COUNT(CASE WHEN network_consensus = TRUE THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0), 0) AS network_consensus_rate
           FROM atmospheric_readings
           WHERE recorded_at >= CURRENT_DATE - INTERVAL '30 days'
           GROUP BY day
           ORDER BY day ASC`
        );

        return res.rows.map((row: any) => ({
          day: new Date(row.day).toISOString().split("T")[0],
          pctHigh: Number(row.pct_high),
          pctMedium: Number(row.pct_medium),
          pctLow: Number(row.pct_low),
          networkConsensusRate: Number(row.network_consensus_rate)
        }));
      });

      return { success: true, metrics };
    } catch (err: any) {
      fastify.log.error("Failed to fetch quality metrics:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to fetch quality metrics." }
      });
    }
  });

  fastify.get(
    "/public/xion-anchors",
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: "1 minute",
          groupId: "public-group",
        } as any,
      },
    },
    async (request, reply) => {
    try {
      const anchors = await getCachedOrRun("dira:public:xion-anchors", 300, async () => {
        const res = await query(
          `SELECT week_number, batch_hash, xion_tx_hash, zkverify_proof_id, zkverify_tx_hash, anchored_at 
           FROM xion_anchors 
           ORDER BY week_number DESC LIMIT 5`
        );

        return res.rows.map((row: any) => ({
          weekNumber: row.week_number,
          batchHash: row.batch_hash.trim(),
          xionTxHash: row.xion_tx_hash,
          zkverifyProofId: row.zkverify_proof_id,
          zkverifyTxHash: row.zkverify_tx_hash,
          anchoredAt: row.anchored_at
        }));
      });

      return { success: true, anchors };
    } catch (err: any) {
      fastify.log.error("Failed to fetch XION anchors:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to fetch XION blockchain anchor updates." }
      });
    }
  });

  // GET /admin/jobs (root path option)
  fastify.get(
    "/admin/jobs",
    { onRequest: [fastify.authenticateAdmin] },
    async (request, reply) => {
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
        // Log action manually for public router option
        await query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent)
           VALUES ($1, $2, $3, NULL, $4, $5)`,
          [
            request.adminUser!.id,
            "view_jobs_root",
            "jobs",
            request.ip,
            request.headers["user-agent"] || null
          ]
        );

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

  // 4. GET /api/payments/:id/status - Polling endpoint for transaction status details
  fastify.get(
    "/api/payments/:id/status",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user.id;

      try {
        const res = await query(
          `SELECT id, status, amount_kes::float AS amount_kes, tokens_spent, initiated_at, completed_at, mpesa_receipt, failure_reason
           FROM redemption_requests
           WHERE id = $1 AND user_id = $2`,
          [id, userId]
        );

        if (res.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "NOT_FOUND", message: "Redemption request not found." }
          });
        }

        return {
          success: true,
          payment: res.rows[0]
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to fetch payment status." }
        });
      }
    }
  );
}

