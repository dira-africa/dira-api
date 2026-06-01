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
import { tokenService } from "../services/tokenService";

interface AtmosphericSubmitBody {
  pressure_hpa: number;
  altitude_m: number;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  sensor_type: string;
  timestamp: string;
  temperature_c?: number;
  humidity_pct?: number;
}

export default async function atmosphericRoutes(fastify: FastifyInstance) {
  
  fastify.post<{ Body: AtmosphericSubmitBody }>(
    "/submit",
    { onRequest: [fastify.authenticate, fastify.requireRole(["agent"])] },
    async (request, reply) => {
      const userId = request.user.id;
      const {
        pressure_hpa,
        altitude_m,
        latitude,
        longitude,
        accuracy_m,
        sensor_type,
        timestamp,
        temperature_c,
        humidity_pct
      } = request.body;

      // 1. Physical validation: pressure_hpa must be 870–1084 hPa
      if (pressure_hpa < 870 || pressure_hpa > 1084) {
        return reply.status(422).send({
          success: false,
          error: {
            code: "PRESSURE_OUT_OF_RANGE",
            message: "Pressure reading must be between 870 and 1084 hPa."
          }
        });
      }

      // 2. Geographic validation: GPS must be within Kenya bounding box
      // (lat -4.67 to 4.62, lon 33.9 to 41.9)
      if (latitude < -4.67 || latitude > 4.62 || longitude < 33.9 || longitude > 41.9) {
        return reply.status(422).send({
          success: false,
          error: {
            code: "LOCATION_OUTSIDE_KENYA",
            message: "GPS location must be within Kenya bounding box."
          }
        });
      }

      try {
        // 3. Daily submission limit (rate limit): max 4 submissions per day per user
        const todaySyncsRes = await query(
          `SELECT COUNT(*) AS count 
           FROM atmospheric_readings 
           WHERE user_id = $1 AND recorded_at >= CURRENT_DATE`,
          [userId]
        );
        const syncsCount = Number(todaySyncsRes.rows[0].count);

        if (syncsCount >= 4) {
          return reply.status(429).send({
            success: false,
            error: {
              code: "DAILY_LIMIT_REACHED",
              message: "Maximum 4 sync submissions per day per user."
            }
          });
        }

        const recordedAtDate = new Date(timestamp || new Date());
        const tempVal = temperature_c !== undefined ? temperature_c : 20.0;
        const humVal = humidity_pct !== undefined ? humidity_pct : 60.0;

        // 4. Save to atmospheric_readings table
        const insertRes = await query(
          `INSERT INTO atmospheric_readings (
            user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified
          ) VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7, $8, FALSE)
          RETURNING id`,
          [userId, longitude, latitude, pressure_hpa, altitude_m, tempVal, humVal, recordedAtDate]
        );
        
        const readingId = insertRes.rows[0].id;

        // 5. Credit 1 pending token
        await tokenService.awardTokens(
          userId,
          1,
          "pending",
          "atmospheric_sync",
          readingId
        );

        // 6. Dispatch BullMQ atmospheric-verification job
        await fastify.atmosphericVerificationQueue.add("atmospheric-verification", {
          readingId,
          userId,
          pressureHpa: pressure_hpa,
          altitudeM: altitude_m,
          temperatureC: tempVal,
          humidityPct: humVal,
          latitude,
          longitude,
          recordedAt: recordedAtDate.toISOString()
        });

        return {
          success: true,
          message: "Sync submitted. Verification in progress.",
          readingId
        };
      } catch (err: any) {
        fastify.log.error("Failed to submit atmospheric sync:", err);
        return reply.status(500).send({
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: err.message || "Failed to submit atmospheric reading."
          }
        });
      }
    }
  );
}
