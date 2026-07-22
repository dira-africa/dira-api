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
import { query } from "../db/query";
import { redis } from "../db/redis";
import { verifyPassword, hashPassword, isStrongPassword } from "../utils/password";
import { verifyTOTP } from "../utils/totpHelper";
import { enforceAdminIpAllowlist, getClientIp } from "../middleware/adminIpAllowlistMiddleware";

export default async function adminAuthRoutes(fastify: FastifyInstance) {
  // 1. Enforce IP allowlist on all routes inside this auth plugin
  fastify.addHook("preHandler", enforceAdminIpAllowlist);

  // Rate limit configurations: max 5 login requests per 15 minutes per IP
  const loginRateLimit = {
    max: 5,
    timeWindow: 15 * 60 * 1000,
    errorResponseBuilder: () => {
      const err = new Error("Too many login attempts. Please try again in 15 minutes.") as any;
      err.statusCode = 429;
      return err;
    }
  };

  // POST /login
  fastify.post<{ Body: { email?: string; password?: string; totpCode?: string } }>(
    "/login",
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      const email = request.body.email?.trim().toLowerCase();
      const password = request.body.password;
      const totpCode = request.body.totpCode;

      if (!email || !password) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_CREDENTIALS", message: "Email and password are required." }
        });
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      // Dummy hash for timing-safe comparison on non-existent users
      const dummyHash = "$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzdHJpbmc$Y1/n8qA7B5h47nU475U44U44U44U44U44U44U44U44U=";

      try {
        // Query user from admins table
        const adminRes = await query(
          `SELECT id, email, password_hash, role, status, must_change_password, failed_attempts, locked_until, totp_secret, totp_enabled 
           FROM admins WHERE email = $1`,
          [email]
        );

        const admin = adminRes.rows[0];

        // Check if account is currently locked
        if (admin && admin.locked_until) {
          const lockTime = new Date(admin.locked_until);
          if (lockTime > new Date()) {
            await query(
              `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
               VALUES ($1, 'LOGIN_LOCKED_ATTEMPT', $2, $3, $4)`,
              [admin.id, email, clientIp, userAgent]
            );

            return reply.status(401).send({
              success: false,
              error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." }
            });
          }
        }

        // Timing-safe password compare
        const hashToCompare = admin ? admin.password_hash : dummyHash;
        const isMatch = await verifyPassword(password, hashToCompare);

        if (!admin || !isMatch) {
          if (admin) {
            const nextFailed = admin.failed_attempts + 1;
            let lockDate: Date | null = null;
            if (nextFailed >= 5) {
              lockDate = new Date(Date.now() + 15 * 60 * 1000); // 15 mins lock
            }

            await query(
              "UPDATE admins SET failed_attempts = $1, locked_until = $2 WHERE id = $3",
              [nextFailed, lockDate, admin.id]
            );

            await query(
              `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
               VALUES ($1, 'LOGIN_FAILED', $2, $3, $4)`,
              [admin.id, email, clientIp, userAgent]
            );
          } else {
            await query(
              `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
               VALUES (NULL, 'LOGIN_INVALID_EMAIL', $1, $2, $3)`,
              [email, clientIp, userAgent]
            );
          }

          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." }
          });
        }

        // Check status
        if (admin.status === "disabled") {
          await query(
            `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
             VALUES ($1, 'LOGIN_DISABLED_STATUS', $2, $3, $4)`,
            [admin.id, email, clientIp, userAgent]
          );

          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." }
          });
        }

        // MFA challenge check
        if (admin.totp_enabled) {
          if (!totpCode) {
            // Issue a short-lived temp token for MFA validation (valid for 5 minutes)
            const mfaTempToken = fastify.jwt.admin.sign(
              { id: admin.id, role: admin.role, mfaPending: true } as any,
              { expiresIn: "5m" }
            );

            return {
              success: true,
              mfaRequired: true,
              tempToken: mfaTempToken
            };
          }

          const isValidTotp = verifyTOTP(totpCode, admin.totp_secret);
          if (!isValidTotp) {
            await query(
              `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
               VALUES ($1, 'LOGIN_MFA_FAILED', $2, $3, $4)`,
              [admin.id, email, clientIp, userAgent]
            );

            return reply.status(401).send({
              success: false,
              error: { code: "INVALID_MFA_CODE", message: "Invalid 2FA code." }
            });
          }
        }

        // Successful Login: reset lockout metrics
        await query(
          "UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = $1",
          [admin.id]
        );

        // Issue token
        const token = fastify.jwt.admin.sign(
          { id: admin.id, role: admin.role, login_at: Date.now() },
          { expiresIn: "24h" } // Absolute timeout in JWT, sliding in Redis
        );

        // Cache active session in Redis with 2 hours sliding window
        await redis.set(`dira:admin:session:${admin.id}`, "active", "EX", 7200);

        // Write audit log
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'LOGIN_SUCCESS', $2, $3, $4)`,
          [admin.id, email, clientIp, userAgent]
        );

        // Set httpOnly cookie
        reply.header(
          "Set-Cookie",
          `dira_admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
        );

        return {
          success: true,
          mustChangePassword: admin.must_change_password
        };
      } catch (err: any) {
        fastify.log.error(err, "Login route error:");
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: "Failed to authenticate login request." }
        });
      }
    }
  );

  // POST /mfa-verify - Complete MFA verification challenge
  fastify.post<{ Body: { code?: string; tempToken?: string } }>(
    "/mfa-verify",
    async (request, reply) => {
      const { code, tempToken } = request.body;

      if (!code || !tempToken) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_PARAMS", message: "MFA code and tempToken are required." }
        });
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      try {
        const decoded = await fastify.jwt.admin.verify<any>(tempToken);
        if (!decoded || decoded.type !== "mfa_pending") {
          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_TEMP_TOKEN", message: "Invalid or expired temporary session." }
          });
        }

        const adminRes = await query(
          "SELECT id, email, role, status, must_change_password, totp_secret FROM admins WHERE id = $1",
          [decoded.id]
        );
        const admin = adminRes.rows[0];

        if (!admin || admin.status === "disabled") {
          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_TEMP_TOKEN", message: "Invalid admin session." }
          });
        }

        const isValidTotp = verifyTOTP(code, admin.totp_secret);
        if (!isValidTotp) {
          await query(
            `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
             VALUES ($1, 'LOGIN_MFA_FAILED', $2, $3, $4)`,
            [admin.id, admin.email, clientIp, userAgent]
          );

          return reply.status(401).send({
            success: false,
            error: { code: "INVALID_MFA_CODE", message: "Invalid 2FA code." }
          });
        }

        // Reset lockout metrics
        await query(
          "UPDATE admins SET failed_attempts = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP WHERE id = $1",
          [admin.id]
        );

        // Sign final admin JWT
        const token = fastify.jwt.admin.sign(
          { id: admin.id, role: admin.role, login_at: Date.now() },
          { expiresIn: "24h" }
        );

        // Setup Redis session
        await redis.set(`dira:admin:session:${admin.id}`, "active", "EX", 7200);

        // Audit logging
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'LOGIN_SUCCESS_MFA', $2, $3, $4)`,
          [admin.id, admin.email, clientIp, userAgent]
        );

        // Set httpOnly cookie
        reply.header(
          "Set-Cookie",
          `dira_admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
        );

        return {
          success: true,
          mustChangePassword: admin.must_change_password
        };
      } catch (err: any) {
        fastify.log.error(err, "MFA verify error:");
        return reply.status(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "MFA validation expired or failed." }
        });
      }
    }
  );

  // POST /change-password
  fastify.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    "/change-password",
    { onRequest: [fastify.authenticateAdmin] },
    async (request, reply) => {
      const { oldPassword, newPassword } = request.body;

      if (!oldPassword || !newPassword) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_PARAMS", message: "Old password and new password are required." }
        });
      }

      if (!isStrongPassword(newPassword)) {
        return reply.status(400).send({
          success: false,
          error: {
            code: "WEAK_PASSWORD",
            message: "Password must be at least 12 characters and contain upper, lower, numbers, and symbols."
          }
        });
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const adminId = request.adminUser!.id;

      try {
        const adminRes = await query("SELECT password_hash, email FROM admins WHERE id = $1", [adminId]);
        const admin = adminRes.rows[0];

        const isMatch = await verifyPassword(oldPassword, admin.password_hash);
        if (!isMatch) {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_OLD_PASSWORD", message: "The old password you entered is incorrect." }
          });
        }

        const newHash = await hashPassword(newPassword);
        await query(
          "UPDATE admins SET password_hash = $1, must_change_password = false WHERE id = $2",
          [newHash, adminId]
        );

        // Log action
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'PASSWORD_CHANGE', $2, $3, $4)`,
          [adminId, admin.email, clientIp, userAgent]
        );

        return { success: true };
      } catch (err: any) {
        fastify.log.error(err, "Change password error:");
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: "Failed to update password." }
        });
      }
    }
  );

  // POST /logout
  fastify.post(
    "/logout",
    { onRequest: [fastify.authenticateAdmin] },
    async (request, reply) => {
      const adminId = request.adminUser!.id;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      try {
        const adminRes = await query("SELECT email FROM admins WHERE id = $1", [adminId]);
        const admin = adminRes.rows[0];

        // Delete Redis session activity key
        await redis.del(`dira:admin:session:${adminId}`);

        // Write log
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'LOGOUT', $2, $3, $4)`,
          [adminId, admin?.email || null, clientIp, userAgent]
        );

        // Delete httpOnly cookie by setting past Max-Age
        reply.header(
          "Set-Cookie",
          "dira_admin_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
        );

        return { success: true };
      } catch (err) {
        fastify.log.error(err, "Logout route error:");
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: "Failed to logout session." }
        });
      }
    }
  );

  // GET /me
  fastify.get(
    "/me",
    { onRequest: [fastify.authenticateAdmin] },
    async (request, reply) => {
      const adminId = request.adminUser!.id;
      try {
        const adminRes = await query(
          "SELECT id, email, name, role, must_change_password, totp_enabled FROM admins WHERE id = $1",
          [adminId]
        );
        const admin = adminRes.rows[0];

        if (!admin) {
          return reply.status(404).send({
            success: false,
            error: { code: "NOT_FOUND", message: "Admin account not found." }
          });
        }

        return {
          success: true,
          admin
        };
      } catch (err) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: "Failed to retrieve profile." }
        });
      }
    }
  );
}
