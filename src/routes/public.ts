import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  midnightAnchorQueue
} from "../jobs/queues";

export default async function publicRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (request, reply) => {
    return {
      status: "ok",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get("/public/coverage-map", async (request, reply) => {
    try {
      const res = await query(
        `SELECT 
           floor(ST_X(location::geometry) / 0.1) * 0.1 AS grid_lon,
           floor(ST_Y(location::geometry) / 0.1) * 0.1 AS grid_lat,
           COUNT(*) AS sync_count
         FROM atmospheric_readings
         WHERE verified = TRUE AND recorded_at >= CURRENT_DATE - INTERVAL '7 days'
         GROUP BY grid_lon, grid_lat`
      );

      const features = res.rows.map((row: any) => {
        const gridLon = Number(row.grid_lon);
        const gridLat = Number(row.grid_lat);
        const syncCount = Number(row.sync_count);
        return {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [gridLon, gridLat],
                [gridLon + 0.1, gridLat],
                [gridLon + 0.1, gridLat + 0.1],
                [gridLon, gridLat + 0.1],
                [gridLon, gridLat]
              ]
            ]
          },
          properties: {
            syncCount,
            density: syncCount > 10 ? "high" : syncCount > 3 ? "medium" : "low"
          }
        };
      });

      return {
        type: "FeatureCollection",
        features
      };
    } catch (err: any) {
      fastify.log.error("Failed to generate public coverage map GeoJSON:", err);
      return reply.status(500).send({
        success: false,
        error: { code: "SERVER_ERROR", message: "Failed to generate coverage map." }
      });
    }
  });

  // GET /admin/jobs (root path option)
  fastify.get(
    "/admin/jobs",
    { onRequest: [fastify.authenticate, fastify.requireRole(["admin"])] },
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
}

