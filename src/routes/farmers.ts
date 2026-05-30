import { FastifyInstance } from "fastify";

export default async function farmersRoutes(fastify: FastifyInstance) {
  fastify.get("/profile", async (request, reply) => {
    return { id: "farmer_1", name: "John Doe", verified: true };
  });

  fastify.post("/crop-photo", async (request, reply) => {
    return { success: true, message: "Photo uploaded for AI verification" };
  });
}
