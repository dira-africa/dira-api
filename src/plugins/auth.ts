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

import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { redis } from "../db/redis";
import { JWT } from "@fastify/jwt";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    adminJwtVerify: () => Promise<{ id: string; role: string; login_at?: number }>;
    adminUser?: { id: string; role: string; login_at?: number };
    adminAction?: string;
    adminEntityType?: string;
    adminEntityId?: string;
    adminMetadata?: any;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; role: string; login_at?: number };
    user: { id: string; role: string; login_at?: number };
  }
  interface JWT {
    admin: JWT;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // authenticate decorator: verifies standard user JWT token (e.g. Telegram farmers)
  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch (err: any) {
      reply.status(401).send({
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or expired authentication token. Please login again.",
        },
      });
    }
  });

  // authenticateAdmin decorator: verifies admin JWT from cookies or headers
  fastify.decorate("authenticateAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // 1. Resolve token from cookie or authorization header
      let token: string | undefined;

      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
      } else {
        const cookieHeader = request.headers.cookie;
        if (cookieHeader) {
          const match = cookieHeader.match(/dira_admin_token=([^;]+)/);
          if (match) {
            token = match[1];
          }
        }
      }

      if (!token) {
        return reply.status(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Admin token missing." }
        });
      }

      // 2. Decode and verify signature
      const decoded = await fastify.jwt.admin.verify<{ id: string; role: string; login_at?: number }>(token);

      if (!decoded || !["superadmin", "admin", "editor"].includes(decoded.role)) {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "Access forbidden. Admin role required." }
        });
      }

      // 3. Absolute Session Timeout Check (24 hours)
      const maxSessionAge = 24 * 60 * 60 * 1000;
      if (decoded.login_at && Date.now() - decoded.login_at > maxSessionAge) {
        return reply.status(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Admin session has expired (absolute timeout). Please login again." }
        });
      }

      // 4. Inactivity sliding window check (2 hours)
      const sessionKey = `dira:admin:session:${decoded.id}`;
      const sessionActive = await redis.get(sessionKey);
      if (!sessionActive) {
        return reply.status(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Admin session has expired due to inactivity." }
        });
      }

      // Slide inactivity TTL for another 2 hours (7200s)
      await redis.expire(sessionKey, 7200);

      // Attach user payload
      request.adminUser = decoded;
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Access forbidden. Invalid or expired admin token." }
      });
    }
  });

  // requireRole decorator: gates access by admin roles
  fastify.decorate("requireRole", (roles: string[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.adminUser) {
        return reply.status(401).send({
          success: false,
          error: { code: "UNAUTHORIZED", message: "Admin authentication required." }
        });
      }

      if (!roles.includes(request.adminUser.role)) {
        return reply.status(403).send({
          success: false,
          error: { code: "FORBIDDEN", message: "Access forbidden. Insufficient permissions." }
        });
      }
    };
  });
};

export default fp(authPlugin);
