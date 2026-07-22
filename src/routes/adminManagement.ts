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
import { hashPassword, isStrongPassword } from "../utils/password";
import { generateTOTPSecret, generateTOTPUri, verifyTOTP } from "../utils/totpHelper";
import { maskIp, ipMatchesCidr } from "../utils/ipCheck";
import { enforceAdminIpAllowlist, getClientIp } from "../middleware/adminIpAllowlistMiddleware";
import crypto from "crypto";

export default async function adminManagementRoutes(fastify: FastifyInstance) {
  // 1. Enforce IP allowlist on all management routes
  fastify.addHook("preHandler", enforceAdminIpAllowlist);
  // 2. Enforce admin auth on all management routes
  fastify.addHook("onRequest", fastify.authenticateAdmin);

  // ==============================
  // ADMIN USER MANAGEMENT
  // ==============================

  // GET /admin/management/admins — List all admins (superadmin only)
  fastify.get(
    "/admins",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      try {
        const res = await query(
          `SELECT id, email, name, role, status, must_change_password, last_login_at, totp_enabled, created_at
           FROM admins ORDER BY created_at ASC`
        );
        return { success: true, admins: res.rows };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to list admins." } });
      }
    }
  );

  // POST /admin/management/admins — Create a new admin
  fastify.post<{ Body: { email?: string; name?: string; role?: string; password?: string } }>(
    "/admins",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { email, name, role, password } = request.body;

      if (!email || !name || !role || !password) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_PARAMS", message: "email, name, role, and password are required." }
        });
      }

      if (!["admin", "editor"].includes(role)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_ROLE", message: "Role must be 'admin' or 'editor'." }
        });
      }

      if (!isStrongPassword(password)) {
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
      const actorId = request.adminUser!.id;

      try {
        const pwdHash = await hashPassword(password);
        const res = await query(
          `INSERT INTO admins (email, password_hash, name, role, status, must_change_password, created_by)
           VALUES ($1, $2, $3, $4, 'active', true, $5) RETURNING id, email, name, role, status`,
          [email.trim().toLowerCase(), pwdHash, name.trim(), role, actorId]
        );

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'ADMIN_CREATED', $2, $3, $4)`,
          [actorId, email.trim().toLowerCase(), clientIp, userAgent]
        );

        return reply.status(201).send({ success: true, admin: res.rows[0] });
      } catch (err: any) {
        if (err.code === "23505") {
          return reply.status(409).send({
            success: false,
            error: { code: "EMAIL_EXISTS", message: "An admin with this email already exists." }
          });
        }
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to create admin." } });
      }
    }
  );

  // PATCH /admin/management/admins/:id/status — Disable or re-enable an admin
  fastify.patch<{ Params: { id: string }; Body: { status?: string } }>(
    "/admins/:id/status",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const { status } = request.body;

      if (!status || !["active", "disabled"].includes(status)) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_STATUS", message: "Status must be 'active' or 'disabled'." }
        });
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        // Never allow disabling the last active superadmin
        if (status === "disabled") {
          const targetRes = await query("SELECT role FROM admins WHERE id = $1", [id]);
          const target = targetRes.rows[0];

          if (target?.role === "superadmin") {
            const countRes = await query(
              "SELECT COUNT(*) AS count FROM admins WHERE role = 'superadmin' AND status = 'active'"
            );
            if (parseInt(countRes.rows[0].count, 10) <= 1) {
              return reply.status(409).send({
                success: false,
                error: {
                  code: "LAST_SUPERADMIN",
                  message: "Cannot disable the last active superadmin. Create another superadmin first."
                }
              });
            }
          }
        }

        const res = await query(
          "UPDATE admins SET status = $1 WHERE id = $2 RETURNING id, email, status",
          [status, id]
        );

        if (res.rowCount === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Admin not found." } });
        }

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, $2, $3, $4, $5)`,
          [actorId, status === "disabled" ? "ADMIN_DISABLED" : "ADMIN_ENABLED", id, clientIp, userAgent]
        );

        return { success: true, admin: res.rows[0] };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to update admin status." } });
      }
    }
  );

  // POST /admin/management/admins/:id/reset-password — Force password reset
  fastify.post<{ Params: { id: string }; Body: { temporaryPassword?: string } }>(
    "/admins/:id/reset-password",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const tempPassword = request.body.temporaryPassword || crypto.randomBytes(12).toString("base64").slice(0, 16) + "!A1";

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        const pwdHash = await hashPassword(tempPassword);
        await query(
          "UPDATE admins SET password_hash = $1, must_change_password = true WHERE id = $2",
          [pwdHash, id]
        );

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'ADMIN_PASSWORD_RESET', $2, $3, $4)`,
          [actorId, id, clientIp, userAgent]
        );

        return { success: true, temporaryPassword: tempPassword };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to reset password." } });
      }
    }
  );

  // DELETE /admin/management/admins/:id — Remove an admin
  fastify.delete<{ Params: { id: string } }>(
    "/admins/:id",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        // Prevent deleting the last active superadmin
        const targetRes = await query("SELECT role, status FROM admins WHERE id = $1", [id]);
        const target = targetRes.rows[0];

        if (!target) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Admin not found." } });
        }

        if (target.role === "superadmin" && target.status === "active") {
          const countRes = await query(
            "SELECT COUNT(*) AS count FROM admins WHERE role = 'superadmin' AND status = 'active'"
          );
          if (parseInt(countRes.rows[0].count, 10) <= 1) {
            return reply.status(409).send({
              success: false,
              error: { code: "LAST_SUPERADMIN", message: "Cannot remove the last active superadmin." }
            });
          }
        }

        await query("DELETE FROM admins WHERE id = $1", [id]);

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'ADMIN_DELETED', $2, $3, $4)`,
          [actorId, id, clientIp, userAgent]
        );

        return { success: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to delete admin." } });
      }
    }
  );

  // ==============================
  // TOTP 2FA MANAGEMENT
  // ==============================

  // POST /admin/management/me/totp/setup — Generate TOTP secret and QR code uri
  fastify.post(
    "/me/totp/setup",
    async (request, reply) => {
      const adminId = request.adminUser!.id;
      try {
        const adminRes = await query("SELECT email FROM admins WHERE id = $1", [adminId]);
        const admin = adminRes.rows[0];
        if (!admin) return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Admin not found." } });

        const secret = generateTOTPSecret();
        await query("UPDATE admins SET totp_secret = $1, totp_enabled = false WHERE id = $2", [secret, adminId]);

        const uri = generateTOTPUri(admin.email, secret);
        return { success: true, secret, uri };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to setup TOTP." } });
      }
    }
  );

  // POST /admin/management/me/totp/verify — Confirm TOTP secret by verifying first code
  fastify.post<{ Body: { code?: string } }>(
    "/me/totp/verify",
    async (request, reply) => {
      const { code } = request.body;
      const adminId = request.adminUser!.id;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      if (!code) {
        return reply.status(400).send({ success: false, error: { code: "MISSING_PARAMS", message: "TOTP code required." } });
      }

      try {
        const adminRes = await query("SELECT email, totp_secret FROM admins WHERE id = $1", [adminId]);
        const admin = adminRes.rows[0];
        if (!admin?.totp_secret) return reply.status(400).send({ success: false, error: { code: "NOT_SETUP", message: "TOTP not initialized." } });

        if (!verifyTOTP(code, admin.totp_secret)) {
          return reply.status(400).send({ success: false, error: { code: "INVALID_CODE", message: "TOTP code is incorrect." } });
        }

        await query("UPDATE admins SET totp_enabled = true WHERE id = $1", [adminId]);

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'TOTP_ENABLED', $2, $3, $4)`,
          [adminId, admin.email, clientIp, userAgent]
        );

        return { success: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to verify TOTP." } });
      }
    }
  );

  // ==============================
  // IP ALLOWLIST MANAGEMENT
  // ==============================

  // GET /admin/management/ip-allowlist — List entries (IPs masked)
  fastify.get(
    "/ip-allowlist",
    async (request, reply) => {
      try {
        const res = await query(
          "SELECT id, label, active, created_at, cidr FROM admin_ip_allowlist ORDER BY created_at ASC"
        );

        // Always return masked IPs in the list view
        const masked = res.rows.map((r) => ({
          ...r,
          cidr: maskIp(r.cidr)
        }));

        return { success: true, entries: masked };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to list allowlist." } });
      }
    }
  );

  // POST /admin/management/ip-allowlist/reveal/:id — Reveal unmasked IP (superadmin only, audit logged)
  fastify.post<{ Params: { id: string } }>(
    "/ip-allowlist/reveal/:id",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        const res = await query("SELECT id, cidr, label FROM admin_ip_allowlist WHERE id = $1", [id]);
        const entry = res.rows[0];

        if (!entry) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Allowlist entry not found." } });
        }

        // Log every reveal in audit
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'IP_ALLOWLIST_REVEAL', $2, $3, $4)`,
          [actorId, `allowlist:${id}`, clientIp, userAgent]
        );

        return { success: true, cidr: entry.cidr, label: entry.label };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to reveal allowlist entry." } });
      }
    }
  );

  // POST /admin/management/ip-allowlist — Add a CIDR entry
  fastify.post<{ Body: { cidr?: string; label?: string; confirmed?: boolean } }>(
    "/ip-allowlist",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { cidr, label, confirmed } = request.body;

      if (!cidr || !label) {
        return reply.status(400).send({ success: false, error: { code: "MISSING_PARAMS", message: "cidr and label are required." } });
      }

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      // Warn if adding this entry would exclude the editor's current IP
      const currentIpAllowed = ipMatchesCidr(clientIp, cidr);
      if (!currentIpAllowed && !confirmed) {
        // Check if allowlist currently has entries
        const countRes = await query("SELECT COUNT(*) AS count FROM admin_ip_allowlist WHERE active = true");
        const count = parseInt(countRes.rows[0].count, 10);
        if (count > 0) {
          return reply.status(200).send({
            success: false,
            requireConfirmation: true,
            message: `Warning: Your current IP (${maskIp(clientIp)}) is not within the CIDR ${maskIp(cidr)}. Adding this entry without including your IP could lock you out. Send again with confirmed=true to proceed.`
          });
        }
      }

      try {
        const res = await query(
          "INSERT INTO admin_ip_allowlist (cidr, label, created_by, active) VALUES ($1, $2, $3, true) RETURNING id, label, active, created_at",
          [cidr.trim(), label.trim(), actorId]
        );

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'IP_ALLOWLIST_ADDED', $2, $3, $4)`,
          [actorId, `cidr:${maskIp(cidr)}`, clientIp, userAgent]
        );

        const entry = { ...res.rows[0], cidr: maskIp(cidr) };
        return reply.status(201).send({ success: true, entry });
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to add allowlist entry." } });
      }
    }
  );

  // DELETE /admin/management/ip-allowlist/:id — Remove an IP
  fastify.delete<{ Params: { id: string } }>(
    "/ip-allowlist/:id",
    { onRequest: [fastify.requireRole(["superadmin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        const entryRes = await query("SELECT cidr FROM admin_ip_allowlist WHERE id = $1", [id]);
        if (entryRes.rows.length === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Entry not found." } });
        }

        await query("DELETE FROM admin_ip_allowlist WHERE id = $1", [id]);

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'IP_ALLOWLIST_REMOVED', $2, $3, $4)`,
          [actorId, `allowlist:${id}`, clientIp, userAgent]
        );

        return { success: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to remove allowlist entry." } });
      }
    }
  );

  // ==============================
  // AUDIT LOG
  // ==============================

  // GET /admin/management/audit-log
  fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/audit-log",
    async (request, reply) => {
      const limit = Math.min(parseInt(request.query.limit || "50", 10), 200);
      const offset = parseInt(request.query.offset || "0", 10);

      try {
        const res = await query(
          `SELECT l.id, l.action, l.target, l.ip, l.user_agent, l.created_at,
                  a.email AS actor_email, a.name AS actor_name, a.role AS actor_role
           FROM admin_audit_log l
           LEFT JOIN admins a ON l.actor_admin_id = a.id
           ORDER BY l.created_at DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );

        return { success: true, logs: res.rows };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to retrieve audit log." } });
      }
    }
  );
}
