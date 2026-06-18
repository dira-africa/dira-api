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
import { env } from "../config/env";

export default async function usersRoutes(fastify: FastifyInstance) {
  // 1. POST /api/users/me/delete-request
  fastify.post(
    "/me/delete-request",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      
      try {
        await query(
          "UPDATE users SET delete_requested_at = CURRENT_TIMESTAMP WHERE id = $1",
          [userId]
        );
        return {
          success: true,
          message: "Account scheduled for deletion in 30 days."
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to submit delete request." }
        });
      }
    }
  );

  // 2. GET /api/users/me/export
  fastify.get(
    "/me/export",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;

      try {
        const userRes = await query(
          `SELECT id, telegram_id, telegram_username, 
                  CASE WHEN phone_number IS NOT NULL THEN pgp_sym_decrypt(phone_number::bytea, $1) ELSE NULL END AS phone_number,
                  full_name, role, language, county, is_verified, is_active, 
                  created_at, privacy_policy_accepted_at, delete_requested_at
           FROM users WHERE id = $2`,
          [env.PGCRYPTO_SYMMETRIC_KEY, userId]
        );

        if (userRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "USER_NOT_FOUND", message: "User not found." }
          });
        }

        const profile = userRes.rows[0];

        // Fetch token ledger history
        const tokenRes = await query(
          `SELECT id, amount, balance_after, transaction_type, reference_id, notes, created_at
           FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId]
        );

        // Fetch crop submissions
        const submissionsRes = await query(
          `SELECT id, farm_id, photo_url, photo_thumbnail_url, ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude,
                  crop_type, growth_stage, ai_health_score, ai_detected_issues, ai_confidence, 
                  ai_report_en, ai_report_sw, verification_status, rejection_reason, submitted_at, verified_at
           FROM crop_submissions WHERE user_id = $1 ORDER BY submitted_at DESC`,
          [userId]
        );

        // Fetch atmospheric readings
        const readingsRes = await query(
          `SELECT id, ST_X(location::geometry) AS longitude, ST_Y(location::geometry) AS latitude,
                  pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified, 
                  anomaly_score, openmeteo_reference_hpa, network_consensus, created_at
           FROM atmospheric_readings WHERE user_id = $1 ORDER BY recorded_at DESC`,
          [userId]
        );

        return {
          success: true,
          export: {
            profile,
            token_history: tokenRes.rows,
            submissions: submissionsRes.rows,
            sync_history: readingsRes.rows
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "EXPORT_FAILED", message: err.message || "Failed to export data." }
        });
      }
    }
  );
}
