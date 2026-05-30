import { FastifyInstance } from "fastify";

export default async function airtimeRoutes(fastify: FastifyInstance) {
  fastify.post("/redeem", async (request, reply) => {
    return { success: true, message: "Airtime sent via Africa's Talking" };
  });
}
