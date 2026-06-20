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

import Fastify from "fastify";
import { env } from "./config/env";
import authRoutes from "./routes/auth";
import atmosphericRoutes from "./routes/atmospheric";
import tokensRoutes from "./routes/tokens";
import cropSubmissionsRoutes from "./routes/cropSubmissions";
import jwt from "@fastify/jwt";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import jobsPlugin from "./plugins/jobs";
import { errorHandler } from "./middleware/errorHandler";
import { pool } from "./db/pool";
import { query } from "./db/query";

async function runTests() {
  const server = Fastify();

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(jobsPlugin);

  server.setErrorHandler(errorHandler);

  // Register routes
  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(atmosphericRoutes, { prefix: "/api/atmospheric" });
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(cropSubmissionsRoutes, { prefix: "/api/crop-submissions" });

  await server.ready();

  const testUserId = "b1111111-1111-1111-1111-111111111111";

  try {
    console.log("Cleaning up previous test data...");
    await query("DELETE FROM token_ledger WHERE user_id = $1", [testUserId]);
    await query("DELETE FROM users WHERE id = $1", [testUserId]);

    console.log("Seeding test agent/farmer...");
    await query(
      `INSERT INTO users (id, telegram_id, phone_number, full_name, role, county)
       VALUES ($1, 8888888, pgp_sym_encrypt('+254711111111', $2), 'Validation Test User', 'agent', 'Nairobi')`,
      [testUserId, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    // Initial tokens for balance checks
    await query(
      `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, notes)
       VALUES ($1, 100, 100, 'bonus', 'Initial test balance')`,
      [testUserId]
    );

    // Generate JWT token for requests
    const token = server.jwt.sign({ id: testUserId, role: "agent" });

    // =========================================================================
    // Test 1: POST pressure: 500 → 400 error (schema validation)
    // =========================================================================
    console.log("\n--- Test 1: POST pressure: 500 (Schema Validation) ---");
    const test1Res = await server.inject({
      method: "POST",
      url: "/api/atmospheric/submit",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pressure_hpa: 500, // Should trigger schema validation error (min is 870)
        altitude_m: 1600,
        latitude: -1.2921,
        longitude: 36.8219,
        accuracy_m: 5.0,
        sensor_type: "hardware_barometer",
        timestamp: new Date().toISOString()
      }
    });

    console.log(`Status: ${test1Res.statusCode}`);
    console.log(`Body: ${test1Res.body}`);
    const body1 = JSON.parse(test1Res.body);

    if (test1Res.statusCode !== 400 || body1.error?.code !== "VALIDATION_ERROR") {
      throw new Error(`Test 1 Failed: Expected status 400 with VALIDATION_ERROR, got ${test1Res.statusCode} and ${body1.error?.code}`);
    }
    console.log("✅ Test 1 Passed: Request rejected by Fastify schema validation before handler execution.");

    // =========================================================================
    // Test 2: POST with SQL injection in phone number → 400 error, no database query
    // =========================================================================
    console.log("\n--- Test 2: POST with SQL injection in phone number ---");
    const sqlInjectionPayload = "0711111111' OR 1=1; --";
    const test2Res = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        token_amount: 30,
        phone_number: sqlInjectionPayload
      }
    });

    console.log(`Status: ${test2Res.statusCode}`);
    console.log(`Body: ${test2Res.body}`);
    const body2 = JSON.parse(test2Res.body);

    if (test2Res.statusCode !== 400) {
      throw new Error(`Test 2 Failed: Expected status 400, got ${test2Res.statusCode}`);
    }
    // Verify no query was run for a redemption request containing the SQL injection string
    const auditRes = await query(
      "SELECT COUNT(*) as count FROM redemption_requests WHERE phone_number::text LIKE $1",
      [`%${sqlInjectionPayload}%`]
    );
    if (Number(auditRes.rows[0].count) !== 0) {
      throw new Error("Test 2 Failed: SQL injection pattern was stored in database!");
    }
    console.log("✅ Test 2 Passed: Request rejected with 400; no SQL injection payload processed or stored in database.");

    // =========================================================================
    // Test 3: Upload a .php file renamed as .jpg → 400 error (magic byte check fails)
    // =========================================================================
    console.log("\n--- Test 3: Upload a .php file renamed as .jpg (Magic Bytes) ---");
    const phpContent = Buffer.from("<?php echo 'malicious code'; ?>");
    const test3Res = await server.inject({
      method: "PUT",
      url: "/api/crop-submissions/upload/malicious.jpg",
      headers: { 
        "content-type": "image/jpeg",
        "content-length": String(phpContent.length)
      },
      payload: phpContent
    });

    console.log(`Status: ${test3Res.statusCode}`);
    console.log(`Body: ${test3Res.body}`);
    const body3 = JSON.parse(test3Res.body);

    if (test3Res.statusCode !== 400 || body3.error?.code !== "INVALID_FILE_TYPE") {
      throw new Error(`Test 3 Failed: Expected status 400 with INVALID_FILE_TYPE, got ${test3Res.statusCode} and ${body3.error?.code}`);
    }
    console.log("✅ Test 3 Passed: Magic byte check successfully rejected the disguised PHP file.");

    // =========================================================================
    // Test 4: Upload a valid JPEG → accepted correctly
    // =========================================================================
    console.log("\n--- Test 4: Upload a valid JPEG ---");
    // Standard JPEG starts with: FF D8 FF E0
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    const test4Res = await server.inject({
      method: "PUT",
      url: "/api/crop-submissions/upload/valid.jpg",
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(jpegHeader.length)
      },
      payload: jpegHeader
    });

    console.log(`Status: ${test4Res.statusCode}`);
    console.log(`Body: ${test4Res.body}`);
    const body4 = JSON.parse(test4Res.body);

    if (test4Res.statusCode !== 200 || !body4.success) {
      throw new Error(`Test 4 Failed: Expected status 200 and success, got ${test4Res.statusCode} and ${test4Res.body}`);
    }
    console.log("✅ Test 4 Passed: Valid JPEG accepted successfully.");

    console.log("\n⭐️ ALL INPUT VALIDATION & SECURITY TESTS PASSED SUCCESSFULLY! ⭐️");

  } catch (err: any) {
    console.error("Test execution failed:", err.message);
    process.exit(1);
  } finally {
    // Cleanup seeded user
    try {
      await query("DELETE FROM token_ledger WHERE user_id = $1", [testUserId]);
      await query("DELETE FROM users WHERE id = $1", [testUserId]);
    } catch (dbErr: any) {
      console.error("Error cleaning up database:", dbErr.message);
    }
    
    await server.close();
    process.exit(0);
  }
}

runTests();
