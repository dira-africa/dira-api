import { FastifyInstance } from "fastify";

export default async function webhooksRoutes(fastify: FastifyInstance) {
  fastify.post("/mpesa/callback", async (request, reply) => {
    return { success: true };
  });

  fastify.post("/africastalking/callback", async (request, reply) => {
    return { success: true };
  });
}
