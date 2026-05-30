import { FastifyInstance } from "fastify";

export default async function agentsRoutes(fastify: FastifyInstance) {
  fastify.get("/profile", async (request, reply) => {
    return { id: "agent_1", name: "Agent Smith", active: true };
  });

  fastify.post("/barometric-sync", async (request, reply) => {
    return { success: true, pointsProcessed: 4 };
  });
}
