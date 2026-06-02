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
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import tokensRoutes from "./routes/tokens";
import adminRoutes from "./routes/admin";
import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";
import { diraCircleService } from "./services/diraCircleService";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  midnightAnchorQueue
} from "./jobs/queues";

async function runCircleIntegrationTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);

  // Register routes
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(adminRoutes, { prefix: "/api/admin" });

  await server.ready();

  const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

  try {
    console.log("Cleaning up database tables for Dira Circle integration tests...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM dira_circle_distributions");
    await pool.query("DELETE FROM circle_coordinators");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM users WHERE telegram_id IN (990001, 990002, 990003, 990004)");

    console.log("Seeding test users (Admin, Coordinator, Farmer 1, Farmer 2)...");
    
    // 1. Admin user
    const adminRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (990001, 'admin_circle_user', pgp_sym_encrypt('+254700000001', $1), 'Admin Circle Joe', 'admin', 'en', 'Mombasa')
       RETURNING id`,
      [encryptionKey]
    );
    const adminId = adminRes.rows[0].id;

    // 2. Coordinator user
    const coordUserRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (990002, 'coord_circle_user', pgp_sym_encrypt('+254700000002', $1), 'Coord Circle Jane', 'agent', 'en', 'Mombasa')
       RETURNING id`,
      [encryptionKey]
    );
    const coordUserId = coordUserRes.rows[0].id;

    // 3. Farmer 1 user
    const farmer1Res = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (990003, 'farmer1_circle_user', pgp_sym_encrypt('+254700000003', $1), 'Farmer 1 Circle User', 'farmer', 'en', 'Mombasa')
       RETURNING id`,
      [encryptionKey]
    );
    const farmer1Id = farmer1Res.rows[0].id;

    // 4. Farmer 2 user
    const farmer2Res = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (990004, 'farmer2_circle_user', pgp_sym_encrypt('+254700000004', $1), 'Farmer 2 Circle User', 'farmer', 'en', 'Mombasa')
       RETURNING id`,
      [encryptionKey]
    );
    const farmer2Id = farmer2Res.rows[0].id;

    // Seed token balances for Farmers
    await tokenService.awardTokens(farmer1Id, 300, "Bonus Farmer 1", "bonus");
    await tokenService.awardTokens(farmer2Id, 400, "Bonus Farmer 2", "bonus");

    // Generate JWT tokens
    const adminToken = server.jwt.sign({ id: adminId, role: "admin" });
    const farmer1Token = server.jwt.sign({ id: farmer1Id, role: "farmer" });
    const farmer2Token = server.jwt.sign({ id: farmer2Id, role: "farmer" });

    // --- TEST 1: Gated DIRA_CIRCLE_ACTIVE route ---
    console.log("\n--- TEST 1: Gated DIRA_CIRCLE_ACTIVE route ---");
    env.DIRA_CIRCLE_ACTIVE = false;
    const resGated = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer1Token}` },
      payload: { tokenAmount: 150 }
    });
    console.log(`Gated status: ${resGated.statusCode}`);
    if (resGated.statusCode !== 503) {
      throw new Error("Expected 503 Service Unavailable when DIRA_CIRCLE_ACTIVE=false");
    }
    const bodyGated = JSON.parse(resGated.payload);
    if (bodyGated.error?.code !== "SERVICE_UNAVAILABLE") {
      throw new Error("Expected error code SERVICE_UNAVAILABLE");
    }
    env.DIRA_CIRCLE_ACTIVE = true;
    console.log("Gated test passed!");

    // --- TEST 2: Redeem circle when NO coordinator active ---
    console.log("\n--- TEST 2: Redeem circle when NO coordinator active ---");
    const resNoCoord = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer1Token}` },
      payload: { tokenAmount: 150 }
    });
    console.log(`No-coordinator status: ${resNoCoord.statusCode}`);
    if (resNoCoord.statusCode !== 400) {
      throw new Error(`Expected 400 when no coordinator appointed, got ${resNoCoord.statusCode}`);
    }
    const bodyNoCoord = JSON.parse(resNoCoord.payload);
    if (bodyNoCoord.error?.code !== "NO_ACTIVE_COORDINATOR") {
      throw new Error("Expected error code NO_ACTIVE_COORDINATOR");
    }
    console.log("No coordinator test passed!");

    // --- TEST 3: Appoint county coordinator ---
    console.log("\n--- TEST 3: Appoint county coordinator ---");
    const resAppoint = await server.inject({
      method: "POST",
      url: "/api/admin/circle/coordinators",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        agentId: coordUserId,
        countyId: "Mombasa",
        mpesaNumber: "+254700000002"
      }
    });
    console.log(`Appoint status: ${resAppoint.statusCode}`);
    if (resAppoint.statusCode !== 200) {
      console.error("Appoint failed payload:", resAppoint.payload);
      throw new Error(`Expected 200 on coordinator appointment, got ${resAppoint.statusCode}`);
    }
    const bodyAppoint = JSON.parse(resAppoint.payload);
    if (!bodyAppoint.success) {
      throw new Error("Appoint coordinator response success should be true");
    }

    // Verify DB entry
    const coordDb = await pool.query(
      `SELECT cc.id, pgp_sym_decrypt(cc.mpesa_number::bytea, $1) AS phone
       FROM circle_coordinators cc WHERE cc.county_id = 'Mombasa'`,
      [encryptionKey]
    );
    if (coordDb.rows.length === 0 || coordDb.rows[0].phone !== "+254700000002") {
      throw new Error("Coordinator was not correctly created or mpesa_number decrypted");
    }
    console.log("Appoint coordinator test passed!");

    // --- TEST 4: Successful User redemptions & Ledger verification ---
    console.log("\n--- TEST 4: Successful User redemptions & Ledger verification ---");
    
    // Farmer 1 redeems 150 tokens
    const resRedeem1 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer1Token}` },
      payload: { tokenAmount: 150 }
    });
    console.log(`Redeem 1 status: ${resRedeem1.statusCode}`);
    if (resRedeem1.statusCode !== 200) {
      throw new Error(`Expected 200 for user 1 redemption, got ${resRedeem1.statusCode}`);
    }
    
    // Check balance for Farmer 1: 300 - 150 = 150
    const balFarmer1 = await tokenService.getBalance(farmer1Id);
    console.log(`Farmer 1 balance after: ${balFarmer1.balance}`);
    if (balFarmer1.balance !== 150) {
      throw new Error(`Expected Farmer 1 balance 150, got ${balFarmer1.balance}`);
    }

    // Farmer 2 redeems 200 tokens
    const resRedeem2 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer2Token}` },
      payload: { tokenAmount: 200 }
    });
    console.log(`Redeem 2 status: ${resRedeem2.statusCode}`);
    if (resRedeem2.statusCode !== 200) {
      throw new Error(`Expected 200 for user 2 redemption, got ${resRedeem2.statusCode}`);
    }
    
    // Check balance for Farmer 2: 400 - 200 = 200
    const balFarmer2 = await tokenService.getBalance(farmer2Id);
    console.log(`Farmer 2 balance after: ${balFarmer2.balance}`);
    if (balFarmer2.balance !== 200) {
      throw new Error(`Expected Farmer 2 balance 200, got ${balFarmer2.balance}`);
    }

    // Verify redemption requests in DB
    const requestsDb = await pool.query(
      `SELECT status, tokens_spent, amount_kes::float AS amount_kes FROM redemption_requests
       WHERE redemption_type = 'circle' ORDER BY initiated_at ASC`
    );
    if (requestsDb.rows.length !== 2) {
      throw new Error(`Expected 2 redemption requests, got ${requestsDb.rows.length}`);
    }
    if (requestsDb.rows[0].status !== "pending" || requestsDb.rows[1].status !== "pending") {
      throw new Error("Both redemption requests should be 'pending'");
    }
    if (requestsDb.rows[0].tokens_spent !== 150 || requestsDb.rows[1].tokens_spent !== 200) {
      throw new Error("Tokens spent do not match");
    }
    if (requestsDb.rows[0].amount_kes !== 75.0 || requestsDb.rows[1].amount_kes !== 100.0) {
      throw new Error("Amount KES does not match expected KES conversion (1 token = 0.50 KES)");
    }
    console.log("Successful user redemptions test passed!");

    // --- TEST 5: Redemption errors: below minimum and insufficient balance ---
    console.log("\n--- TEST 5: Redemption errors: below minimum and insufficient balance ---");
    
    // Below minimum (min is 100)
    const resBelowMin = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer1Token}` },
      payload: { tokenAmount: 90 }
    });
    console.log(`Below minimum status: ${resBelowMin.statusCode}`);
    if (resBelowMin.statusCode !== 400) {
      throw new Error("Expected 400 on below minimum");
    }
    const bodyBelowMin = JSON.parse(resBelowMin.payload);
    if (bodyBelowMin.error?.code !== "BELOW_MINIMUM_TOKENS") {
      throw new Error("Expected error code BELOW_MINIMUM_TOKENS");
    }

    // Insufficient balance (Farmer 1 has 150 tokens left, requests 160)
    const resInsufficient = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/circle",
      headers: { Authorization: `Bearer ${farmer1Token}` },
      payload: { tokenAmount: 160 }
    });
    console.log(`Insufficient status: ${resInsufficient.statusCode}`);
    if (resInsufficient.statusCode !== 400) {
      throw new Error("Expected 400 on insufficient tokens");
    }
    const bodyInsufficient = JSON.parse(resInsufficient.payload);
    if (bodyInsufficient.error?.code !== "INSUFFICIENT_TOKENS") {
      throw new Error("Expected error code INSUFFICIENT_TOKENS");
    }
    console.log("Redemption error cases test passed!");

    // --- TEST 6: Monthly Pool processing ---
    console.log("\n--- TEST 6: Monthly Pool processing ---");
    await notificationsQueue.drain(true);

    const periodMonth = new Date();
    periodMonth.setUTCDate(1);
    periodMonth.setUTCHours(0, 0, 0, 0);

    const poolResult = await diraCircleService.processMonthlyCountyPool("Mombasa", periodMonth);
    console.log("Pool result:", poolResult);
    if (poolResult.totalUsers !== 2 || poolResult.totalKes !== 175) {
      throw new Error(`Expected 2 users and 175 KES pool, got ${poolResult.totalUsers} users, ${poolResult.totalKes} KES`);
    }

    // Check requests status: should be 'processing'
    const requestsAfterRes = await pool.query(
      `SELECT status FROM redemption_requests WHERE redemption_type = 'circle'`
    );
    for (const row of requestsAfterRes.rows) {
      if (row.status !== "processing") {
        throw new Error(`Expected status to be 'processing', got ${row.status}`);
      }
    }

    // Check distribution record is created with status 'pending'
    const distDb = await pool.query(
      `SELECT * FROM dira_circle_distributions WHERE county_id = 'Mombasa'`
    );
    if (distDb.rows.length !== 1) {
      throw new Error("Expected exactly one distribution record for Mombasa");
    }
    const distRecord = distDb.rows[0];
    console.log("Distribution database record:", distRecord);
    if (distRecord.status !== "pending") {
      throw new Error(`Expected distribution status to be 'pending', got ${distRecord.status}`);
    }
    if (Number(distRecord.total_users) !== 2 || Number(distRecord.total_tokens) !== 350 || Number(distRecord.total_kes_disbursed) !== 175.00) {
      throw new Error("Aggregated values on distribution record are incorrect");
    }

    // Check Telegram notifications queued
    const queuedJobs = await notificationsQueue.getJobs(["waiting", "delayed"]);
    console.log(`Number of notifications queued: ${queuedJobs.length}`);
    if (queuedJobs.length < 1) {
      throw new Error("Expected at least one Telegram notification to be queued for admin/coordinator");
    }
    console.log("Monthly Pool processing test passed!");

    // --- TEST 7: Confirm distribution ---
    console.log("\n--- TEST 7: Confirm distribution ---");
    const distId = distRecord.id;
    const transferRef = "MPESA_REF_CIRCLE_999";

    const resConfirm = await server.inject({
      method: "PATCH",
      url: `/api/admin/circle/distributions/${distId}/confirm`,
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: { transferReference: transferRef }
    });
    console.log(`Confirm status: ${resConfirm.statusCode}`);
    if (resConfirm.statusCode !== 200) {
      throw new Error(`Expected 200 on confirm distribution, got ${resConfirm.statusCode}`);
    }
    const bodyConfirm = JSON.parse(resConfirm.payload);
    if (!bodyConfirm.success) {
      throw new Error("Confirm distribution response success should be true");
    }

    // Assert distribution is 'completed'
    const distDbAfter = await pool.query(
      `SELECT status, transfer_reference, transferred_at, distribution_confirmed_at 
       FROM dira_circle_distributions WHERE id = $1`,
      [distId]
    );
    const distRow = distDbAfter.rows[0];
    console.log("Distribution after confirm:", distRow);
    if (distRow.status !== "completed") {
      throw new Error(`Expected distribution status 'completed', got ${distRow.status}`);
    }
    if (distRow.transfer_reference !== transferRef || !distRow.transferred_at || !distRow.distribution_confirmed_at) {
      throw new Error("Distribution transfer reference or timestamps were not updated correctly");
    }

    // Assert all requests are 'completed' and have transfer reference as mpesa_receipt
    const requestsAfterConfirm = await pool.query(
      `SELECT status, mpesa_receipt, completed_at FROM redemption_requests WHERE redemption_type = 'circle'`
    );
    if (requestsAfterConfirm.rows.length !== 2) {
      throw new Error("Expected exactly 2 requests");
    }
    for (const row of requestsAfterConfirm.rows) {
      if (row.status !== "completed") {
        throw new Error(`Expected request status 'completed', got ${row.status}`);
      }
      if (row.mpesa_receipt !== transferRef) {
        throw new Error(`Expected mpesa_receipt to match transferReference, got ${row.mpesa_receipt}`);
      }
      if (!row.completed_at) {
        throw new Error("completed_at timestamp was not set on requests");
      }
    }
    console.log("Confirm distribution test passed!");

    // --- TEST 8: GET /api/tokens/redeem/circle/status ---
    console.log("\n--- TEST 8: GET /api/tokens/redeem/circle/status ---");
    const resStatus = await server.inject({
      method: "GET",
      url: "/api/tokens/redeem/circle/status",
      headers: { Authorization: `Bearer ${farmer1Token}` }
    });
    console.log(`Circle status endpoint status: ${resStatus.statusCode}`);
    if (resStatus.statusCode !== 200) {
      throw new Error(`Expected 200 on status route, got ${resStatus.statusCode}`);
    }
    const bodyStatus = JSON.parse(resStatus.payload);
    console.log("Circle status response:", bodyStatus);
    if (bodyStatus.county !== "Mombasa") {
      throw new Error(`Expected county Mombasa, got ${bodyStatus.county}`);
    }
    if (bodyStatus.coordinator?.name !== "Coord Circle Jane" || bodyStatus.coordinator?.mpesaNumber !== "+254700000002") {
      throw new Error("Coordinator details are incorrect or missing");
    }
    if (!bodyStatus.lastRequest) {
      throw new Error("Expected lastRequest object to be present");
    }
    if (bodyStatus.lastRequest.status !== "completed" || bodyStatus.lastRequest.tokensSpent !== 150 || bodyStatus.lastRequest.mpesaReceipt !== transferRef) {
      throw new Error("lastRequest details are incorrect");
    }
    console.log("GET status test passed!");

    // --- TEST 9: GET /api/admin/circle/distributions ---
    console.log("\n--- TEST 9: GET /api/admin/circle/distributions ---");
    const resDistList = await server.inject({
      method: "GET",
      url: "/api/admin/circle/distributions",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`Admin distributions list status: ${resDistList.statusCode}`);
    if (resDistList.statusCode !== 200) {
      throw new Error(`Expected 200 on distributions list, got ${resDistList.statusCode}`);
    }
    const bodyDistList = JSON.parse(resDistList.payload);
    if (!bodyDistList.success || !Array.isArray(bodyDistList.distributions) || bodyDistList.distributions.length === 0) {
      throw new Error("Expected successful distributions list containing at least one item");
    }
    console.log("Admin distributions list test passed!");

    console.log("\n⭐️ ALL MONTH 2 DIRA CIRCLE COMMUNITY CASH POOL INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Dira Circle integration test suite failed:", err);
    process.exit(1);
  } finally {
    console.log("Cleaning up connections...");
    await server.close();
    try {
      await photoVerificationQueue.close();
      await atmosphericVerificationQueue.close();
      await notificationsQueue.close();
      await midnightAnchorQueue.close();
    } catch (e) {
      console.error("Failed to close BullMQ queues:", e);
    }
    console.log("All connections closed. Exiting test.");
  }
}

runCircleIntegrationTests();
