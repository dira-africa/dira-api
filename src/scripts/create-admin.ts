/*
 * Copyright 2026 Blockchain & Climate Institute
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

import readline from "readline";
import bcryptjs from "bcryptjs";
import { pool } from "../db/pool";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function validatePassword(password: string): string | null {
  if (password.length < 20) {
    return "Password must be at least 20 characters long.";
  }
  if (!/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter.";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter.";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number.";
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    return "Password must contain at least one symbol/special character.";
  }
  return null;
}

async function main() {
  console.log("=== Dira Africa Admin Account Creator ===");

  try {
    const email = (await question("Enter admin email: ")).trim().toLowerCase();
    if (!validateEmail(email)) {
      console.error("❌ Invalid email format.");
      process.exit(1);
    }

    // Check if user already exists
    const existingUser = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      console.error("❌ An account with this email already exists.");
      process.exit(1);
    }

    const password = await question("Enter admin password: ");
    const pwdError = validatePassword(password);
    if (pwdError) {
      console.error(`❌ Password validation failed: ${pwdError}`);
      process.exit(1);
    }

    const confirmPassword = await question("Confirm password: ");
    if (password !== confirmPassword) {
      console.error("❌ Passwords do not match.");
      process.exit(1);
    }

    console.log("Hashing password (bcrypt cost factor 12)...");
    const passwordHash = await bcryptjs.hash(password, 12);

    console.log("Creating admin account in database...");
    await pool.query(
      `INSERT INTO users (email, password_hash, role, full_name, language)
       VALUES ($1, $2, 'admin', 'System Administrator', 'en')`,
      [email, passwordHash]
    );

    console.log("✅ Admin account created successfully!");
  } catch (err: any) {
    console.error("❌ Failed to create admin account:", err.message || err);
  } finally {
    rl.close();
    await pool.end();
    process.exit(0);
  }
}

main();
