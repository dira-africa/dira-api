import { FastifyInstance } from "fastify";

export default async function publicRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (request, reply) => {
    return {
      status: "ok",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    };
  });
}
