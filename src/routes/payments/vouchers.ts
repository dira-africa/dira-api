import { FastifyInstance } from "fastify";

export default async function vouchersRoutes(fastify: FastifyInstance) {
  fastify.post("/redeem", async (request, reply) => {
    return { success: true, code: "VCH_REDEEMED_OK" };
  });
}
