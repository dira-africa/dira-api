import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { aiService } from "../services/aiService";
import { tokenService } from "../services/tokenService";
import fs from "fs";
import path from "path";
import { Transform } from "stream";

interface CropSubmissionBody {
  photoUrl: string;
  cropType: string;
  growthStage: string;
  latitude: number;
  longitude: number;
}

class MagicByteValidator extends Transform {
  private checked = false;

  _transform(chunk: any, encoding: string, callback: Function) {
    if (!this.checked) {
      this.checked = true;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding as any);

      // Allow only JPEG (FF D8 FF), PNG (89 50 4E 47), WebP (52 49 46 46)
      const isJpeg = buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
      const isPng = buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
      const isWebp = buffer.length >= 4 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46;

      if (!isJpeg && !isPng && !isWebp) {
        return callback(new Error("INVALID_MAGIC_BYTES"));
      }
    }
    this.push(chunk);
    callback();
  }
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
    {
      bodyLimit: 10485760 // 10MB limit
    },
    async (request, reply) => {
      let filename = request.params.filename;
      let filePath = "";
      try {
        if (!filename || filename.length > 200) {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_FILENAME",
              message: "Filename must be 200 characters or less."
            }
          });
        }

        // Sanitise filenames: only alphanumeric, hyphens, dots
        filename = filename.replace(/[^a-zA-Z0-9.-]/g, "");
        if (!filename) {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_FILENAME",
              message: "Filename is invalid after sanitization."
            }
          });
        }

        const contentLength = request.headers["content-length"];
        if (contentLength && parseInt(contentLength, 10) > 10485760) {
          return reply.status(413).send({
            success: false,
            error: {
              code: "FST_ERR_CTP_BODY_TOO_LARGE",
              message: "Request body is too large"
            }
          });
        }

        const uploadsDir = path.join(__dirname, "../../public/uploads");
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        filePath = path.join(uploadsDir, filename);
        const writeStream = fs.createWriteStream(filePath);
        const validator = new MagicByteValidator();
        
        let bytesRead = 0;

        // Stream request payload into validator and then to file
        await new Promise<void>((resolve, reject) => {
          request.raw.on("data", (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > 10485760) {
              writeStream.destroy();
              validator.destroy();
              reject(new Error("FST_ERR_CTP_BODY_TOO_LARGE"));
            }
          });

          request.raw
            .pipe(validator)
            .on("error", (err) => {
              writeStream.destroy();
              reject(err);
            })
            .pipe(writeStream)
            .on("finish", resolve)
            .on("error", reject);
        });
        
        return {
          success: true,
          message: "File uploaded successfully to local storage emulator",
          url: `/uploads/${filename}`
        };
      } catch (err: any) {
        // Clean up partially uploaded file if limit exceeded or validation failed
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {}
        }

        if (err.message === "INVALID_MAGIC_BYTES") {
          return reply.status(400).send({
            success: false,
            error: {
              code: "INVALID_FILE_TYPE",
              message: "Only JPEG, PNG, and WebP images are allowed."
            }
          });
        }

        if (err.message === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.status(413).send({
            success: false,
            error: { code: "FST_ERR_CTP_BODY_TOO_LARGE", message: "Request body is too large" }
          });
        }

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
    {
      onRequest: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "24 hours",
          keyGenerator: (request: any) => request.user?.id || request.ip,
        },
      },
    },
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
