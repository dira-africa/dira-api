import { FastifyInstance } from "fastify";

export default async function adminRoutes(fastify: FastifyInstance) {
  fastify.get("/stats", async (request, reply) => {
    return { farmersCount: 150, agentsCount: 42, activeAnchors: 8 };
  });
}
