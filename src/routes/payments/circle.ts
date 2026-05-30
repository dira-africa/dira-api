import { FastifyInstance } from "fastify";

export default async function circleRoutes(fastify: FastifyInstance) {
  fastify.post("/contribute", async (request, reply) => {
    return { success: true, message: "Contributed to Dira Circle pool" };
  });
}
