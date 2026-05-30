import { FastifyInstance } from "fastify";

export default async function authRoutes(fastify: FastifyInstance) {
  // Stricter rate limits on authentication routes
  fastify.post(
    "/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      return { success: true, token: "JWT_TOKEN_STUB" };
    }
  );

  fastify.post(
    "/register",
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      return { success: true };
    }
  );
}
