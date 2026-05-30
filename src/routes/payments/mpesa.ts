import { FastifyInstance } from "fastify";

export default async function mpesaRoutes(fastify: FastifyInstance) {
  fastify.post("/cashout", async (request, reply) => {
    return { success: true, message: "M-Pesa cashout request submitted" };
  });
}
