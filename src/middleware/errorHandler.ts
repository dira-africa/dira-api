import { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db/query";

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Log the full error stack internally for debugging
  request.log.error(error);

  const statusCode = error.statusCode || 500;
  let code = "INTERNAL_SERVER_ERROR";
  let message = "An unexpected error occurred. Please try again later.";

  // Check error types and map to safe, user-friendly responses
  if (error.validation) {
    code = "VALIDATION_ERROR";
    message = error.message;
  } else if (statusCode === 429) {
    code = "TOO_MANY_REQUESTS";
    message = "Rate limit exceeded. Please try again shortly.";
    if (request.url.includes("/auth/telegram")) {
      query(
        `INSERT INTO audit_log (action, entity_type, ip_address, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          "auth_telegram_failure",
          "users",
          request.ip,
          request.headers["user-agent"] || null,
          JSON.stringify({ reason: "rate_limited" }),
        ]
      ).catch((err) => {
        request.log.error("Failed to log 429 rate limit to audit_log:", err);
      });
    }
  } else if (statusCode === 401) {
    code = "UNAUTHORIZED";
    message = "Authentication token is missing or invalid.";
  } else if (statusCode === 403) {
    code = "FORBIDDEN";
    message = "You do not have permission to access this resource.";
  } else if (statusCode === 404) {
    code = "NOT_FOUND";
    message = "The requested resource could not be found.";
  } else if (statusCode < 500) {
    // Safe client-side errors (4xx) can expose original message
    code = error.code || "BAD_REQUEST";
    message = error.message;
  }

  // Database errors (Postgres/Redis/etc.) must NEVER leak details
  const isDbError = 
    error.message.toLowerCase().includes("select") || 
    error.message.toLowerCase().includes("database") ||
    error.message.toLowerCase().includes("relation") ||
    error.message.toLowerCase().includes("postgres") ||
    error.message.toLowerCase().includes("redis");

  if (isDbError) {
    code = "DATABASE_ERROR";
    message = "A database error occurred. Details have been logged.";
  }

  reply.status(statusCode).send({
    success: false,
    error: {
      code,
      message,
    },
  });
}
