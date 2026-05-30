import { FastifyInstance } from "fastify";

export default async function tokensRoutes(fastify: FastifyInstance) {
  fastify.get("/balance", async (request, reply) => {
    return { balance: 250 };
  });

  fastify.get("/history", async (request, reply) => {
    return { transactions: [] };
  });
}
