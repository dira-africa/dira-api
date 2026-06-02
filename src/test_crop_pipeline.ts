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

import { query } from "./db/query";
import { pool } from "./db/pool";
import { aiService } from "./services/aiService";
import { processPhotoVerification } from "./jobs/photoVerificationJob";
import sharp from "sharp";
import fs from "fs";
import path from "path";
import { Job } from "bullmq";

const TEST_USER_ID = "11111111-1111-1111-1111-111111111111";
const TEST_FARM_ID = "22222222-2222-2222-2222-222222222222";
const UPLOADS_DIR = path.join(__dirname, "../public/uploads");

// Helper to mock BullMQ Job structure
function mockJob(data: any): Job {
  return {
    id: "test-job-id",
    name: "crop-photo-verification",
    data,
    queueName: "photo-verification",
    opts: { attempts: 3 },
    attemptsMade: 0,
  } as unknown as Job;
}

async function setupDatabase() {
  console.log("Setting up PostGIS test mocks if needed...");
  try {
    await query(`
      CREATE OR REPLACE FUNCTION PostGIS_version() RETURNS text AS $$
      BEGIN RETURN '3.4.2 MOCK'; END;
      $$ LANGUAGE plpgsql;
    `);
  } catch (err) {}

  console.log("Seeding test user and farm...");
  
  // Clear existing
  await query("DELETE FROM token_ledger WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM crop_submissions WHERE user_id = $1", [TEST_USER_ID]);
  await query("DELETE FROM farms WHERE id = $1", [TEST_FARM_ID]);
  await query("DELETE FROM users WHERE id = $1", [TEST_USER_ID]);

  // Insert user
  await query(
    `INSERT INTO users (id, telegram_id, phone_number, full_name, role, county)
     VALUES ($1, 999999, 'enc_phone_placeholder', 'Test Farmer', 'farmer', 'Nairobi')`,
    [TEST_USER_ID]
  );

  // Insert farm at Nairobi coordinates (lat -1.2921, lon 36.8219)
  await query(
    `INSERT INTO farms (id, user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 2.5, '{"Maize"}', 'Nairobi', 'Central')`,
    [TEST_FARM_ID, TEST_USER_ID]
  );

  // Setup initial token balance of 100 DIRA
  await query(
    `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, notes)
     VALUES ($1, 100, 100, 'bonus', 'Initial test balance')`,
    [TEST_USER_ID]
  );
}

async function generateTestImages() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  const width = 300;
  const height = 300;

  // 1. Healthy Maize Photo (Mostly Green, with noise to pass solid-color and blur checks)
  const healthyRaw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const gradG = Math.floor(100 + (x / width) * 100);
      const gradR = Math.floor(20 + (y / height) * 40);
      const noise = Math.floor(Math.random() * 30);
      healthyRaw[idx] = Math.min(255, gradR + noise);
      healthyRaw[idx + 1] = Math.min(255, gradG + noise);
      healthyRaw[idx + 2] = Math.min(255, 10 + noise);
    }
  }
  await sharp(healthyRaw, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toFile(path.join(UPLOADS_DIR, "test_healthy_maize.jpg"));

  // 2. Solid Color screenshot (zero color variance)
  await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 3,
      background: { r: 240, g: 240, b: 240 }
    }
  })
  .jpeg()
  .toFile(path.join(UPLOADS_DIR, "test_solid_screenshot.jpg"));

  // 3. Blurry Photo (Out of focus - very smooth gradient with no high-frequency variance)
  const blurryRaw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < blurryRaw.length; i += 3) {
    const x = (i / 3) % width;
    blurryRaw[i] = 40;
    blurryRaw[i + 1] = Math.floor(100 + (x / width) * 15); // very smooth green gradient
    blurryRaw[i + 2] = 40;
  }
  await sharp(blurryRaw, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toFile(path.join(UPLOADS_DIR, "test_blurry.jpg"));

  console.log("Generated mock verification images inside uploads directory.");
}

