import { FastifyInstance } from "fastify";
import { query } from "../db/query";

interface AgentProfileBody {
  fullName: string;
  county: string;
  latitude: number;
  longitude: number;
  coverageRadiusKm: number;
  deviceModel?: string;
}

export default async function agentsRoutes(fastify: FastifyInstance) {
  fastify.get("/profile", async (request, reply) => {
    return { id: "agent_1", name: "Agent Smith", active: true };
  });

  fastify.post("/barometric-sync", async (request, reply) => {
    return { success: true, pointsProcessed: 4 };
  });

  fastify.post<{ Body: AgentProfileBody }>(
    "/profile",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { fullName, county, latitude, longitude, coverageRadiusKm, deviceModel } = request.body;

      try {
        // Update user's name and county in database
        await query(
          "UPDATE users SET full_name = $1, county = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [fullName, county, userId]
        );

        // Check if agent profile already exists for this user
        const profileRes = await query("SELECT id FROM agent_profiles WHERE user_id = $1", [userId]);

        if (profileRes.rows.length > 0) {
          await query(
            `UPDATE agent_profiles 
             SET coverage_center = ST_SetSRID(ST_MakePoint($1, $2), 4326), 
                 coverage_radius_km = $3, 
                 device_model = $4 
             WHERE user_id = $5`,
            [longitude, latitude, coverageRadiusKm, deviceModel || null, userId]
          );
        } else {
          await query(
            `INSERT INTO agent_profiles (user_id, coverage_center, coverage_radius_km, device_model) 
             VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5)`,
            [userId, longitude, latitude, coverageRadiusKm, deviceModel || null]
          );
        }

        return {
          success: true,
          user: {
            id: userId,
            name: fullName,
            role: "agent",
            isNewUser: false
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to save agent profile." }
        });
      }
    }
  );
}
