import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { aiService } from "../services/aiService";
import { tokenService } from "../services/tokenService";
import fs from "fs";
import path from "path";

interface CropSubmissionBody {
  photoUrl: string;
  cropType: string;
  growthStage: string;
  latitude: number;
  longitude: number;
}

export default async function cropSubmissionsRoutes(fastify: FastifyInstance) {
  
  // Register content type parser to allow streaming image uploads without 415 errors
  fastify.addContentTypeParser(
    ["image/jpeg", "image/png", "application/octet-stream"],
    (request, payload, done) => {
      done(null, payload);
    }
  );

  // 1. GET /api/crop-submissions/history - Fetch authenticated user's submissions
  fastify.get(
    "/history",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const res = await query(
          `SELECT id, photo_url, crop_type, growth_stage, verification_status, ai_health_score, ai_confidence, submitted_at, rejection_reason, ai_report_en, ai_report_sw 
           FROM crop_submissions 
           WHERE user_id = $1 
           ORDER BY submitted_at DESC`,
          [userId]
        );
        return { success: true, submissions: res.rows };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to fetch history." }
        });
      }
    }
  );

  // 2. POST /api/crop-submissions/upload-url - Generates mock pre-signed upload URL for local dev
  fastify.post(
    "/upload-url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const uniqueId = Math.random().toString(36).substring(2, 15);
      const filename = `crop_${uniqueId}_${Date.now()}.jpg`;
      
      const port = process.env.PORT || 3001;
      const baseUrl = `http://localhost:${port}`;
      
      const uploadUrl = `${baseUrl}/api/crop-submissions/upload/${filename}`;
      const photoUrl = `${baseUrl}/uploads/${filename}`;
      
      return {
        success: true,
        uploadUrl,
        photoUrl,
        filename
      };
    }
  );

  // GET /api/crop-submissions/upload-url - Retrieve mock pre-signed upload URL for local dev
  fastify.get(
    "/upload-url",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const uniqueId = Math.random().toString(36).substring(2, 15);
      const filename = `crop_${uniqueId}_${Date.now()}.jpg`;
      
      const port = process.env.PORT || 3001;
      const baseUrl = `http://localhost:${port}`;
      
      const uploadUrl = `${baseUrl}/api/crop-submissions/upload/${filename}`;
      const photoUrl = `${baseUrl}/uploads/${filename}`;
      
      return {
        success: true,
        uploadUrl,
        photoUrl,
        filename
      };
    }
  );

  // 3. PUT /api/crop-submissions/upload/:filename - R2 Direct Upload Emulator
  fastify.put<{ Params: { filename: string } }>(
    "/upload/:filename",
    async (request, reply) => {
      try {
        const uploadsDir = path.join(__dirname, "../../public/uploads");
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const filePath = path.join(uploadsDir, request.params.filename);
        const writeStream = fs.createWriteStream(filePath);
        
        // Stream request payload into file
        await new Promise<void>((resolve, reject) => {
          request.raw.pipe(writeStream);
          request.raw.on("end", resolve);
          request.raw.on("error", reject);
        });
        
        return {
          success: true,
          message: "File uploaded successfully to local storage emulator",
          url: `/uploads/${request.params.filename}`
        };
      } catch (err: any) {
        console.error("Local file upload failed:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "UPLOAD_FAILED", message: err.message || "File upload failed." }
        });
      }
    }
  );

  // 4. POST /api/crop-submissions - Submit crop metadata, save pending state, and dispatch verification job
  fastify.post<{ Body: CropSubmissionBody }>(
    "/",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { photoUrl, cropType, growthStage, latitude, longitude } = request.body;

      if (!photoUrl || !cropType || !growthStage || latitude === undefined || longitude === undefined) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "All profile submission fields are required." }
        });
      }

      try {
        // Step A: Find the user's registered farm
        const farmRes = await query(
          "SELECT id FROM farms WHERE user_id = $1",
          [userId]
        );

        if (farmRes.rows.length === 0) {
          return reply.status(400).send({
            success: false,
            error: { code: "NO_REGISTERED_FARM", message: "You must complete onboarding and register a farm profile before submitting crops." }
          });
        }

        const farmId = farmRes.rows[0].id;

        // Step B: Insert crop submission with status 'pending' and default scores to 0
        const insertRes = await query(
          `INSERT INTO crop_submissions (
            user_id, farm_id, photo_url, location, crop_type, growth_stage,
            ai_health_score, ai_confidence, verification_status
          ) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, 0, 0, 'pending')
          RETURNING id`,
          [userId, farmId, photoUrl, longitude, latitude, cropType, growthStage]
        );

        const submissionId = insertRes.rows[0].id;

        // Step C: Dispatch background BullMQ verification job
        await fastify.photoVerificationQueue.add("crop-photo-verification", {
          submissionId,
          userId,
          farmId,
          photoUrl,
          cropType,
          growthStage,
          latitude,
          longitude
        });

        return {
          success: true,
          verificationStatus: "pending",
          submissionId,
          message: "Crop photo submission received and verification job scheduled."
        };

      } catch (err: any) {
        console.error("Crop submission failed to save:", err);
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to submit crop photo." }
        });
      }
    }
  );
}