async function runTests() {
  console.log("\nStarting Crop Photo AI Verification Integration Tests...\n");

  // Fetch initial balance
  const initialBalanceRes = await query(
    "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [TEST_USER_ID]
  );
  let currentBalance = Number(initialBalanceRes.rows[0].balance_after);
  console.log(`Starting Balance: ${currentBalance} DIRA`);

  // ==========================================
  // TEST 1: Upload a real maize photo
  // ==========================================
  console.log("\n--- TEST 1: Real Maize Photo ---");
  const submissionId1 = "11111111-0000-0000-0000-000000000001";
  
  // Seed crop submission
  await query(
    `INSERT INTO crop_submissions (id, user_id, farm_id, photo_url, location, crop_type, growth_stage, ai_health_score, ai_confidence)
     VALUES ($1, $2, $3, 'http://localhost/uploads/test_healthy_maize.jpg', ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 'Maize', 'Vegetative', 0, 0)`,
    [submissionId1, TEST_USER_ID, TEST_FARM_ID]
  );

  const job1 = mockJob({
    submissionId: submissionId1,
    userId: TEST_USER_ID,
    farmId: TEST_FARM_ID,
    photoUrl: "http://localhost/uploads/test_healthy_maize.jpg",
    cropType: "Maize",
    growthStage: "Vegetative",
    latitude: -1.2921,
    longitude: 36.8219
  });

  const res1 = await processPhotoVerification(job1);
  console.log("Result:", res1);

  // Assertions for Test 1
  const dbSub1 = await query("SELECT verification_status, ai_health_score, ai_report_sw FROM crop_submissions WHERE id = $1", [submissionId1]);
  const status1 = dbSub1.rows[0].verification_status;
  const score1 = Number(dbSub1.rows[0].ai_health_score);
  const reportSw = dbSub1.rows[0].ai_report_sw;

  if (status1 !== "verified") throw new Error(`Test 1 Failed: Expected status verified, got ${status1}`);
  if (score1 <= 0) throw new Error(`Test 1 Failed: Expected health score > 0, got ${score1}`);
  if (!reportSw.includes("Uchunguzi") && !reportSw.includes("Tafsiri")) {
    throw new Error(`Test 1 Failed: Swahili report does not contain translated Swahili agricultural terms`);
  }
  console.log("✅ Test 1 Passed: Verified, health score present, Swahili translation successful!");

  // ==========================================
  // TEST 2: Solid-colour screenshot
  // ==========================================
  console.log("\n--- TEST 2: Solid-Colour Screenshot ---");
  const submissionId2 = "11111111-0000-0000-0000-000000000002";
  
  await query(
    `INSERT INTO crop_submissions (id, user_id, farm_id, photo_url, location, crop_type, growth_stage, ai_health_score, ai_confidence)
     VALUES ($1, $2, $3, 'http://localhost/uploads/test_solid_screenshot.jpg', ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 'Maize', 'Vegetative', 0, 0)`,
    [submissionId2, TEST_USER_ID, TEST_FARM_ID]
  );

  const job2 = mockJob({
    submissionId: submissionId2,
    userId: TEST_USER_ID,
    farmId: TEST_FARM_ID,
    photoUrl: "http://localhost/uploads/test_solid_screenshot.jpg",
    cropType: "Maize",
    growthStage: "Vegetative",
    latitude: -1.2921,
    longitude: 36.8219
  });

  const res2 = await processPhotoVerification(job2);
  console.log("Result:", res2);

  const dbSub2 = await query("SELECT verification_status, rejection_reason FROM crop_submissions WHERE id = $1", [submissionId2]);
  const status2 = dbSub2.rows[0].verification_status;
  const reason2 = dbSub2.rows[0].rejection_reason;

  if (status2 !== "rejected") throw new Error(`Test 2 Failed: Expected status rejected, got ${status2}`);
  if (reason2 !== "SCREENSHOT_REJECTED") throw new Error(`Test 2 Failed: Expected reason SCREENSHOT_REJECTED, got ${reason2}`);
  console.log("✅ Test 2 Passed: Rejected solid colour screenshots correctly!");

  // ==========================================
  // TEST 3: Blurry Photo (Out of Focus)
  // ==========================================
  console.log("\n--- TEST 3: Blurry Photo ---");
  const submissionId3 = "11111111-0000-0000-0000-000000000003";

  await query(
    `INSERT INTO crop_submissions (id, user_id, farm_id, photo_url, location, crop_type, growth_stage, ai_health_score, ai_confidence)
     VALUES ($1, $2, $3, 'http://localhost/uploads/test_blurry.jpg', ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 'Maize', 'Vegetative', 0, 0)`,
    [submissionId3, TEST_USER_ID, TEST_FARM_ID]
  );

  const job3 = mockJob({
    submissionId: submissionId3,
    userId: TEST_USER_ID,
    farmId: TEST_FARM_ID,
    photoUrl: "http://localhost/uploads/test_blurry.jpg",
    cropType: "Maize",
    growthStage: "Vegetative",
    latitude: -1.2921,
    longitude: 36.8219
  });

  const res3 = await processPhotoVerification(job3);
  console.log("Result:", res3);

  const dbSub3 = await query("SELECT verification_status, rejection_reason FROM crop_submissions WHERE id = $1", [submissionId3]);
  const status3 = dbSub3.rows[0].verification_status;
  const reason3 = dbSub3.rows[0].rejection_reason;

  if (status3 !== "rejected") throw new Error(`Test 3 Failed: Expected status rejected, got ${status3}`);
  if (reason3 !== "IMAGE_QUALITY_TOO_LOW") throw new Error(`Test 3 Failed: Expected reason IMAGE_QUALITY_TOO_LOW, got ${reason3}`);
  console.log("✅ Test 3 Passed: Rejected out-of-focus blurry photos correctly!");

  // ==========================================
  // TEST 4: Upload from GPS 20km from farm (Geo Anomaly)
  // ==========================================
  console.log("\n--- TEST 4: GPS 20km from Farm ---");
  const submissionId4 = "11111111-0000-0000-0000-000000000004";

  // Re-generate healthy maize photo in uploads to ensure it exists for Test 4
  const width = 300;
  const height = 300;
  const healthyRaw4 = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const gradG = Math.floor(100 + (x / width) * 100);
      const gradR = Math.floor(20 + (y / height) * 40);
      const noise = Math.floor(Math.random() * 30);
      healthyRaw4[idx] = Math.min(255, gradR + noise);
      healthyRaw4[idx + 1] = Math.min(255, gradG + noise);
      healthyRaw4[idx + 2] = Math.min(255, 10 + noise);
    }
  }
  await sharp(healthyRaw4, { raw: { width, height, channels: 3 } })
    .jpeg()
    .toFile(path.join(UPLOADS_DIR, "test_healthy_maize_20km.jpg"));

  // Coordinates approximately 20km away from farm (Nairobi center -1.2921, 36.8219)
  // E.g. (lat -1.45, lon 36.9)
  await query(
    `INSERT INTO crop_submissions (id, user_id, farm_id, photo_url, location, crop_type, growth_stage, ai_health_score, ai_confidence)
     VALUES ($1, $2, $3, 'http://localhost/uploads/test_healthy_maize_20km.jpg', ST_SetSRID(ST_MakePoint(36.9, -1.45), 4326), 'Maize', 'Vegetative', 0, 0)`,
    [submissionId4, TEST_USER_ID, TEST_FARM_ID]
  );

  const job4 = mockJob({
    submissionId: submissionId4,
    userId: TEST_USER_ID,
    farmId: TEST_FARM_ID,
    photoUrl: "http://localhost/uploads/test_healthy_maize_20km.jpg",
    cropType: "Maize",
    growthStage: "Vegetative",
    latitude: -1.45,
    longitude: 36.9
  });

  const res4 = await processPhotoVerification(job4);
  console.log("Result:", res4);

  const dbSub4 = await query("SELECT verification_status, ai_detected_issues FROM crop_submissions WHERE id = $1", [submissionId4]);
  const status4 = dbSub4.rows[0].verification_status;
  const issues4 = dbSub4.rows[0].ai_detected_issues;

  if (status4 !== "verified") throw new Error(`Test 4 Failed: Expected status verified, got ${status4}`);
  if (issues4.geo_anomaly !== true) throw new Error(`Test 4 Failed: Expected geo_anomaly to be flagged as true`);
  console.log("✅ Test 4 Passed: Upload from 20km flagged as geo_anomaly but NOT rejected!");

  // ==========================================
  // TEST 5: Verify Token Ledger balance
  // ==========================================
  console.log("\n--- TEST 5: Token Ledger Verification ---");
  const finalBalanceRes = await query(
    "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [TEST_USER_ID]
  );
  const finalBalance = Number(finalBalanceRes.rows[0].balance_after);
  console.log(`Ending Balance: ${finalBalance} DIRA`);

  // Test 1 awarded tokens: Test 1 should award 6 tokens (confidence mock is 0.915, no geo anomaly)
  // Test 4 awarded tokens: Test 4 should award 5 tokens (has geo anomaly, so no bonus)
  // Total tokens added = 6 + 5 = 11 tokens.
  const expectedBalance = currentBalance + 11;

  if (finalBalance !== expectedBalance) {
    throw new Error(`Test 5 Failed: Expected final balance to be ${expectedBalance}, got ${finalBalance}`);
  }
  console.log("✅ Test 5 Passed: Token ledger successfully updated with exact reward amounts!");
}

async function main() {
  try {
    await setupDatabase();
    await generateTestImages();
    await runTests();
    console.log("\n⭐️ ALL CROP PHOTO PIPELINE INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️\n");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Integration Test Failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
