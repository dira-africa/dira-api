import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 10000,       // 10 seconds
  connectionTimeoutMillis: 5000,  // 5 seconds
});
