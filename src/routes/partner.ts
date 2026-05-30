import { FastifyInstance } from "fastify";

export default async function partnerRoutes(fastify: FastifyInstance) {
  fastify.post("/vouchers/validate", async (request, reply) => {
    return { valid: true, amount: 1000 };
  });
}
