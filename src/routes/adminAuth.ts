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
import bcryptjs from "bcryptjs";
import { query } from "../db/query";
import { redis } from "../db/redis";

export default async function adminAuthRoutes(fastify: FastifyInstance) {
  // POST /admin/auth/login - Gated by IP-based rate limiting (5 requests per 15 minutes)
  fastify.post<{ Body: { email?: string; password?: string } }>(
    "/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 15 * 60 * 1000,
          errorResponseBuilder: () => {
            const err = new Error("Too many login attempts from this IP. Please try again in 15 minutes.") as any;
            err.statusCode = 429;
            return err;
          }
        }
      }
    },
    async (request, reply) => {
      const email = request.body.email?.trim().toLowerCase();
      const password = request.body.password;

      if (!email || !password) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_CREDENTIALS", message: "Email and password are required." }
        });
      }

      // Dummy hash to execute timing-safe comparison if email is not registered
      const dummyHash = "$2a$12$LRY2X3x2o9l3.0Xo5y.66.a4B71Dq36mQ0L/RkM44o17.Lp9s9l3e";

      try {
        // Retrieve admin account
        const userRes = await query(
          "SELECT id, password_hash, role, failed_login_attempts, locked_until FROM users WHERE email = $1 AND role = 'admin'",
          [email]
        );

        const user = userRes.rows[0];

        // Check account lock timer status
        if (user && user.locked_until) {
          const lockedUntilDate = new Date(user.locked_until);
          if (lockedUntilDate > new Date()) {
            // Write locked account audit try
            await query(
              `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                user.id,
                "admin_login_locked_attempt",
                "users",
                user.id,
                request.ip,
                request.headers["user-agent"] || null,
                JSON.stringify({ email })
              ]
            );

            return reply.status(401).send({
              success: false,
              error: { code: "ACCOUNT_LOCKED", message: "This account is locked. Please try again in 30 minutes." }
            });
          }
        }

        // timing-safe bcrypt compare
        const hashToCompare = user ? user.password_hash : dummyHash;
        const passwordMatches = await bcryptjs.compare(password, hashToCompare);

        if (!user || !passwordMatches) {
          if (user) {
            const newFailedAttempts = user.failed_login_attempts + 1;
            let lockedUntil: Date | null = null;
            if (newFailedAttempts >= 5) {
              lockedUntil = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes lockout
            }

            await query(
              "UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3",
              [newFailedAttempts, lockedUntil, user.id]
            );

            await query(
              `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                user.id,
                "admin_login_failure",
                "users",
                user.id,
                request.ip,
                request.headers["user-agent"] || null,
                JSON.stringify({ email, failed_attempts: newFailedAttempts, locked: newFailedAttempts >= 5 })
              ]
            );
          } else {
            // Non-existent email log
            await query(
              `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
               VALUES (NULL, $1, $2, NULL, $3, $4, $5)`,
              [
                "admin_login_invalid_email",
                "users",
                request.ip,
                request.headers["user-agent"] || null,
                JSON.stringify({ email })
              ]
            );
          }

          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." }
          });
        }

        // Successful Login: reset lockout metrics
        await query(
          "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_seen_at = CURRENT_TIMESTAMP WHERE id = $1",
          [user.id]
        );

        // Issue short-lived admin JWT (2 hours) using the admin namespace
        const token = fastify.jwt.admin.sign(
          { id: user.id, role: user.role },
          { expiresIn: "2h" }
        );

        // Cache session status in Redis (2 hours TTL) for inactivity checks
        await redis.set(`dira:admin:session:${user.id}`, "active", "EX", 7200);

        // Log success
        await query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            user.id,
            "admin_login_success",
            "users",
            user.id,
            request.ip,
            request.headers["user-agent"] || null,
            JSON.stringify({ email })
          ]
        );

        return {
          success: true,
          token
        };
      } catch (err: any) {
        fastify.log.error("Admin login error:", err);
        console.error("Admin login error details:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: "Internal server error during login." }
        });
      }
    }
  );
}
