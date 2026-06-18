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

import Fastify from "fastify";
import fs from "fs";
import path from "path";
import { env } from "./config/env";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import jwt from "@fastify/jwt";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import { dpaService } from "./services/dpaService";
import { errorHandler } from "./middleware/errorHandler";

async function runTests() {
  const server = Fastify();

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  server.setErrorHandler(errorHandler);

  // Register routes under test
  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(usersRoutes, { prefix: "/api/users" });

  await server.ready();

  try {
    console.log("Cleaning up previous DPA test data...");
    
    // Clean up any existing test users with our test telegram_id
    const testTelegramId = 88776655;
    const testTelegramId2 = 88776654;
    
    const existingUsers = await pool.query(
      "SELECT id FROM users WHERE telegram_id IN ($1, $2)",
      [testTelegramId, testTelegramId2]
    );

    for (const row of existingUsers.rows) {
      await pool.query("DELETE FROM crop_submissions WHERE user_id = $1", [row.id]);
      await pool.query("DELETE FROM atmospheric_readings WHERE user_id = $1", [row.id]);
      await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [row.id]);
      await pool.query("DELETE FROM farms WHERE user_id = $1", [row.id]);
      await pool.query("DELETE FROM users WHERE id = $1", [row.id]);
    }

    console.log("Seeding test user...");
    const userRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES ($1, 'dpa_test_farmer', pgp_sym_encrypt('+254712345678', $2), 'DPA Test Farmer', 'farmer', 'en', 'Bungoma')
       RETURNING id`,
      [testTelegramId, env.PGCRYPTO_SYMMETRIC_KEY]
    );
    const userId = userRes.rows[0].id;
    console.log(`Seeded User ID: ${userId}`);

    // Generate JWT token for requests
    const token = server.jwt.sign({ id: userId, role: "farmer" });

    // Seed Farm for PostGIS checking, or setup mocks if PostGIS is not available
    let postgisAvailable = true;
    try {
      await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'st_makepoint';");
    } catch (e) {
      postgisAvailable = false;
    }

    if (!postgisAvailable) {
      console.log("Creating PostGIS mocks...");
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geometry') THEN
            CREATE TYPE geometry AS (dummy text);
          END IF;
        END
        $$;
        CREATE OR REPLACE FUNCTION ST_Point(x double precision, y double precision) RETURNS geometry AS $$
        BEGIN
          RETURN ROW('POINT(' || x || ' ' || y || ')')::geometry;
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE FUNCTION ST_MakePoint(x double precision, y double precision) RETURNS geometry AS $$
        BEGIN
          RETURN ROW('POINT(' || x || ' ' || y || ')')::geometry;
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE FUNCTION ST_SetSRID(geom geometry, srid integer) RETURNS geometry AS $$
        BEGIN
          RETURN geom;
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE FUNCTION ST_X(geom geometry) RETURNS double precision AS $$
        BEGIN
          RETURN 34.56;
        END;
        $$ LANGUAGE plpgsql;
        CREATE OR REPLACE FUNCTION ST_Y(geom geometry) RETURNS double precision AS $$
        BEGIN
          RETURN -0.78;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }

    console.log("Seeding farm, crop submission, atmospheric reading, token ledger...");
    
    const farmRes = await pool.query(
      `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
       VALUES ($1, ST_SetSRID(ST_MakePoint(34.56, -0.78), 4326), 3.0, ARRAY['Beans'], 'Bungoma', 'Webuye')
       RETURNING id`,
      [userId]
    );
    const farmId = farmRes.rows[0].id;

    // Write dummy photo upload file to local disk
    const uploadsDir = path.join(__dirname, "../public/uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    const dummyPhotoFilename = `crop_dpa_test_${Date.now()}.jpg`;
    const dummyPhotoPath = path.join(uploadsDir, dummyPhotoFilename);
    fs.writeFileSync(dummyPhotoPath, "dummy jpeg content");
    console.log(`Created dummy photo file at: ${dummyPhotoPath}`);

    const dummyPhotoUrl = `http://localhost:${env.PORT}/uploads/${dummyPhotoFilename}`;

    const submissionRes = await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, photo_url, location, crop_type, growth_stage, ai_health_score, ai_confidence, verification_status)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint(34.56, -0.78), 4326), 'Beans', 'Flowering', 0.95, 0.98, 'verified')
       RETURNING id`,
      [userId, farmId, dummyPhotoUrl]
    );
    const submissionId = submissionRes.rows[0].id;

    await pool.query(
      `INSERT INTO atmospheric_readings (user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified)
       VALUES ($1, ST_SetSRID(ST_MakePoint(34.56, -0.78), 4326), 1013.25, 10.0, 22.5, 65.0, NOW(), true)`,
      [userId]
    );

    await pool.query(
      `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
       VALUES ($1, 15, 15, 'crop_photo', $2, 'Test award')`,
      [userId, submissionId]
    );

    // --- TEST 1: POST /api/auth/consent ---
    console.log("\n--- TEST 1: POST /api/auth/consent ---");
    const resConsent = await server.inject({
      method: "POST",
      url: "/api/auth/consent",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Response status: ${resConsent.statusCode}`);
    const bodyConsent = JSON.parse(resConsent.payload);
    console.log("Response body:", bodyConsent);

    if (resConsent.statusCode !== 200 || !bodyConsent.success) {
      throw new Error(`Consent endpoint failed. Got status: ${resConsent.statusCode}`);
    }

    // Verify DB update
    const userConsentCheck = await pool.query(
      "SELECT privacy_policy_accepted_at FROM users WHERE id = $1",
      [userId]
    );
    if (!userConsentCheck.rows[0].privacy_policy_accepted_at) {
      throw new Error("Expected privacy_policy_accepted_at to be set, but it was null.");
    }
    console.log("✅ Test 1 passed (Consent recorded).");

    // --- TEST 2: GET /api/users/me/export ---
    console.log("\n--- TEST 2: GET /api/users/me/export ---");
    const startTime = Date.now();
    const resExport = await server.inject({
      method: "GET",
      url: "/api/users/me/export",
      headers: { Authorization: `Bearer ${token}` }
    });
    const duration = Date.now() - startTime;

    console.log(`Response status: ${resExport.statusCode}`);
    console.log(`Export took: ${duration}ms`);
    
    if (duration > 5000) {
      throw new Error(`Export took too long: ${duration}ms. Limit is 5000ms.`);
    }

    if (resExport.statusCode !== 200) {
      throw new Error(`Export failed. Got status: ${resExport.statusCode}`);
    }

    const bodyExport = JSON.parse(resExport.payload);
    
    if (!bodyExport.success || !bodyExport.export) {
      throw new Error("Invalid export response structure.");
    }

    const dataExport = bodyExport.export;
    console.log("Export profile keys:", Object.keys(dataExport.profile));
    console.log("Export phone_number (decrypted):", dataExport.profile.phone_number);
    console.log("Export token history length:", dataExport.token_history.length);
    console.log("Export submissions length:", dataExport.submissions.length);
    console.log("Export readings history length:", dataExport.sync_history.length);

    if (dataExport.profile.phone_number !== "+254712345678") {
      throw new Error(`Expected phone_number to be pgp_sym_decrypted to '+254712345678', got '${dataExport.profile.phone_number}'`);
    }
    if (dataExport.token_history.length === 0) {
      throw new Error("Expected token ledger history in export, but got empty list.");
    }
    if (dataExport.submissions.length === 0) {
      throw new Error("Expected crop submissions in export, but got empty list.");
    }
    if (dataExport.sync_history.length === 0) {
      throw new Error("Expected atmospheric readings history in export, but got empty list.");
    }
    
    console.log("✅ Test 2 passed (Data export details verify OK).");

    // --- TEST 3: POST /api/users/me/delete-request ---
    console.log("\n--- TEST 3: POST /api/users/me/delete-request ---");
    const resDeleteReq = await server.inject({
      method: "POST",
      url: "/api/users/me/delete-request",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Response status: ${resDeleteReq.statusCode}`);
    const bodyDeleteReq = JSON.parse(resDeleteReq.payload);
    console.log("Response body:", bodyDeleteReq);

    if (resDeleteReq.statusCode !== 200 || !bodyDeleteReq.success) {
      throw new Error(`Delete request endpoint failed. Got status: ${resDeleteReq.statusCode}`);
    }

    // Verify DB update
    const userDeleteCheck = await pool.query(
      "SELECT delete_requested_at FROM users WHERE id = $1",
      [userId]
    );
    if (!userDeleteCheck.rows[0].delete_requested_at) {
      throw new Error("Expected delete_requested_at to be set, but it was null.");
    }
    console.log("✅ Test 3 passed (Delete request scheduled).");

    // --- TEST 4: Anonymisation Job Execution ---
    console.log("\n--- TEST 4: Anonymisation Job Execution ---");
    
    // Manually force delete_requested_at to 31 days ago to simulate nightly DPA cleanup trigger
    await pool.query(
      "UPDATE users SET delete_requested_at = NOW() - INTERVAL '31 days' WHERE id = $1",
      [userId]
    );

    console.log("Running anonymizePendingAccounts()...");
    const cleanupResult = await dpaService.anonymizePendingAccounts();
    console.log("Anonymisation count processed:", cleanupResult.processedCount);

    if (cleanupResult.processedCount !== 1) {
      throw new Error(`Expected exactly 1 user to be processed, got ${cleanupResult.processedCount}`);
    }

    // Verify file deletion
    if (fs.existsSync(dummyPhotoPath)) {
      throw new Error(`Expected crop photo file to be deleted from disk, but it still exists at ${dummyPhotoPath}`);
    }
    console.log("  - Crop photo file deleted successfully.");

    // Verify DB status
    const anonymizedUser = (await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    )).rows[0];

    console.log("Anonymized user row:", {
      id: anonymizedUser.id,
      full_name: anonymizedUser.full_name,
      phone_number: anonymizedUser.phone_number,
      telegram_id: anonymizedUser.telegram_id,
      telegram_username: anonymizedUser.telegram_username,
      county: anonymizedUser.county,
      is_active: anonymizedUser.is_active
    });

    if (anonymizedUser.full_name !== `Deleted User [${userId}]`) {
      throw new Error(`Expected anonymized full_name 'Deleted User [${userId}]', got '${anonymizedUser.full_name}'`);
    }
    if (anonymizedUser.phone_number !== null) {
      throw new Error(`Expected phone_number to be nullified, got '${anonymizedUser.phone_number}'`);
    }
    if (anonymizedUser.telegram_id !== null) {
      throw new Error(`Expected telegram_id to be nullified, got '${anonymizedUser.telegram_id}'`);
    }
    if (anonymizedUser.telegram_username !== null) {
      throw new Error(`Expected telegram_username to be nullified, got '${anonymizedUser.telegram_username}'`);
    }
    if (anonymizedUser.county !== null) {
      throw new Error(`Expected county to be nullified, got '${anonymizedUser.county}'`);
    }
    if (anonymizedUser.is_active !== false) {
      throw new Error(`Expected is_active to be false, got ${anonymizedUser.is_active}`);
    }
    console.log("  - Profile personal data fields anonymized successfully.");

    // Verify crop submissions deleted
    const dbSubmissions = await pool.query("SELECT COUNT(*)::int AS count FROM crop_submissions WHERE user_id = $1", [userId]);
    if (dbSubmissions.rows[0].count !== 0) {
      throw new Error(`Expected all crop submissions database records to be deleted for user, got count: ${dbSubmissions.rows[0].count}`);
    }
    console.log("  - Crop submissions records deleted successfully.");

    // Verify farms deleted
    const dbFarms = await pool.query("SELECT COUNT(*)::int AS count FROM farms WHERE user_id = $1", [userId]);
    if (dbFarms.rows[0].count !== 0) {
      throw new Error(`Expected all farm records to be deleted for user, got count: ${dbFarms.rows[0].count}`);
    }
    console.log("  - Farm records deleted successfully.");

    // Verify token ledger RETAINED (anonymously)
    const dbLedger = await pool.query("SELECT COUNT(*)::int AS count FROM token_ledger WHERE user_id = $1", [userId]);
    if (dbLedger.rows[0].count !== 1) {
      throw new Error(`Expected token ledger records to be RETAINED, got count: ${dbLedger.rows[0].count}`);
    }
    console.log("  - Token ledger history retained for audit.");

    // Verify readings RETAINED (anonymously)
    const dbReadings = await pool.query("SELECT COUNT(*)::int AS count FROM atmospheric_readings WHERE user_id = $1", [userId]);
    if (dbReadings.rows[0].count !== 1) {
      throw new Error(`Expected atmospheric readings records to be RETAINED, got count: ${dbReadings.rows[0].count}`);
    }
    console.log("  - Atmospheric readings history retained for blockchain tracking.");

    console.log("✅ Test 4 passed (Account cleanup & anonymisation logic verify OK).");

    console.log("\n⭐️ ALL DPA COMPLIANCE INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ DPA compliance test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
