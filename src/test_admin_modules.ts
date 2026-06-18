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
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  xionAnchorQueue
} from "./jobs/queues";
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
  } as any);

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
      await pool.query("DELETE FROM voucher_redemptions");
      await pool.query("DELETE FROM agro_dealer_reconciliations");
      await pool.query("DELETE FROM dealer_product_categories");
      await pool.query("DELETE FROM agro_dealers");
      await pool.query("DELETE FROM dira_circle_distributions");
      await pool.query("DELETE FROM circle_coordinators");
      await pool.query("DELETE FROM mpesa_activation_settings");
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

    console.log("Seeding test M-Pesa settings...");
    await pool.query(
      `INSERT INTO mpesa_activation_settings (key, value) VALUES
       ('daraja_credentials_approved', FALSE),
       ('first_b2b_revenue_received', FALSE)
       ON CONFLICT (key) DO NOTHING`
    );

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

    const ledgerRows = await pool.query("SELECT * FROM token_ledger");
    console.log("TOKEN LEDGER ROWS:", ledgerRows.rows);

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

    console.log("\n--- TEST 7: Agro-Dealer Management & Vouchers Reconciliation ---");
    // Create new dealer
    const createDealerRes = await server.inject({
      method: "POST",
      url: "/api/admin/agro-dealers",
      headers: authHeader,
      payload: {
        dealerName: "Test Agro Dealer Inc",
        dealerPhone: "254711999999",
        countyId: "Nairobi",
        bankAccount: "Equity Bank 1234567890",
        transactionFeePct: 4.50,
        categories: ["seeds", "fertilizer"]
      }
    });
    console.log("Create Dealer Status:", createDealerRes.statusCode);
    const dealerPayload = JSON.parse(createDealerRes.payload);
    if (createDealerRes.statusCode !== 200 || !dealerPayload.success || !dealerPayload.dealerId) {
      throw new Error(`Failed to create agro dealer: ${createDealerRes.payload}`);
    }
    const testDealerId = dealerPayload.dealerId;

    // Get dealer list
    const getDealersRes = await server.inject({
      method: "GET",
      url: "/api/admin/agro-dealers",
      headers: authHeader
    });
    console.log("Get Dealers Status:", getDealersRes.statusCode);
    const dealersList = JSON.parse(getDealersRes.payload).agroDealers;
    const addedDealer = dealersList.find((d: any) => d.id === testDealerId);
    if (!addedDealer || addedDealer.categories.length !== 2) {
      throw new Error(`Agro dealer and categories check failed. Found dealer: ${JSON.stringify(addedDealer)}`);
    }

    // Seed an unreconciled scanned voucher for this dealer
    await pool.query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, expires_at, status, scanned_at)
       VALUES ($1, $2, 100, 55.00, 'TESTVCHCODE123', CURRENT_TIMESTAMP + INTERVAL '1 day', 'scanned', CURRENT_TIMESTAMP)`,
      [farmerId, testDealerId]
    );

    // Get weekly reconciliations
    const getReconRes = await server.inject({
      method: "GET",
      url: "/api/admin/agro-dealers/reconciliation",
      headers: authHeader
    });
    console.log("Get Reconciliations Status:", getReconRes.statusCode);
    const recons = JSON.parse(getReconRes.payload).reconciliations;
    const dealerRecon = recons.find((r: any) => r.agro_dealer_id === testDealerId);
    if (!dealerRecon || dealerRecon.total_tokens !== 100 || dealerRecon.total_kes_value !== 55.00) {
      throw new Error(`Weekly reconciliation calculation check failed: ${JSON.stringify(dealerRecon)}`);
    }
    // Net KES should be 55 * (1 - 0.045) = 52.525
    if (Math.abs(dealerRecon.total_kes_owed - 52.525) > 0.01) {
      throw new Error(`Expected Net KES Owed around 52.53, got ${dealerRecon.total_kes_owed}`);
    }

    // Settle the pending reconciliation
    const settleRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/agro-dealers/reconciliation/${testDealerId}/settle`,
      headers: authHeader,
      payload: { settlementReference: "BKREF-RECON-777" }
    });
    console.log("Settle Dealer Vouchers Status:", settleRes.statusCode);
    if (settleRes.statusCode !== 200) {
      throw new Error(`Agro-dealer settle endpoint failed: ${settleRes.payload}`);
    }

    // Verify voucher status is reconciled in database
    const dbVoucher = await pool.query("SELECT status, reconciled_at FROM voucher_redemptions WHERE voucher_code = 'TESTVCHCODE123'");
    if (dbVoucher.rows[0].status !== "reconciled" || !dbVoucher.rows[0].reconciled_at) {
      throw new Error("Voucher was not marked reconciled in database.");
    }

    // Verify reconciliation record is written
    const dbRecon = await pool.query("SELECT * FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1", [testDealerId]);
    if (dbRecon.rows.length === 0 || dbRecon.rows[0].status !== "settled" || dbRecon.rows[0].settlement_reference !== "BKREF-RECON-777") {
      throw new Error(`Database reconciliation record missing or incorrect: ${JSON.stringify(dbRecon.rows[0])}`);
    }
    console.log("✅ Test 7 passed (Agro-dealer creation, calculation, and manual settlement confirmed)!");

    console.log("\n--- TEST 8: Dira Circle and Coordinators Payouts ---");
    // Appoint test agent as coordinator for county Nairobi
    const appointCoordRes = await server.inject({
      method: "POST",
      url: "/api/admin/circle/coordinators",
      headers: authHeader,
      payload: { agentId: agentId, countyId: "Nairobi", mpesaNumber: "254700112233" }
    });
    console.log("Appoint Coordinator Status:", appointCoordRes.statusCode);
    if (appointCoordRes.statusCode !== 200) {
      throw new Error(`Failed to appoint coordinator: ${appointCoordRes.payload}`);
    }

    // Get coordinators list
    const getCoordsRes = await server.inject({
      method: "GET",
      url: "/api/admin/circle/coordinators",
      headers: authHeader
    });
    console.log("Get Coordinators Status:", getCoordsRes.statusCode);
    const coordinators = JSON.parse(getCoordsRes.payload).coordinators;
    const appointedCoord = coordinators.find((c: any) => c.agent_id === agentId);
    if (!appointedCoord || appointedCoord.mpesa_number !== "254700112233" || !appointedCoord.active) {
      throw new Error(`Coordinator list check failed. Found: ${JSON.stringify(appointedCoord)}`);
    }

    // Get available agents in county Nairobi
    const getAgentsRes = await server.inject({
      method: "GET",
      url: "/api/admin/circle/agents?county=Nairobi",
      headers: authHeader
    });
    console.log("Get Nairobi Available Agents Status:", getAgentsRes.statusCode);
    const availableAgents = JSON.parse(getAgentsRes.payload).agents;
    // Since agentId is Mombasa county, it should not list here
    if (availableAgents.some((a: any) => a.id === agentId)) {
      throw new Error("Agent appointed in Mombasa was listed in Nairobi available agents");
    }

    // Seed a pending Circle pool redemption request for Nairobi farmer
    // Nairobi is the county of the farmerId
    await pool.query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
       VALUES ($1, 200, 'circle', 100.00, pgp_sym_encrypt('254711223344', $2), 'pending')`,
      [farmerId, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    // Fetch monthly county pool calculation
    const getPoolsRes = await server.inject({
      method: "GET",
      url: "/api/admin/circle/calculator",
      headers: authHeader
    });
    console.log("Get Monthly Pools Calculator Status:", getPoolsRes.statusCode);
    const pools = JSON.parse(getPoolsRes.payload).pools;
    const nairobiPool = pools.find((p: any) => p.county_id === "Nairobi");
    if (!nairobiPool || nairobiPool.total_tokens !== 200 || nairobiPool.total_kes !== 100) {
      throw new Error(`Monthly pool calculation check failed: ${JSON.stringify(nairobiPool)}`);
    }

    // Trigger monthly pool aggregation (moves requests to 'processing')
    const triggerPoolRes = await server.inject({
      method: "POST",
      url: "/api/admin/circle/distributions",
      headers: authHeader,
      payload: { countyId: "Nairobi" }
    });
    console.log("Process Monthly County Pool Status:", triggerPoolRes.statusCode);
    if (triggerPoolRes.statusCode !== 200) {
      throw new Error(`Failed to process monthly county pool: ${triggerPoolRes.payload}`);
    }

    // Verify requests in redemption_requests are now in 'processing' status
    const dbCircleReq = await pool.query("SELECT status FROM redemption_requests WHERE user_id = $1 AND redemption_type = 'circle'", [farmerId]);
    if (dbCircleReq.rows[0].status !== "processing") {
      throw new Error(`Redemption request status should be processing, got ${dbCircleReq.rows[0].status}`);
    }

    // Generate CSV transfer instructions
    const getInstructionsRes = await server.inject({
      method: "GET",
      url: "/api/admin/circle/distributions/export-instructions",
      headers: authHeader
    });
    console.log("Get CSV Instructions Status:", getInstructionsRes.statusCode);
    const csvInstructions = getInstructionsRes.payload;
    if (getInstructionsRes.statusCode !== 200 || !csvInstructions.startsWith("Coordinator Name,County,M-Pesa Number,KES Amount")) {
      throw new Error(`CSV transfer instructions structure failed: ${csvInstructions}`);
    }
    if (!csvInstructions.includes("Nairobi") || !csvInstructions.includes("254700112233") || !csvInstructions.includes("100.00")) {
      throw new Error(`CSV transfer instructions missing coordinator or amount data: ${csvInstructions}`);
    }

    // Retrieve the pending distribution ID from DB
    const distDB = await pool.query("SELECT id FROM dira_circle_distributions WHERE county_id = 'Nairobi' AND status = 'pending'");
    if (distDB.rows.length === 0) {
      throw new Error("No pending dira_circle_distributions record found for Nairobi.");
    }
    const distId = distDB.rows[0].id;

    // Confirm/Settle pool distribution
    const confirmPoolRes = await server.inject({
      method: "PATCH",
      url: `/api/admin/circle/distributions/${distId}/confirm`,
      headers: authHeader,
      payload: { transferReference: "MPESA-CIRCLE-REF-888" }
    });
    console.log("Confirm Payout Status:", confirmPoolRes.statusCode);
    if (confirmPoolRes.statusCode !== 200) {
      throw new Error(`Failed to confirm payout: ${confirmPoolRes.payload}`);
    }

    // Verify user redemption request and county distribution status in DB are both completed
    const checkDistDB = await pool.query("SELECT status, transfer_reference FROM dira_circle_distributions WHERE id = $1", [distId]);
    if (checkDistDB.rows[0].status !== "completed" || checkDistDB.rows[0].transfer_reference !== "MPESA-CIRCLE-REF-888") {
      throw new Error(`County distribution status failed to complete: ${JSON.stringify(checkDistDB.rows[0])}`);
    }
    const checkUserReqDB = await pool.query("SELECT status, mpesa_receipt FROM redemption_requests WHERE user_id = $1 AND redemption_type = 'circle'", [farmerId]);
    if (checkUserReqDB.rows[0].status !== "completed" || checkUserReqDB.rows[0].mpesa_receipt !== "MPESA-CIRCLE-REF-888") {
      throw new Error(`User redemption request failed to complete: ${JSON.stringify(checkUserReqDB.rows[0])}`);
    }
    console.log("✅ Test 8 passed (Appointing, pool calculation, processing, CSV export, and confirmation verified)!");

    console.log("\n--- TEST 9: M-Pesa Activation Settings Checklist ---");
    // Fetch checklist
    const settingsGetRes = await server.inject({
      method: "GET",
      url: "/api/admin/mpesa-settings",
      headers: authHeader
    });
    console.log("Get Settings Status:", settingsGetRes.statusCode);
    const mpesaSettings = JSON.parse(settingsGetRes.payload);
    if (settingsGetRes.statusCode !== 200 || mpesaSettings.settings.daraja_credentials_approved !== false) {
      throw new Error(`Unexpected initial settings structure: ${settingsGetRes.payload}`);
    }

    // Toggle checklist database flag
    const settingsPatchRes = await server.inject({
      method: "PATCH",
      url: "/api/admin/mpesa-settings",
      headers: authHeader,
      payload: { key: "daraja_credentials_approved", value: true }
    });
    console.log("Patch Setting Status:", settingsPatchRes.statusCode);
    if (settingsPatchRes.statusCode !== 200) {
      throw new Error(`Failed to patch setting: ${settingsPatchRes.payload}`);
    }

    // Fetch again and verify value updated in database
    const settingsGetRes2 = await server.inject({
      method: "GET",
      url: "/api/admin/mpesa-settings",
      headers: authHeader
    });
    const mpesaSettings2 = JSON.parse(settingsGetRes2.payload);
    if (mpesaSettings2.settings.daraja_credentials_approved !== true) {
      throw new Error("Checked setting did not persistently save in database.");
    }
    console.log("✅ Test 9 passed (M-Pesa persistent checklist read and write verified)!");

    console.log("\n--- TEST 10: Failed M-Pesa B2C Payout Manual Retry ---");
    // Seed a failed M-Pesa redemption request
    const testMpesaRedId = "e8f9611b-715a-40a2-944a-f5e975f82631";
    await pool.query(
      `INSERT INTO redemption_requests (id, user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, failure_reason)
       VALUES ($1, $2, 100, 'mpesa', 50.00, pgp_sym_encrypt('254711223344', $3), 'failed', 'Network timeout during callback')`,
      [testMpesaRedId, farmerId, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    // User balance is currently 25 tokens (Test 1). Retry of 100 tokens should fail due to insufficient tokens!
    const retryFailRes = await server.inject({
      method: "POST",
      url: `/api/admin/redemptions/${testMpesaRedId}/retry`,
      headers: authHeader
    });
    console.log("Retry Insufficient Balance Status:", retryFailRes.statusCode);
    const retryFailBody = JSON.parse(retryFailRes.payload);
    if (retryFailRes.statusCode !== 400 || retryFailBody.error.code !== "INSUFFICIENT_TOKENS") {
      throw new Error(`Expected 400 and INSUFFICIENT_TOKENS, got status ${retryFailRes.statusCode} and body ${retryFailRes.payload}`);
    }

    // Award farmer 100 tokens directly in ledger to fulfill the retry token requirement
    await pool.query(
      `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, notes)
       VALUES ($1, 100, 125, 'adjustment', 'Seed tokens for manual retry')`,
      [farmerId]
    );

    // Run manual retry. It should succeed (in mock mode because there is no API key)
    const retrySuccessRes = await server.inject({
      method: "POST",
      url: `/api/admin/redemptions/${testMpesaRedId}/retry`,
      headers: authHeader
    });
    console.log("Retry Success Status:", retrySuccessRes.statusCode);
    const retrySuccessBody = JSON.parse(retrySuccessRes.payload);
    if (retrySuccessRes.statusCode !== 200 || !retrySuccessBody.success || !retrySuccessBody.conversationId) {
      throw new Error(`Retry request failed: ${retrySuccessRes.payload}`);
    }

    // Verify ledger balance was re-deducted (-100 tokens)
    const afterRetryLedger = await pool.query(
      "SELECT amount, transaction_type, reference_id FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [farmerId]
    );
    if (Number(afterRetryLedger.rows[0].amount) !== -100 || afterRetryLedger.rows[0].transaction_type !== "redeem_mpesa" || afterRetryLedger.rows[0].reference_id !== testMpesaRedId) {
      throw new Error(`Token ledger deduction rollback / check error: ${JSON.stringify(afterRetryLedger.rows[0])}`);
    }

    // Verify request is now in 'processing' status and has a conversationId
    const afterRetryReq = await pool.query(
      "SELECT status, at_transaction_id, failure_reason FROM redemption_requests WHERE id = $1",
      [testMpesaRedId]
    );
    if (afterRetryReq.rows[0].status !== "processing" || !afterRetryReq.rows[0].at_transaction_id || afterRetryReq.rows[0].failure_reason !== null) {
      throw new Error(`Redemption request status verify failed: ${JSON.stringify(afterRetryReq.rows[0])}`);
    }
    console.log("✅ Test 10 passed (Failed B2C retry balance gating, deduction, and dispatch verified)!");

    console.log("\n--- TEST 11: Token Economic Activity Report (Annex A) ---");
    // Fetch JSON report
    const getReportRes = await server.inject({
      method: "GET",
      url: "/api/admin/reports/token-economic-activity?format=json",
      headers: authHeader
    });
    console.log("Get Annex A JSON Report Status:", getReportRes.statusCode);
    const reportData = JSON.parse(getReportRes.payload);
    if (getReportRes.statusCode !== 200 || !reportData.success) {
      throw new Error(`Failed to load JSON activity report: ${getReportRes.payload}`);
    }
    console.log("Summary details:", reportData.summary);
    console.log("Earned breakdown:", reportData.earnedBreakdown);
    console.log("Redeemed breakdown:", reportData.redeemedBreakdown);
    console.log("County breakdown:", reportData.countyBreakdown);

    if (reportData.summary.totalEarned <= 0 || reportData.summary.uniqueEarners <= 0) {
      throw new Error("Annex A summary report has invalid aggregates.");
    }

    // Fetch CSV report
    const getReportCSVRes = await server.inject({
      method: "GET",
      url: "/api/admin/reports/token-economic-activity?format=csv",
      headers: authHeader
    });
    console.log("Get Annex A CSV Report Status:", getReportCSVRes.statusCode);
    const csvReport = getReportCSVRes.payload;
    if (getReportCSVRes.statusCode !== 200 || !csvReport.startsWith("SECTION: Token Economic Activity Summary")) {
      throw new Error(`Annex A CSV structure check failed: ${csvReport.substring(0, 100)}`);
    }
    if (!csvReport.includes("SECTION: Tokens Earned by Activity Type") || !csvReport.includes("SECTION: County Performance Breakdown")) {
      throw new Error("Annex A CSV missing multi-section headers.");
    }
    console.log("✅ Test 11 passed (Annex A Report JSON aggregates and CSV structure verified)!");

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
    await pool.query("DELETE FROM voucher_redemptions");
    await pool.query("DELETE FROM agro_dealer_reconciliations");
    await pool.query("DELETE FROM dealer_product_categories");
    await pool.query("DELETE FROM agro_dealers");
    await pool.query("DELETE FROM dira_circle_distributions");
    await pool.query("DELETE FROM circle_coordinators");
    await pool.query("DELETE FROM mpesa_activation_settings");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM users WHERE email IN ($1, $2, $3) OR telegram_id IN (11223344, 55667788)", [testAdminEmail, testFarmerEmail, testAgentEmail]);

    // Close connections
    await photoVerificationQueue.close();
    await atmosphericVerificationQueue.close();
    await notificationsQueue.close();
    await xionAnchorQueue.close();
    await redis.quit();
    await server.close();
  }
}

runTests();
