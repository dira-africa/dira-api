import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { env } from "../config/env";
import { query } from "../db/query";
import { sanitizeString } from "../lib/sanitize";

interface TelegramAuthBody {
  initData: string;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/telegram
  fastify.post<{ Body: TelegramAuthBody }>(
    "/telegram",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["initData"],
          properties: {
            initData: { type: "string", maxLength: 4096 }
          }
        }
      }
    },
    async (request, reply) => {
      const initData = sanitizeString(request.body.initData, 4096);

      if (!initData) {
        await query(
          `INSERT INTO audit_log (action, entity_type, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            "auth_telegram_failure",
            "users",
            request.ip,
            request.headers["user-agent"] || null,
            JSON.stringify({ reason: "missing_init_data" }),
          ]
        );

        return reply.status(400).send({
          success: false,
          error: {
            code: "BAD_REQUEST",
            message: "Missing initData in request body.",
          },
        });
      }

      try {
        // a. Parse initData string into key-value pairs
        const params = new URLSearchParams(initData);
        
        // b. Extract 'hash' field and remove it from pairs
        const hash = params.get("hash");
        if (!hash) {
          throw new Error("missing_hash");
        }
        params.delete("hash");

        // c. Sort remaining pairs alphabetically by key
        const keys = Array.from(params.keys()).sort();
        
        // d. Join as 'key=value' strings with \n separator
        const dataCheckString = keys
          .map((key) => `${key}=${params.get(key)}`)
          .join("\n");

        // e. Generate HMAC-SHA256 of string 'WebAppData' using Telegram Bot Token as key
        const secretKey = crypto
          .createHmac("sha256", "WebAppData")
          .update(env.TELEGRAM_BOT_TOKEN)
          .digest();

        // f. Generate HMAC-SHA256 of the sorted data using the secret key
        const computedHash = crypto
          .createHmac("sha256", secretKey)
          .update(dataCheckString)
          .digest("hex");

        // g. Compare to extracted hash using crypto.timingSafeEqual ONLY
        const computedBuffer = Buffer.from(computedHash, "hex");
        const extractedBuffer = Buffer.from(hash, "hex");

        if (
          computedBuffer.length !== extractedBuffer.length ||
          !crypto.timingSafeEqual(computedBuffer, extractedBuffer)
        ) {
          throw new Error("signature_invalid");
        }

        // h. Verify auth_date field is not older than 5 minutes (300 seconds)
        const authDate = parseInt(params.get("auth_date") || "0", 10);
        const now = Math.floor(Date.now() / 1000);
        if (now - authDate > 300) {
          throw new Error("stale_token");
        }

        // Parse user data from initData
        const userStr = params.get("user");
        if (!userStr) {
          throw new Error("missing_user_data");
        }

        const telegramUser = JSON.parse(userStr);
        const telegramId = telegramUser.id;
        const telegramUsername = telegramUser.username || null;
        const firstName = telegramUser.first_name || "";
        const lastName = telegramUser.last_name || "";
        const fullName = [firstName, lastName].filter(Boolean).join(" ") || "Telegram User";
        const languageCode = telegramUser.language_code === "sw" ? "sw" : "en";

        // Upsert user in database
        const userSelect = await query(
          `SELECT id, full_name, role, language, privacy_policy_accepted_at,
                  CASE WHEN phone_number IS NOT NULL THEN pgp_sym_decrypt(phone_number::bytea, $2) ELSE NULL END AS decrypted_phone
           FROM users WHERE telegram_id = $1`,
          [telegramId, env.PGCRYPTO_SYMMETRIC_KEY]
        );

        let user;
        let isNewUser = false;

        if (userSelect.rows.length > 0) {
          user = userSelect.rows[0];
          if (!user.privacy_policy_accepted_at || user.decrypted_phone === "PENDING" || !user.decrypted_phone) {
            isNewUser = true;
          }
          await query(
            `UPDATE users 
             SET telegram_username = $1, full_name = $2, last_seen_at = CURRENT_TIMESTAMP 
             WHERE id = $3`,
            [telegramUsername, fullName, user.id]
          );
        } else {
          isNewUser = true;
          const userInsert = await query(
            `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language)
             VALUES ($1, $2, pgp_sym_encrypt('PENDING', $3), $4, 'farmer', $5)
             RETURNING id, full_name, role, language`,
            [telegramId, telegramUsername, env.PGCRYPTO_SYMMETRIC_KEY, fullName, languageCode]
          );
          user = userInsert.rows[0];
        }

        // Issue 7-day JWT
        const token = fastify.jwt.sign(
          { id: user.id, role: user.role },
          { expiresIn: "7d" }
        );

        // Log successful login
        await query(
          `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            user.id,
            "auth_telegram_success",
            "users",
            user.id,
            request.ip,
            request.headers["user-agent"] || null,
            JSON.stringify({ telegram_id: telegramId, is_new: isNewUser }),
          ]
        );

        return {
          token,
          user: {
            id: user.id,
            name: user.full_name,
            role: user.role,
            language: user.language,
            isNewUser,
          },
        };

      } catch (err: any) {
        const reason = err.message || "unknown_error";
        
        // Log authentication failure
        await query(
          `INSERT INTO audit_log (action, entity_type, ip_address, user_agent, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            "auth_telegram_failure",
            "users",
            request.ip,
            request.headers["user-agent"] || null,
            JSON.stringify({ reason }),
          ]
        );

        const statusMap: Record<string, number> = {
          missing_hash: 401,
          signature_invalid: 401,
          stale_token: 401,
          missing_user_data: 400,
        };

        const codeMap: Record<string, string> = {
          missing_hash: "INVALID_TELEGRAM_AUTH",
          signature_invalid: "INVALID_TELEGRAM_AUTH",
          stale_token: "STALE_TOKEN",
          missing_user_data: "INVALID_TELEGRAM_AUTH",
        };

        const status = statusMap[reason] || 401;
        const msgMap: Record<string, string> = {
          missing_hash: "Missing hash parameter.",
          signature_invalid: "Invalid signature hash.",
          stale_token: "Authentication token has expired (older than 5 minutes).",
          missing_user_data: "Missing user details in Telegram data.",
        };

        return reply.status(status).send({
          success: false,
          error: {
            code: codeMap[reason] || "UNAUTHORIZED",
            message: msgMap[reason] || "Authentication failed.",
          },
        });
      }
    }
  );

  // PUT /auth/profile
  fastify.put<{
    Body: {
      language?: "en" | "sw";
      role?: "farmer" | "agent" | "admin";
      fullName?: string;
      county?: string;
      privacyPolicyAccepted?: boolean;
    };
  }>(
    "/profile",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { language, role, fullName, county, privacyPolicyAccepted } = request.body;

      try {
        const userRes = await query("SELECT * FROM users WHERE id = $1", [userId]);
        if (userRes.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: "USER_NOT_FOUND", message: "User not found." }
          });
        }

        const currentUser = userRes.rows[0];

        const updatedLanguage = language || currentUser.language;
        const updatedRole = role || currentUser.role;
        const updatedFullName = fullName !== undefined ? fullName : currentUser.full_name;
        const updatedCounty = county !== undefined ? county : currentUser.county;

        let updateRes;
        if (privacyPolicyAccepted) {
          updateRes = await query(
            `UPDATE users 
             SET language = $1, role = $2, full_name = $3, county = $4, 
                 privacy_policy_accepted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $5 
             RETURNING id, full_name, role, language, county`,
            [updatedLanguage, updatedRole, updatedFullName, updatedCounty, userId]
          );
        } else {
          updateRes = await query(
            `UPDATE users 
             SET language = $1, role = $2, full_name = $3, county = $4, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $5 
             RETURNING id, full_name, role, language, county`,
            [updatedLanguage, updatedRole, updatedFullName, updatedCounty, userId]
          );
        }

        const updatedUser = updateRes.rows[0];

        const token = fastify.jwt.sign(
          { id: updatedUser.id, role: updatedUser.role },
          { expiresIn: "7d" }
        );

        return {
          success: true,
          token,
          user: {
            id: updatedUser.id,
            name: updatedUser.full_name,
            role: updatedUser.role,
            language: updatedUser.language,
            isNewUser: false
          }
        };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to update profile." }
        });
      }
    }
  );

  // POST /auth/consent
  fastify.post(
    "/consent",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        await query(
          "UPDATE users SET privacy_policy_accepted_at = CURRENT_TIMESTAMP WHERE id = $1",
          [userId]
        );
        return { success: true, message: "Privacy policy consent recorded successfully." };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to save consent." }
        });
      }
    }
  );

  // Stubs for standard authentication (kept alongside Telegram authentication)
  fastify.post(
    "/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      return { success: true, token: "JWT_TOKEN_STUB" };
    }
  );

  fastify.post(
    "/register",
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      return { success: true };
    }
  );
}

