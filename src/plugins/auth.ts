import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { id: string; role: string };
    user: { id: string; role: string };
  }
}

const authPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // authenticate decorator: verifies JWT token
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
