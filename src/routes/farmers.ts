import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { getOutcomeAndReason, getAirtimeBreakdown } from "../services/verificationService";

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
  fastify.get(
    "/submissions",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const queryParams = request.query as { page?: string; limit?: string };
      const page = Math.max(1, Number(queryParams.page) || 1);
      const limit = Math.max(1, Number(queryParams.limit) || 10);
      const offset = (page - 1) * limit;

      try {
        const countRes = await query(
          "SELECT COUNT(*) AS count FROM crop_submissions WHERE user_id = $1",
          [userId]
        );
        const totalCount = Number(countRes.rows[0].count);
        const totalPages = Math.ceil(totalCount / limit);

        const submissionsRes = await query(
          `SELECT id, photo_url, crop_type, growth_stage, verification_status, ai_health_score, ai_confidence, submitted_at, rejection_reason, ai_report_en, ai_report_sw
           FROM crop_submissions
           WHERE user_id = $1
           ORDER BY submitted_at DESC
           LIMIT $2 OFFSET $3`,
          [userId, limit, offset]
        );

        return {
          success: true,
          submissions: submissionsRes.rows,
          totalCount,
          page,
          totalPages
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to fetch submissions." }
        });
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    "/submissions/:id",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const submissionId = request.params.id;

      try {
        const userRes = await query("SELECT language FROM users WHERE id = $1", [userId]);
        const lang = userRes.rows[0]?.language === "sw" ? "sw" : "en";

        const res = await query(
          `SELECT cs.id, cs.photo_url, cs.crop_type, cs.growth_stage, cs.verification_status, cs.ai_health_score, cs.ai_confidence, 
                  cs.ai_report_en, cs.ai_report_sw, cs.ai_detected_issues, ST_X(cs.location::geometry) AS longitude, ST_Y(cs.location::geometry) AS latitude, 
                  cs.rejection_reason, cs.submitted_at, cs.verified_at, cs.verification_score, cs.verification_factors,
                  cs.is_appealed, cs.appeal_reason, cs.appealed_at,
                  COALESCE(tt.amount, 0) AS actual_tokens
           FROM crop_submissions cs
           LEFT JOIN token_transactions tt ON cs.id = tt.reference_id AND tt.type = 'earn' AND tt.status = 'confirmed'
           WHERE cs.id = $1 AND cs.user_id = $2`,
          [submissionId, userId]
        );

        if (res.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "NOT_FOUND", message: "Crop submission not found." }
          });
        }

        const row = res.rows[0];
        const outcomeInfo = getOutcomeAndReason(
          row.verification_status,
          row.verification_factors,
          row.rejection_reason,
          lang
        );

        const submission = {
          ...row,
          outcome: outcomeInfo.outcome,
          outcome_reason: outcomeInfo.reason,
          airtime_breakdown: getAirtimeBreakdown(Number(row.actual_tokens))
        };

        return {
          success: true,
          submission
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to fetch crop submission details." }
        });
      }
    }
  );

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
