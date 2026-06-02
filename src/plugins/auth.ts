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
    adminJwtVerify: () => Promise<{ id: string; role: string }>;
    adminUser?: { id: string; role: string };
    adminAction?: string;
    adminEntityType?: string;
    adminEntityId?: string;
    adminMetadata?: any;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; role: string };
    user: { id: string; role: string };
  }
  interface JWT {
    admin: JWT;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // authenticate decorator: verifies standard user JWT token
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

  // authenticateAdmin decorator: verifies admin JWT and Redis session activity
  fastify.decorate("authenticateAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Verifies using the separate admin namespace registered in server.ts
      const decoded = await request.adminJwtVerify();
      if (!decoded || decoded.role !== "admin") {
        return reply.status(403).send({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Access forbidden. Admin role required.",
          },
        });
      }

      // Check Redis session to enforce inactivity timeout (2 hours)
      const sessionKey = `dira:admin:session:${decoded.id}`;
      const sessionActive = await redis.get(sessionKey);
      if (!sessionActive) {
        return reply.status(403).send({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "Admin session has expired due to inactivity. Please login again.",
          },
        });
      }

      // Slide inactivity window: refresh session TTL to another 2 hours (7200s)
      await redis.expire(sessionKey, 7200);

      // Attach admin user payload to request
      request.adminUser = decoded;
    } catch (err: any) {
      return reply.status(403).send({
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Access forbidden. Invalid or expired admin token.",
        },
      });
    }
  });

  // requireRole decorator: gates access by user role
  fastify.decorate("requireRole", (roles: string[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      // Ensure request has already run request.jwtVerify() (e.g. by using authenticate hook)
      if (!request.user) {
        reply.status(401).send({
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required to access this resource.",
          },
        });
        return;
      }

      if (!roles.includes(request.user.role)) {
        reply.status(403).send({
          success: false,
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to access this resource.",
          },
        });
      }
    };
  });
};

export default fp(authPlugin);
