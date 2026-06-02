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
import jwt from "@fastify/jwt";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import adminRoutes from "./routes/admin";
import { pool } from "./db/pool";
import { redis } from "./db/redis";
import { env } from "./config/env";
import bcryptjs from "bcryptjs";
import fp from "fastify-plugin";

async function runTests() {
  console.log("Initializing test Fastify server for admin modules...");
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register plugins matching server.ts
  await server.register(jwt, { secret: env.JWT_SECRET });
  
  const adminJwtPlugin = (inst: any, opts: any, next: any) => {
    return jwt(inst, opts, next);
  };
  await server.register(fp(adminJwtPlugin), {
    secret: env.JWT_SECRET + "_admin_hardened",
    namespace: "admin"
  });

  // Mock Notification Queue to prevent Redis queue errors in test context
  server.decorate("notificationsQueue", {
    add: async (name: string, payload: any) => {
      console.log(`[MOCK NOTIFICATIONS QUEUE] Job added: ${name}`, payload);
      return { id: "mock-job-id" };
    }
  });

  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(adminRoutes, { prefix: "/api/admin" });

  await server.ready();

  const testAdminEmail = "admin_modules_test@dira.africa";
  const testFarmerEmail = "farmer_modules_test@dira.africa";
  const testAgentEmail = "agent_modules_test@dira.africa";
  const testPassword = "SuperSecurePassword123!@#";

  try {
    console.log("Cleaning up database tables from previous tests...");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM crop_submissions");
    await pool.query("DELETE FROM farms");
    await pool.query("DELETE FROM atmospheric_readings");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM users WHERE email IN ($1, $2, $3) OR telegram_id IN (11223344, 55667788)", [testAdminEmail, testFarmerEmail, testAgentEmail]);

    console.log("Seeding test administrator user...");
    const adminPwdHash = await bcryptjs.hash(testPassword, 12);
    const adminUserRes = await pool.query(
      `INSERT INTO users (email, password_hash, role, full_name, language, is_active)
       VALUES ($1, $2, 'admin', 'Test Admin Modules', 'en', TRUE) RETURNING id`,
      [testAdminEmail, adminPwdHash]
    );
    const adminId = adminUserRes.rows[0].id;

    console.log("Seeding test farmer and agent users...");
    const farmerRes = await pool.query(
      `INSERT INTO users (email, role, full_name, telegram_id, language, county, is_active, is_verified)
       VALUES ($1, 'farmer', 'Test Farmer Node', 11223344, 'sw', 'Nairobi', TRUE, FALSE) RETURNING id`,
      [testFarmerEmail]
    );
    const farmerId = farmerRes.rows[0].id;

    console.log("Seeding test farm for the farmer...");
    const farmRes = await pool.query(
      `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
       VALUES ($1, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 2.5, ARRAY['maize', 'beans', 'wheat'], 'Nairobi', 'Dagoretti') RETURNING id`,
      [farmerId]
    );
    const farmId = farmRes.rows[0].id;

    const agentRes = await pool.query(
      `INSERT INTO users (email, role, full_name, telegram_id, language, county, is_active, is_verified)
       VALUES ($1, 'agent', 'Test Agent Node', 55667788, 'en', 'Mombasa', TRUE, FALSE) RETURNING id`,
      [testAgentEmail]
    );
    const agentId = agentRes.rows[0].id;

    // Generate JWT token for requests
    const adminToken = server.jwt.admin.sign({ id: adminId, role: "admin" });
    const authHeader = { authorization: `Bearer ${adminToken}` };

    // Register active session in Redis to bypass inactivity guard
    await redis.set(`dira:admin:session:${adminId}`, "active", "EX", 7200);

    console.log("\n--- TEST 1: Gated Validation of Balance Adjustments (Mandatory Notes) ---");
    // Attempt adjustment with empty notes
    const adjustFailedRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "adjust_balance", amount: 50, notes: "  " }
    });
    console.log("Empty Notes Status:", adjustFailedRes.statusCode);
    const adjustFailedBody = JSON.parse(adjustFailedRes.payload);
    if (adjustFailedRes.statusCode !== 400 || adjustFailedBody.error.code !== "MISSING_NOTES") {
      throw new Error(`Expected 400 and MISSING_NOTES, got status ${adjustFailedRes.statusCode} and body ${JSON.stringify(adjustFailedBody)}`);
    }

    // Success adjustment
    const adjustSuccessRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "adjust_balance", amount: 25, notes: "Verified seeding reward bonus" }
    });
    console.log("Success Status:", adjustSuccessRes.statusCode);
    if (adjustSuccessRes.statusCode !== 200) {
      throw new Error(`Expected 200, got ${adjustSuccessRes.statusCode}. Payload: ${adjustSuccessRes.payload}`);
    }

    // Verify token ledger entry is created and balance is adjusted
    const balanceRes = await pool.query("SELECT COALESCE(SUM(amount), 0) AS balance FROM token_ledger WHERE user_id = $1", [farmerId]);
    const balance = Number(balanceRes.rows[0].balance);
    if (balance !== 25) {
      throw new Error(`Expected balance to be 25, got ${balance}`);
    }
    console.log("✅ Test 1 passed (Adjustment note validations and credit verified)!");

    console.log("\n--- TEST 2: User Status Transitions (Verify and Suspend with Reason) ---");
    // Verify farmer user
    const verifyRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "verify" }
    });
    console.log("Verify Status:", verifyRes.statusCode);
    const verifyDB = await pool.query("SELECT is_verified FROM users WHERE id = $1", [farmerId]);
    if (!verifyDB.rows[0].is_verified) {
      throw new Error("User was not marked verified in database.");
    }

    // Suspend farmer user with empty reason (should fail)
    const suspendFailRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "suspend", reason: "   " }
    });
    console.log("Suspend Empty Reason Status:", suspendFailRes.statusCode);
    if (suspendFailRes.statusCode !== 400) {
      throw new Error(`Expected 400, got ${suspendFailRes.statusCode}`);
    }

    // Suspend with valid reason
    const suspendSuccessRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "suspend", reason: "Abusing barometric sensors" }
    });
    console.log("Suspend Success Status:", suspendSuccessRes.statusCode);
    const suspendDB = await pool.query("SELECT is_active, suspension_reason, suspended_at FROM users WHERE id = $1", [farmerId]);
    if (suspendDB.rows[0].is_active || suspendDB.rows[0].suspension_reason !== "Abusing barometric sensors" || !suspendDB.rows[0].suspended_at) {
      throw new Error("User suspension details were not saved in database correctly.");
    }

    // Unsuspend
    const unsuspendRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/users/${farmerId}`,
      headers: authHeader,
      payload: { action: "unsuspend" }
    });
    console.log("Unsuspend Status:", unsuspendRes.statusCode);
    const unsuspendDB = await pool.query("SELECT is_active, suspension_reason, suspended_at FROM users WHERE id = $1", [farmerId]);
    if (!unsuspendDB.rows[0].is_active || unsuspendDB.rows[0].suspension_reason !== null || unsuspendDB.rows[0].suspended_at !== null) {
      throw new Error("Unsuspend failed to restore active flag.");
    }
    console.log("✅ Test 2 passed (Verify & Suspend transitions verified)!");

    console.log("\n--- TEST 3: Crop Data Review Queue: Approval, Rejection, and Escalation ---");
    // Seed crop submissions for review queue
    const cropSubmissionRes1 = await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, crop_type, growth_stage, verification_status, photo_url, photo_thumbnail_url, ai_health_score, ai_confidence, location)
       VALUES ($1, $2, 'maize', 'vegetative', 'manual_review', 'http://image1.jpg', 'http://image1_thumb.jpg', 0.85, 0.92, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)) RETURNING id`,
      [farmerId, farmId]
    );
    const crop1Id = cropSubmissionRes1.rows[0].id;

    const cropSubmissionRes2 = await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, crop_type, growth_stage, verification_status, photo_url, photo_thumbnail_url, ai_health_score, ai_confidence, location)
       VALUES ($1, $2, 'beans', 'flowering', 'manual_review', 'http://image2.jpg', 'http://image2_thumb.jpg', 0.20, 0.40, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)) RETURNING id`,
      [farmerId, farmId]
    );
    const crop2Id = cropSubmissionRes2.rows[0].id;

    // Fetch review queue
    const reviewQueueRes = await server.inject({
      method: "GET",
      url: "/api/admin/review-queue",
      headers: authHeader
    });
    const reviewQueue = JSON.parse(reviewQueueRes.payload);
    console.log("Review Queue crop count:", reviewQueue.cropSubmissions.length);
    if (reviewQueue.cropSubmissions.length !== 2) {
      throw new Error(`Expected 2 crop submissions in review queue, got ${reviewQueue.cropSubmissions.length}`);
    }

    // Approve crop 1 (should credit 15 tokens)
    const approveCropRes = await server.inject({
      method: "POST",
      url: `/api/admin/review-queue/crop/${crop1Id}`,
      headers: authHeader,
      payload: { action: "approve" }
    });
    console.log("Approve Crop Status:", approveCropRes.statusCode);
    const crop1DB = await pool.query("SELECT verification_status, verified_at FROM crop_submissions WHERE id = $1", [crop1Id]);
    if (crop1DB.rows[0].verification_status !== "verified" || !crop1DB.rows[0].verified_at) {
      throw new Error("Crop was not marked verified in database.");
    }
    const cropLedgerDB = await pool.query("SELECT amount FROM token_ledger WHERE reference_id = $1 AND transaction_type = 'crop_photo'", [crop1Id]);
    if (cropLedgerDB.rows.length === 0 || Number(cropLedgerDB.rows[0].amount) !== 15) {
      throw new Error("Token ledger entry for 15 tokens was not successfully created.");
    }

    // Reject crop 2 without reason (should fail)
    const rejectCropFailRes = await server.inject({
      method: "POST",
      url: `/api/admin/review-queue/crop/${crop2Id}`,
      headers: authHeader,
      payload: { action: "reject", reason: "  " }
    });
    console.log("Reject Crop Empty Reason Status:", rejectCropFailRes.statusCode);
    if (rejectCropFailRes.statusCode !== 400) {
      throw new Error("Rejection with empty reason should return 400 bad request");
    }

    // Reject crop 2 with valid reason
    const rejectCropSuccessRes = await server.inject({
      method: "POST",
      url: `/api/admin/review-queue/crop/${crop2Id}`,
      headers: authHeader,
      payload: { action: "reject", reason: "Invalid growth stage matching beans" }
    });
    console.log("Reject Crop Success Status:", rejectCropSuccessRes.statusCode);
    const crop2DB = await pool.query("SELECT verification_status, rejection_reason FROM crop_submissions WHERE id = $1", [crop2Id]);
    if (crop2DB.rows[0].verification_status !== "rejected" || crop2DB.rows[0].rejection_reason !== "Invalid growth stage matching beans") {
      throw new Error("Crop rejection details was not recorded in database.");
    }

    // Seed another crop for escalation
    const cropSubmissionRes3 = await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, crop_type, growth_stage, verification_status, photo_url, photo_thumbnail_url, ai_health_score, ai_confidence, location)
       VALUES ($1, $2, 'wheat', 'harvested', 'manual_review', 'http://image3.jpg', 'http://image3_thumb.jpg', 0.90, 0.95, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326)) RETURNING id`,
      [farmerId, farmId]
    );
    const crop3Id = cropSubmissionRes3.rows[0].id;

    // Escalate crop 3
    const escalateCropRes = await server.inject({
      method: "POST",
      url: `/api/admin/review-queue/crop/${crop3Id}`,
      headers: authHeader,
      payload: { action: "escalate", notes: "Check with regional agronomist office" }
    });
    console.log("Escalate Crop Status:", escalateCropRes.statusCode);
    const crop3DB = await pool.query("SELECT verification_status, admin_notes, escalated_at FROM crop_submissions WHERE id = $1", [crop3Id]);
    if (crop3DB.rows[0].verification_status !== "escalated" || crop3DB.rows[0].admin_notes !== "Check with regional agronomist office" || !crop3DB.rows[0].escalated_at) {
      throw new Error("Crop escalation failed to save admin notes and change status.");
    }
    console.log("✅ Test 3 passed (Crop reviews: approve, reject, escalate verified)!");

    console.log("\n--- TEST 4: Weather Data Review Queue: Anomalous Readings ---");
    // Seed anomalous atmospheric reading
    const readingRes1 = await pool.query(
      `INSERT INTO atmospheric_readings (user_id, pressure_hpa, altitude_m, temperature_c, humidity_pct, anomaly_score, verified, recorded_at, location)
       VALUES ($1, 1008.2, 1600.0, 24.5, 62.0, 0.35, FALSE, CURRENT_TIMESTAMP, ST_SetSRID(ST_MakePoint(39.6682, -4.0435), 4326)) RETURNING id`,
      [agentId]
    );
    const reading1Id = readingRes1.rows[0].id;

    // Fetch queue and verify reading is fetched
    const reviewQueueRes2 = await server.inject({
      method: "GET",
      url: "/api/admin/review-queue",
      headers: authHeader
    });
    const reviewQueue2 = JSON.parse(reviewQueueRes2.payload);
    console.log("Review Queue weather count:", reviewQueue2.atmosphericReadings.length);
    if (reviewQueue2.atmosphericReadings.length !== 1) {
      throw new Error("Atmospheric reading missing from review queue.");
    }

    // Approve weather reading (re-credited token award)
    const approveWeatherRes = await server.inject({
      method: "POST",
      url: `/api/admin/review-queue/atmospheric/${reading1Id}`,
      headers: authHeader,
      payload: { action: "approve" }
    });
    console.log("Approve Weather Status:", approveWeatherRes.statusCode);
    const reading1DB = await pool.query("SELECT verified, verification_status FROM atmospheric_readings WHERE id = $1", [reading1Id]);
    if (!reading1DB.rows[0].verified || reading1DB.rows[0].verification_status !== "verified") {
      throw new Error("Atmospheric reading failed to update status to verified.");
    }
    // Verify token ledger created 1 token
    const weatherLedgerDB = await pool.query("SELECT amount FROM token_ledger WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync'", [reading1Id]);
    if (weatherLedgerDB.rows.length === 0 || Number(weatherLedgerDB.rows[0].amount) !== 1) {
      throw new Error("Token ledger entry for 1 token was not successfully created for approved weather sync.");
    }
    console.log("✅ Test 4 passed (Weather readings approval and token credit verified)!");

    console.log("\n--- TEST 5: Financial Dashboard Telemetry & Paged Redemptions ---");
    // Seed completed and failed redemptions
    await pool.query(
      `INSERT INTO redemption_requests (id, user_id, tokens_spent, redemption_type, amount_kes, status, initiated_at, phone_number, failure_reason)
       VALUES 
         ('5c29a8a7-75cb-4db8-8422-79ee88667cb1', $1, 50, 'airtime', 50.00, 'completed', CURRENT_TIMESTAMP - INTERVAL '1 day', pgp_sym_encrypt('254712345678', $2), NULL),
         ('5c29a8a7-75cb-4db8-8422-79ee88667cb2', $1, 200, 'mpesa', 200.00, 'failed', CURRENT_TIMESTAMP, pgp_sym_encrypt('254787654321', $2), 'Daraja M-Pesa client timeout error')`,
      [farmerId, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    const financialsRes = await server.inject({
      method: "GET",
      url: "/api/admin/financials?page=1&limit=10",
      headers: authHeader
    });
    console.log("Financials Status:", financialsRes.statusCode);
    const financials = JSON.parse(financialsRes.payload);
    console.log("Token circulation:", financials.circulation);
    console.log("Completed redemptions summary:", financials.redeemed);
    console.log("Failed redemptions count:", financials.failed.length);
    console.log("Velocity stats count:", financials.velocity.length);
    console.log("Audit logs sample count:", financials.redemptions.length);

    if (financials.circulation !== 41) { // 25 (adjust) + 15 (crop) + 1 (weather)
      throw new Error(`Expected circulation to be 41, got ${financials.circulation}`);
    }
    if (financials.failed.length !== 1 || financials.failed[0].failure_reason !== "Daraja M-Pesa client timeout error") {
      throw new Error("Failed redemption record missing or incorrect metadata.");
    }
    // Verify phone masking in redemptions list
    if (financials.redemptions[0].phone !== "****5678" && financials.redemptions[0].phone !== "****4321") {
      throw new Error(`Phone number not properly masked. Phone: ${financials.redemptions[0].phone}`);
    }
    console.log("✅ Test 5 passed (Financial aggregations and phone masking verified)!");

    console.log("\n--- TEST 6: Partner Reports Generation (CSV Structure) ---");
    // Generate partner report in CSV
    const partnerReportCSVRes = await server.inject({
      method: "GET",
      url: "/api/admin/reports/partner?format=csv",
      headers: authHeader
    });
    console.log("Partner Report CSV Status:", partnerReportCSVRes.statusCode);
    const csvContent = partnerReportCSVRes.payload;
    console.log("CSV Header Sample:\n", csvContent.substring(0, 180));

    if (partnerReportCSVRes.statusCode !== 200 || !csvContent.startsWith("SECTION: Verified Crop Data Points")) {
      throw new Error("CSV structure missing initial partner headers.");
    }
    console.log("✅ Test 6 passed (Partner multi-section CSV report verified)!");

    console.log("\n🎉 ALL TESTS IN admin_modules SUITE PASSED SUCCESSFULLY!");
  } catch (err: any) {
    console.error("❌ TEST RUNNER FAILURE:", err);
    process.exit(1);
  } finally {
    console.log("Cleaning up test records...");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM crop_submissions");
    await pool.query("DELETE FROM farms");
    await pool.query("DELETE FROM atmospheric_readings");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM users WHERE email IN ($1, $2, $3) OR telegram_id IN (11223344, 55667788)", [testAdminEmail, testFarmerEmail, testAgentEmail]);

    // Close connections
    await redis.quit();
    await server.close();
  }
}

runTests();
