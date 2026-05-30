import { FastifyInstance } from "fastify";
import { query } from "../db/query";

interface FarmerProfileBody {
  fullName: string;
  county: string;
  subCounty: string;
  latitude: number;
  longitude: number;
  farmSizeAcres: number;
  cropTypes: string[];
}

export default async function farmersRoutes(fastify: FastifyInstance) {
  fastify.get("/profile", async (request, reply) => {
    return { id: "farmer_1", name: "John Doe", verified: true };
  });

  fastify.post("/crop-photo", async (request, reply) => {
    return { success: true, message: "Photo uploaded for AI verification" };
  });

  fastify.post<{ Body: FarmerProfileBody }>(
    "/profile",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { fullName, county, subCounty, latitude, longitude, farmSizeAcres, cropTypes } = request.body;

      try {
        // Update user's name and county in database
        await query(
          "UPDATE users SET full_name = $1, county = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
          [fullName, county, userId]
        );

        // Check if farm already exists for this user
        const farmRes = await query("SELECT id FROM farms WHERE user_id = $1", [userId]);

        if (farmRes.rows.length > 0) {
          await query(
            `UPDATE farms 
             SET farm_location = ST_SetSRID(ST_MakePoint($1, $2), 4326), 
                 farm_size_acres = $3, 
                 crop_types = $4, 
                 county = $5, 
                 sub_county = $6, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE user_id = $7`,
            [longitude, latitude, farmSizeAcres, cropTypes, county, subCounty, userId]
          );
        } else {
          await query(
            `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county) 
             VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7)`,
            [userId, longitude, latitude, farmSizeAcres, cropTypes, county, subCounty]
          );
        }

        return {
          success: true,
          user: {
            id: userId,
            name: fullName,
            role: "farmer",
            isNewUser: false
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to save farmer profile." }
        });
      }
    }
  );
}
