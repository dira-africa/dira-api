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
import { agentSyncService } from "../services/agentSyncService";
import { redis } from "../db/redis";

function anonymizeName(fullName: string | null, telegramUsername: string | null): string {
  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      const lastInitial = parts[parts.length - 1][0].toUpperCase();
      return `${parts[0]} ${lastInitial}.`;
    }
    return fullName;
  }
  if (telegramUsername) {
    return `@${telegramUsername}`;
  }
  return "Agent X";
}

interface AgentProfileBody {
  fullName: string;
  county: string;
  latitude: number;
  longitude: number;
  coverageRadiusKm: number;
  deviceModel?: string;
}

interface BarometricDataPoint {
  pressureHpa: number;
  altitudeM: number;
  temperatureC: number;
  humidityPct: number;
  latitude: number;
  longitude: number;
  recordedAt: string; // ISO datetime string
}

interface BarometricSyncBody {
  readings: BarometricDataPoint[];
}

export default async function agentsRoutes(fastify: FastifyInstance) {
  
  // 1. GET /api/agents/profile - Retrieve agent profile
  fastify.get(
    "/profile",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const res = await query(
          `SELECT u.full_name, u.county, ap.coverage_radius_km, ap.device_model, ap.is_certified, ap.certified_at,
                  ST_X(ap.coverage_center::geometry) AS longitude, ST_Y(ap.coverage_center::geometry) AS latitude
           FROM users u 
           JOIN agent_profiles ap ON u.id = ap.user_id 
           WHERE u.id = $1`,
          [userId]
        );

        if (res.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "PROFILE_NOT_FOUND", message: "Agent profile not found." }
          });
        }

        return { success: true, profile: res.rows[0] };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve agent profile." }
        });
      }
    }
  );

  // 2. POST /api/agents/profile - Register or update agent profile
  fastify.post<{ Body: AgentProfileBody }>(
    "/profile",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      const { fullName, county, latitude, longitude, coverageRadiusKm, deviceModel } = request.body;

      if (!fullName || !county || latitude === undefined || longitude === undefined || !coverageRadiusKm) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "All profile fields are required." }
        });
      }

      try {
        // Update user's name and county in database
        await query(
          "UPDATE users SET full_name = $1, county = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [fullName, county, userId]
        );

        // Check if agent profile already exists for this user
        const profileRes = await query("SELECT id FROM agent_profiles WHERE user_id = $1", [userId]);

        if (profileRes.rows.length > 0) {
          await query(
            `UPDATE agent_profiles 
             SET coverage_center = ST_SetSRID(ST_MakePoint($1, $2), 4326), 
                 coverage_radius_km = $3, 
                 device_model = $4,
                 created_at = CURRENT_TIMESTAMP
             WHERE user_id = $5`,
            [longitude, latitude, coverageRadiusKm, deviceModel || null, userId]
          );
        } else {
          await query(
            `INSERT INTO agent_profiles (user_id, coverage_center, coverage_radius_km, device_model) 
             VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5)`,
            [userId, longitude, latitude, coverageRadiusKm, deviceModel || null]
          );
        }

        return {
          success: true,
          user: {
            id: userId,
            name: fullName,
            role: "agent",
            isNewUser: false
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to save agent profile." }
        });
      }
    }
  );

  // 3. POST /api/agents/barometric-sync - Ingest weather readings and perform triangulation
  fastify.post<{ Body: BarometricSyncBody }>(
    "/barometric-sync",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      const { readings } = request.body;

      if (!readings || !Array.isArray(readings) || readings.length === 0) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_READINGS", message: "A non-empty array of readings is required." }
        });
      }

      try {
        const result = await agentSyncService.processSyncBatch(userId, readings);
        return result;
      } catch (err: any) {
        console.error("Barometric sync processing failed:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to process barometric sync." }
        });
      }
    }
  );

  // 4. GET /api/agents/sync-stats - Retrieve daily sync progress and total readings
  fastify.get(
    "/sync-stats",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        // Count syncs rewarded today (limit is 4)
        const dailySyncsRes = await query(
          `SELECT COUNT(*) AS syncs_today 
           FROM token_ledger 
           WHERE user_id = $1 
             AND transaction_type = 'atmospheric_sync' 
             AND created_at >= CURRENT_DATE`,
          [userId]
        );
        const syncsToday = Number(dailySyncsRes.rows[0].syncs_today);

        // Count total readings and verified readings
        const totalsRes = await query(
          `SELECT COUNT(*) AS total_readings, 
                  COUNT(*) FILTER (WHERE verified = TRUE) AS verified_readings 
           FROM atmospheric_readings 
           WHERE user_id = $1`,
          [userId]
        );
        const totalReadings = Number(totalsRes.rows[0].total_readings);
        const verifiedReadings = Number(totalsRes.rows[0].verified_readings);

        // Get last sync time today
        const lastSyncRes = await query(
          `SELECT max(recorded_at) AS last_sync_time
           FROM atmospheric_readings
           WHERE user_id = $1 AND verified = TRUE AND recorded_at >= CURRENT_DATE`,
          [userId]
        );
        const lastSyncTime = lastSyncRes.rows[0]?.last_sync_time || null;

        // Get certification status and days
        const certRes = await query(
          `SELECT is_certified, certified_at FROM agent_profiles WHERE user_id = $1`,
          [userId]
        );
        const isCertified = certRes.rows[0]?.is_certified || false;
        const certifiedAt = certRes.rows[0]?.certified_at || null;

        const consistentDaysRes = await query(
          `SELECT COUNT(DISTINCT DATE(recorded_at)) AS consistent_days
           FROM atmospheric_readings
           WHERE user_id = $1 AND verified = TRUE`,
          [userId]
        );
        const consistentSyncDays = Number(consistentDaysRes.rows[0]?.consistent_days || 0);

        // Get county leaderboard rank this week
        const rankRes = await query(
          `WITH agent_weekly_syncs AS (
             SELECT u.id AS user_id, COUNT(ar.id) AS sync_count
             FROM users u
             JOIN agent_profiles ap ON u.id = ap.user_id
             LEFT JOIN atmospheric_readings ar ON u.id = ar.user_id 
               AND ar.verified = TRUE
               AND ar.recorded_at >= date_trunc('week', CURRENT_DATE)
             WHERE u.county = (SELECT county FROM users WHERE id = $1)
             GROUP BY u.id
           ),
           ranked_agents AS (
             SELECT user_id, sync_count,
                    RANK() OVER (ORDER BY sync_count DESC, user_id) AS rank
             FROM agent_weekly_syncs
           )
           SELECT rank FROM ranked_agents WHERE user_id = $1`,
          [userId]
        );
        const countyRank = Number(rankRes.rows[0]?.rank || 1);

        const totalAgentsRes = await query(
          `SELECT COUNT(*) AS total_agents
           FROM users u
           JOIN agent_profiles ap ON u.id = ap.user_id
           WHERE u.county = (SELECT county FROM users WHERE id = $1)`,
          [userId]
        );
        const countyTotalAgents = Number(totalAgentsRes.rows[0]?.total_agents || 1);

        // Get sync earnings (today, this week, all-time)
        const earningsRes = await query(
          `SELECT 
             COALESCE(SUM(amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today,
             COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE)), 0) AS week,
             COALESCE(SUM(amount), 0) AS all_time
           FROM token_ledger
           WHERE user_id = $1 AND transaction_type = 'atmospheric_sync'`,
          [userId]
        );
        const earningsToday = Number(earningsRes.rows[0]?.today || 0);
        const earningsThisWeek = Number(earningsRes.rows[0]?.week || 0);
        const earningsAllTime = Number(earningsRes.rows[0]?.all_time || 0);

        return {
          success: true,
          syncsToday,
          totalReadingsSynced: totalReadings,
          verifiedReadingsSynced: verifiedReadings,
          nextSyncScheduledInMs: 21600000, // 6 hours scheduled background interval
          lastSyncTime,
          isCertified,
          certifiedAt,
          consistentSyncDays,
          countyRank,
          countyTotalAgents,
          earningsToday,
          earningsThisWeek,
          earningsAllTime
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve sync stats." }
        });
      }
    }
  );

  // 5. GET /api/agents/recent-syncs - Retrieve sync locations from last 7 days
  fastify.get(
    "/recent-syncs",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const res = await query(
          `SELECT id, ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude, recorded_at, verified
           FROM atmospheric_readings
           WHERE user_id = $1 AND recorded_at >= CURRENT_DATE - INTERVAL '7 days'
           ORDER BY recorded_at DESC`,
          [userId]
        );
        return { success: true, syncs: res.rows };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve recent sync locations." }
        });
      }
    }
  );

  // 6. GET /api/agents/sync-history - Retrieve sync history and streak
  fastify.get(
    "/sync-history",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        // Query today's syncs
        const todaySyncsRes = await query(
          `SELECT id, pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified, network_consensus, anomaly_score
           FROM atmospheric_readings
           WHERE user_id = $1 AND recorded_at >= CURRENT_DATE
           ORDER BY recorded_at DESC`,
          [userId]
        );

        // Calculate streak
        const streakRes = await query(
          `SELECT DISTINCT DATE(recorded_at) AS sync_date
           FROM atmospheric_readings
           WHERE user_id = $1 AND verified = TRUE
           ORDER BY sync_date DESC`,
          [userId]
        );

        let streak = 0;
        if (streakRes.rows.length > 0) {
          const dates = streakRes.rows.map((r: any) => {
            const d = new Date(r.sync_date);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
          });

          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          yesterday.setHours(0, 0, 0, 0);

          const hasToday = dates.includes(today.getTime());
          const hasYesterday = dates.includes(yesterday.getTime());

          if (hasToday || hasYesterday) {
            let checkDate = hasToday ? today : yesterday;
            while (true) {
              if (dates.includes(checkDate.getTime())) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
              } else {
                break;
              }
            }
          }
        }

        return {
          success: true,
          syncsToday: todaySyncsRes.rows,
          streak
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve sync history." }
        });
      }
    }
  );

  // 7. GET /api/agents/leaderboard - Retrieve weekly county, all-counties, or all-time leaderboard
  fastify.get(
    "/leaderboard",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      const queryParams = request.query as { scope?: string; county?: string };
      const scope = queryParams.scope || "all"; // "county" | "all" | "all-time"
      const countyFilter = queryParams.county || null;

      const cacheKey = `dira:leaderboard:${scope}:${countyFilter || "all"}`;

      // Try reading from Redis cache
      if (redis.status === "ready") {
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            return JSON.parse(cached);
          }
        } catch (err) {
          fastify.log.warn(err, "Redis read failure during leaderboard query");
        }
      }

      try {
        let res;
        if (scope === "county") {
          // If no county specified, query user's county
          let targetCounty = countyFilter;
          if (!targetCounty) {
            const userRes = await query("SELECT county FROM users WHERE id = $1", [userId]);
            targetCounty = userRes.rows[0]?.county || "Nairobi";
          }

          res = await query(
            `SELECT 
               u.id AS user_id,
               u.full_name,
               u.telegram_username,
               u.county,
               COUNT(ar.id) AS syncs,
               COALESCE(SUM(tl.amount), 0) AS tokens
             FROM users u
             JOIN agent_profiles ap ON u.id = ap.user_id
             LEFT JOIN atmospheric_readings ar ON u.id = ar.user_id 
               AND ar.verified = TRUE 
               AND ar.recorded_at >= date_trunc('week', CURRENT_DATE)
             LEFT JOIN token_ledger tl ON u.id = tl.user_id 
               AND tl.transaction_type = 'atmospheric_sync'
               AND tl.created_at >= date_trunc('week', CURRENT_DATE)
             WHERE u.county = $1
             GROUP BY u.id
             ORDER BY syncs DESC, tokens DESC, u.id`,
            [targetCounty]
          );
        } else if (scope === "all-time") {
          res = await query(
            `SELECT 
               u.id AS user_id,
               u.full_name,
               u.telegram_username,
               u.county,
               COUNT(ar.id) AS syncs,
               COALESCE(SUM(tl.amount), 0) AS tokens
             FROM users u
             JOIN agent_profiles ap ON u.id = ap.user_id
             LEFT JOIN atmospheric_readings ar ON u.id = ar.user_id 
               AND ar.verified = TRUE
             LEFT JOIN token_ledger tl ON u.id = tl.user_id 
               AND tl.transaction_type = 'atmospheric_sync'
             GROUP BY u.id
             ORDER BY syncs DESC, tokens DESC, u.id`
          );
        } else {
          // "all" - syncs this week across all counties
          res = await query(
            `SELECT 
               u.id AS user_id,
               u.full_name,
               u.telegram_username,
               u.county,
               COUNT(ar.id) AS syncs,
               COALESCE(SUM(tl.amount), 0) AS tokens
             FROM users u
             JOIN agent_profiles ap ON u.id = ap.user_id
             LEFT JOIN atmospheric_readings ar ON u.id = ar.user_id 
               AND ar.verified = TRUE 
               AND ar.recorded_at >= date_trunc('week', CURRENT_DATE)
             LEFT JOIN token_ledger tl ON u.id = tl.user_id 
               AND tl.transaction_type = 'atmospheric_sync'
               AND tl.created_at >= date_trunc('week', CURRENT_DATE)
             GROUP BY u.id
             ORDER BY syncs DESC, tokens DESC, u.id`
          );
        }

        const leaderboard = res.rows.map((row: any, idx: number) => ({
          rank: idx + 1,
          userId: row.user_id,
          name: anonymizeName(row.full_name, row.telegram_username),
          county: row.county,
          syncs: Number(row.syncs),
          tokens: Number(row.tokens)
        }));

        const result = {
          success: true,
          scope,
          leaderboard
        };

        // Cache results in Redis for 6 hours
        if (redis.status === "ready") {
          try {
            await redis.set(cacheKey, JSON.stringify(result), "EX", 21600);
          } catch (err) {
            fastify.log.warn(err, "Redis write failure during leaderboard query");
          }
        }

        return result;

      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve leaderboard." }
        });
      }
    }
  );
}


