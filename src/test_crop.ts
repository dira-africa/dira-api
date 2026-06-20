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
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { env } from "./config/env";
import cropSubmissionsRoutes from "./routes/cropSubmissions";
import jwt from "@fastify/jwt";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import { errorHandler } from "./middleware/errorHandler";

async function runTests() {
  const server = Fastify();

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);

  server.setErrorHandler(errorHandler);

  // Register crop submissions routes
  await server.register(cropSubmissionsRoutes, { prefix: "/api/crop-submissions" });

  await server.ready();

  const tempGreenPath = path.join(__dirname, "temp_green.jpg");
  const tempBrownPath = path.join(__dirname, "temp_brown.jpg");

  try {
    console.log("Creating temporary test images using sharp...");
    
    // Create mostly green image buffer (ExG greenness analysis test)
    const greenBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 20, g: 180, b: 20 }
      }
    })
    .jpeg()
    .toBuffer();

    // Create mostly brown/red image buffer (low vegetation rejection test)
    const brownBuffer = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 120, g: 60, b: 20 }
      }
    })
    .jpeg()
    .toBuffer();

    // Check if PostGIS is installed, otherwise create mocks
    let postgisAvailable = true;
    try {
      const checkRes = await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'st_makepoint';");
      if (checkRes.rows.length === 0) {
        postgisAvailable = false;
      }
    } catch (e) {
      postgisAvailable = false;
    }

    if (!postgisAvailable) {
      console.warn("⚠️ PostGIS functions are not available. Setting up PostGIS mock functions for test_crop...");
      
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geometry') THEN
            CREATE TYPE geometry AS (dummy text);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geography') THEN
            CREATE TYPE geography AS (dummy text);
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

        CREATE OR REPLACE FUNCTION geometry_to_geography(geom geometry) RETURNS geography AS $$
        BEGIN
          RETURN ROW(geom.dummy)::geography;
        END;
        $$ LANGUAGE plpgsql;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_cast 
            WHERE castsource = 'geometry'::regtype 
              AND casttarget = 'geography'::regtype
          ) THEN
            CREATE CAST (geometry AS geography) WITH FUNCTION geometry_to_geography(geometry) AS IMPLICIT;
          END IF;
        END
        $$;

        CREATE OR REPLACE FUNCTION ST_Distance(g1 geography, g2 geography) RETURNS double precision AS $$
        DECLARE
          p1 text;
          p2 text;
          x1 double precision;
          y1 double precision;
          x2 double precision;
          y2 double precision;
          dist double precision;
        BEGIN
          p1 := (g1).dummy;
          p2 := (g2).dummy;
          
          x1 := split_part(replace(replace(p1, 'POINT(', ''), ')', ''), ' ', 1)::double precision;
          y1 := split_part(replace(replace(p1, 'POINT(', ''), ')', ''), ' ', 2)::double precision;
          
          x2 := split_part(replace(replace(p2, 'POINT(', ''), ')', ''), ' ', 1)::double precision;
          y2 := split_part(replace(replace(p2, 'POINT(', ''), ')', ''), ' ', 2)::double precision;
          
          dist := sqrt(power(x1 - x2, 2) + power(y1 - y2, 2)) * 111000;
          RETURN dist;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }

    console.log("Cleaning up previous test crop data...");
    // Retrieve or delete existing test crop farmer data
    const existingUserRes = await pool.query("SELECT id FROM users WHERE telegram_id = 11223344");
    if (existingUserRes.rows.length > 0) {
      const uId = existingUserRes.rows[0].id;
      await pool.query("DELETE FROM crop_submissions WHERE user_id = $1", [uId]);
      await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [uId]);
      await pool.query("DELETE FROM farms WHERE user_id = $1", [uId]);
      await pool.query("DELETE FROM users WHERE id = $1", [uId]);
    }

    console.log("Seeding test user and farm (Nairobi base: 36.8219, -1.2921)...");
    const userRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (11223344, 'test_crop_farmer', pgp_sym_encrypt('+254700000000', $1), 'Test Crop Farmer', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [env.PGCRYPTO_SYMMETRIC_KEY]
    );
    const userId = userRes.rows[0].id;

    const farmRes = await pool.query(
      `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
       VALUES ($1, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 2.5, ARRAY['Maize', 'Beans'], 'Nairobi', 'Westlands')
       RETURNING id`,
      [userId]
    );
    const farmId = farmRes.rows[0].id;

    // Generate JWT token for requests
    const token = server.jwt.sign({ id: userId, role: "farmer" });

    // --- TEST 1: Get Pre-signed Upload URL ---
    console.log("\n--- TEST 1: Request pre-signed upload URL ---");
    const resUrl = await server.inject({
      method: "POST",
      url: "/api/crop-submissions/upload-url",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Response status: ${resUrl.statusCode}`);
    const bodyUrl = JSON.parse(resUrl.payload);
    console.log("Response body:", bodyUrl);

    if (resUrl.statusCode !== 200 || !bodyUrl.success) {
      throw new Error(`Failed to generate upload URL. Status: ${resUrl.statusCode}`);
    }
    if (!bodyUrl.uploadUrl || !bodyUrl.photoUrl || !bodyUrl.filename) {
      throw new Error("Missing url fields in response.");
    }
    console.log("✅ Test 1 passed!");

    // --- TEST 2: Upload Green Image via PUT route ---
    console.log("\n--- TEST 2: PUT upload green image binary to local emulator ---");
    const uploadUrlPath = bodyUrl.uploadUrl.substring(bodyUrl.uploadUrl.indexOf("/api/crop-submissions/upload/"));
    
    const resUpload = await server.inject({
      method: "PUT",
      url: uploadUrlPath,
      headers: { "content-type": "image/jpeg" },
      payload: greenBuffer
    });

    console.log(`Response status: ${resUpload.statusCode}`);
    const bodyUpload = JSON.parse(resUpload.payload);
    console.log("Response body:", bodyUpload);

    if (resUpload.statusCode !== 200 || !bodyUpload.success) {
      throw new Error(`File upload failed. Status: ${resUpload.statusCode}`);
    }
    console.log("✅ Test 2 passed!");

    // --- TEST 3: Submit valid crop submission (Within 500m, Green Image, Crop Matches) ---
    console.log("\n--- TEST 3: Submit valid crop submission ---");
    const resSubmit = await server.inject({
      method: "POST",
      url: "/api/crop-submissions",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        photoUrl: bodyUrl.photoUrl,
        cropType: "Maize",
        growthStage: "Vegetative",
        latitude: -1.2921,
        longitude: 36.8219
      }
    });

    console.log(`Response status: ${resSubmit.statusCode}`);
    const bodySubmit = JSON.parse(resSubmit.payload);
    console.log("Response body:", bodySubmit);

    if (resSubmit.statusCode !== 200 || bodySubmit.verificationStatus !== "verified") {
      throw new Error(`Expected successful crop verification. Got status: ${resSubmit.statusCode}, body: ${JSON.stringify(bodySubmit)}`);
    }

    // Verify token ledger updates
    const ledgerRes = await pool.query(
      "SELECT amount, balance_after, transaction_type, reference_id FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    );

    if (ledgerRes.rows.length === 0) {
      throw new Error("No token ledger entries found for user.");
    }
    const ledgerEntry = ledgerRes.rows[0];
    console.log("Token ledger entry:", ledgerEntry);
    if (ledgerEntry.amount !== 15 || ledgerEntry.balance_after !== 15 || ledgerEntry.transaction_type !== "crop_photo") {
      throw new Error(`Token award ledger properties incorrect. Entry: ${JSON.stringify(ledgerEntry)}`);
    }
    console.log("✅ Test 3 passed!");

    // --- TEST 4: Spoofed Location Check (Distance > 500m) ---
    console.log("\n--- TEST 4: Submit crop submission at spoofed location (>500m) ---");
    // Generate new URL and upload photo
    const resUrl2 = await server.inject({
      method: "POST",
      url: "/api/crop-submissions/upload-url",
      headers: { Authorization: `Bearer ${token}` }
    });
    const bodyUrl2 = JSON.parse(resUrl2.payload);
    const uploadUrlPath2 = bodyUrl2.uploadUrl.substring(bodyUrl2.uploadUrl.indexOf("/api/crop-submissions/upload/"));
    
    await server.inject({
      method: "PUT",
      url: uploadUrlPath2,
      headers: { "content-type": "image/jpeg" },
      payload: greenBuffer
    });

    // Submit coordinates 15km away
    const resSubmitSpoof = await server.inject({
      method: "POST",
      url: "/api/crop-submissions",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        photoUrl: bodyUrl2.photoUrl,
        cropType: "Maize",
        growthStage: "Vegetative",
        latitude: -1.3921, // ~11km South
        longitude: 36.9219 // ~11km East
      }
    });

    console.log(`Response status: ${resSubmitSpoof.statusCode}`);
    const bodySubmitSpoof = JSON.parse(resSubmitSpoof.payload);
    console.log("Response body:", bodySubmitSpoof);

    if (resSubmitSpoof.statusCode !== 400 || bodySubmitSpoof.verificationStatus !== "rejected") {
      throw new Error(`Expected location rejection block. Got status: ${resSubmitSpoof.statusCode}, body: ${JSON.stringify(bodySubmitSpoof)}`);
    }
    if (bodySubmitSpoof.error.code !== "SPOOF_LOCATION_REJECTED") {
      throw new Error(`Expected error code SPOOF_LOCATION_REJECTED. Got: ${bodySubmitSpoof.error.code}`);
    }

    // Verify submission record in DB was set to rejected
    const subResDb = await pool.query(
      "SELECT verification_status, rejection_reason FROM crop_submissions WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1",
      [userId]
    );
    const latestSubmission = subResDb.rows[0];
    console.log("DB crop submission record:", latestSubmission);
    if (latestSubmission.verification_status !== "rejected" || !latestSubmission.rejection_reason.includes("too far")) {
      throw new Error(`Verification status in DB should be rejected. Record: ${JSON.stringify(latestSubmission)}`);
    }
    console.log("✅ Test 4 passed!");

    // --- TEST 5: Low Greenness Check (Brown Image Rejection) ---
    console.log("\n--- TEST 5: Submit low greenness crop photo ---");
    // Generate new URL
    const resUrl3 = await server.inject({
      method: "POST",
      url: "/api/crop-submissions/upload-url",
      headers: { Authorization: `Bearer ${token}` }
    });
    const bodyUrl3 = JSON.parse(resUrl3.payload);
    const uploadUrlPath3 = bodyUrl3.uploadUrl.substring(bodyUrl3.uploadUrl.indexOf("/api/crop-submissions/upload/"));
    
    // Upload brown/dead image
    await server.inject({
      method: "PUT",
      url: uploadUrlPath3,
      headers: { "content-type": "image/jpeg" },
      payload: brownBuffer
    });

    // Submit metadata with correct coordinates
    const resSubmitLowGreen = await server.inject({
      method: "POST",
      url: "/api/crop-submissions",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        photoUrl: bodyUrl3.photoUrl,
        cropType: "Maize",
        growthStage: "Vegetative",
        latitude: -1.2921,
        longitude: 36.8219
      }
    });

    console.log(`Response status: ${resSubmitLowGreen.statusCode}`);
    const bodySubmitLowGreen = JSON.parse(resSubmitLowGreen.payload);
    console.log("Response body:", bodySubmitLowGreen);

    if (resSubmitLowGreen.statusCode !== 422 || bodySubmitLowGreen.verificationStatus !== "rejected") {
      throw new Error(`Expected low greenness rejection block. Got status: ${resSubmitLowGreen.statusCode}`);
    }
    if (bodySubmitLowGreen.error.code !== "AI_VERIFICATION_FAILED") {
      throw new Error(`Expected error code AI_VERIFICATION_FAILED. Got: ${bodySubmitLowGreen.error.code}`);
    }
    if (!bodySubmitLowGreen.error.message.includes("Low greenness")) {
      throw new Error(`Expected error message to mention greenness. Message: ${bodySubmitLowGreen.error.message}`);
    }

    console.log("✅ Test 5 passed!");

    // Cleanup generated file uploads from public/uploads folder
    const uploadsDir = path.join(__dirname, "../public/uploads");
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const file of files) {
        if (file.startsWith("crop_") && file.endsWith(".jpg")) {
          fs.unlinkSync(path.join(uploadsDir, file));
        }
      }
    }

    console.log("\n⭐️ ALL CROP VERIFICATION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Crop verification test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
