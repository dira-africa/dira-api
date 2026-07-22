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

import { FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db/query";
import { ipMatchesCidr, normalizeIp } from "../utils/ipCheck";

/**
 * Resolves the client IP behind Cloudflare or proxy environments
 */
export function getClientIp(request: FastifyRequest): string {
  // CF-Connecting-IP is provided by Cloudflare
  const cfIp = request.headers["cf-connecting-ip"];
  if (cfIp && typeof cfIp === "string") {
    return normalizeIp(cfIp);
  }

  // Leftmost X-Forwarded-For is client origin IP
  const xForwardedFor = request.headers["x-forwarded-for"];
  if (xForwardedFor && typeof xForwardedFor === "string") {
    const parts = xForwardedFor.split(",");
    return normalizeIp(parts[0]);
  }

  return normalizeIp(request.ip);
}

/**
 * Enforces IP allowlist restrictions on all admin requests
 */
export async function enforceAdminIpAllowlist(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = getClientIp(request);

  // Check emergency bypass token (break-glass recovery mechanism)
  const bypassToken = process.env.EMERGENCY_ADMIN_BYPASS_TOKEN;
  const requestBypass = request.headers["x-emergency-bypass-token"] || (request.query as any)?.emergency_bypass_token;
  
  if (bypassToken && requestBypass === bypassToken) {
    // Audit log emergency entry loudly
    try {
      await query(
        `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
         VALUES (NULL, 'EMERGENCY_BYPASS_IP_CHECK', $1, $2, $3)`,
        [clientIp, clientIp, request.headers["user-agent"] || null]
      );
    } catch (err) {
      request.log.error(err, "Failed to write emergency audit log:");
    }
    return; // Bypass allowlist check
  }

  try {
    // Retrieve all active allowlisted CIDR records
    const allowlistRes = await query(
      "SELECT id, cidr, label FROM admin_ip_allowlist WHERE active = true"
    );

    const activeRanges = allowlistRes.rows;

    // If allowlist is empty, allow access (so new install is not locked out)
    if (activeRanges.length === 0) {
      return;
    }

    // Check if client IP is within any allowlisted CIDR range
    const isAllowed = activeRanges.some((range) => ipMatchesCidr(clientIp, range.cidr));

    if (!isAllowed) {
      request.log.warn(`Blocked admin access attempt from un-allowlisted IP: ${clientIp}`);

      // Log failure in append-only audit log
      try {
        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES (NULL, 'IP_ALLOWLIST_BLOCKED', $1, $2, $3)`,
          [clientIp, clientIp, request.headers["user-agent"] || null]
        );
      } catch (err) {
        request.log.error(err, "Failed to log allowlist block in audit:");
      }

      return reply.status(403).send({
        success: false,
        error: {
          code: "IP_BLOCKED",
          message: "Access forbidden. Your IP address is not in the allowlist."
        }
      });
    }
  } catch (err) {
    request.log.error({ err }, "IP allowlist middleware check failed:");
    return reply.status(500).send({
      success: false,
      error: { code: "SERVER_ERROR", message: "Failed to evaluate IP access restrictions." }
    });
  }
}
