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
  DIRA_CIRCLE_ACTIVE: z
    .string()
    .default("true")
    .transform((val) => val === "true" || val === "1"),
  VOUCHERS_ACTIVE: z
    .string()
    .default("false")
    .transform((val) => val === "true" || val === "1"),
  TELEGRAM_BOT_TOKEN: z
    .string()
    .default("123456789:placeholder_bot_token"),
  PGCRYPTO_SYMMETRIC_KEY: z
    .string()
    .default("SuperSecureDiraSecretPassphrase"),
  AFRICAS_TALKING_API_KEY: z.string().optional(),
  AFRICAS_TALKING_USERNAME: z.string().default("sandbox"),
  DARAJA_CONSUMER_KEY: z.string().optional(),
  DARAJA_CONSUMER_SECRET: z.string().optional(),
  DARAJA_INITIATOR_NAME: z.string().optional(),
  DARAJA_SECURITY_CREDENTIAL: z.string().optional(),
  DARAJA_SHORTCODE: z.string().optional(),
  VOUCHER_SIGNING_SECRET: z
    .string()
    .min(32, "VOUCHER_SIGNING_SECRET must be at least 32 characters long")
    .default("SuperSecureVoucherSigningSecretPassphraseLength32"),
  XION_RPC_URL: z.string().optional(),
  XION_MNEMONIC: z.string().optional(),
  XION_CONTRACT_ADDRESS: z.string().optional(),
  ZKVERIFY_API_URL: z.string().optional(),
  ZKVERIFY_VK_ID: z.string().optional(),
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
