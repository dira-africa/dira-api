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
  VOUCHER_SIGNING_SECRET: z
    .string()
    .min(32, "VOUCHER_SIGNING_SECRET must be at least 32 characters long")
    .default("SuperSecureVoucherSigningSecretPassphraseLength32"),
  HEDERA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_OPERATOR_KEY_TYPE: z.enum(["ED25519", "ECDSA"]).optional(),
  DIRA_HCS_TOPIC_ID: z.string().optional(),
  DIRA_HTS_TOKEN_ID: z.string().optional(),
  PRETIUM_BASE_URL: z.string().optional(),
  PRETIUM_API_KEY: z.string().optional(),
  PRETIUM_WEBHOOK_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string({
    required_error: "GEMINI_API_KEY environment variable is required for AI crop verification",
  }),
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
