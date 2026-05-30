import { z } from "zod";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/postgres"),
  REDIS_URL: z.string({
    required_error: "REDIS_URL environment variable is required for Redis/BullMQ",
  }),
  JWT_SECRET: z.string({
    required_error: "JWT_SECRET environment variable is required for authentication",
  }).min(16, "JWT_SECRET must be at least 16 characters long"),
  DARAJA_PRODUCTION_ACTIVE: z
    .string()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`   Missing or invalid: "${issue.path.join(".")}" - ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
