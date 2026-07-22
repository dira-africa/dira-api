/*
 * Copyright 2026 Dira Africa
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config({ path: path.join(__dirname, "../../.env") });

import { pool } from "../db/pool";
import { hashPassword } from "../utils/password";

async function seedAdmin() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!email || !password) {
    console.error("❌ Seeding failed: ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD must be set in your environment.");
    process.exit(1);
  }

  try {
    // Check if any admin exists
    const checkRes = await pool.query("SELECT COUNT(*) AS count FROM admins");
    const count = parseInt(checkRes.rows[0].count, 10);

    if (count > 0) {
      console.warn("⚠️ Database already has registered administrators. Refusing to run seed script to prevent overwriting.");
      process.exit(0);
    }

    console.log(`Seeding initial superadmin: ${email}...`);
    const pwdHash = await hashPassword(password);

    await pool.query(
      `INSERT INTO admins (email, password_hash, name, role, status, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        email.trim().toLowerCase(),
        pwdHash,
        "Super Administrator",
        "superadmin",
        "active",
        true
      ]
    );

    // Audit log entry for seeding
    await pool.query(
      `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
       VALUES (NULL, 'SEED_SUPERADMIN', $1, '127.0.0.1', 'seed-script')`,
      [email.trim().toLowerCase()]
    );

    console.log("✅ Superadmin seeded successfully!");
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Seeding failed with error:", err.message);
    process.exit(1);
  }
}

seedAdmin();
