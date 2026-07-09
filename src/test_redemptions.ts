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
import jwt from "@fastify/jwt";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import airtimeRoutes from "./routes/payments/airtime";
import vouchersRoutes from "./routes/payments/vouchers";
import partnerRoutes from "./routes/partner";
import paymentsCircleRoutes from "./routes/payments/circle";
import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";

async function runTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);

  // Register routes
  await server.register(airtimeRoutes, { prefix: "/api/payments/airtime" });
  await server.register(vouchersRoutes, { prefix: "/api/payments/vouchers" });
  await server.register(partnerRoutes, { prefix: "/api/partner" });
  await server.register(paymentsCircleRoutes, { prefix: "/api/payments/circle" });

  await server.ready();

  const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

  try {
    console.log("Cleaning up previous test redemption data...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM voucher_redemptions");
    await pool.query("DELETE FROM dira_circle_distributions");
    await pool.query("DELETE FROM circle_coordinators");
    await pool.query("DELETE FROM agro_dealers");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM users WHERE telegram_id IN (11223344, 11223345, 11223346)");

    console.log("Seeding test users (Farmer, Partner/Dealer Employee, and Circle Coordinator/Agent)...");
    
    // Farmer user
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (11223344, 'test_farmer_user', pgp_sym_encrypt('+254711000000', $1), 'Farmer Joe', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    // Seed farmers table record
    await pool.query(
      `INSERT INTO farmers (user_id) VALUES ($1)`,
      [farmerId]
    );

    // Partner user (mapped by matching phone number for dealer lookup)
    const partnerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (11223345, 'test_partner_user', pgp_sym_encrypt('+254733333333', $1), 'Dealer Manager', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const partnerId = partnerRes.rows[0].id;

    // Coordinator/Agent user
    const coordinatorUserRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (11223346, 'test_coord_user', pgp_sym_encrypt('+254744444444', $1), 'Agent Coordinator', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const coordinatorUserId = coordinatorUserRes.rows[0].id;

    // Seed token balance for the farmer (500 DIRA)
    await tokenService.awardTokens(farmerId, 500, "Initial Seed Balance", "bonus");

    // Generate JWT tokens
    const farmerToken = server.jwt.sign({ id: farmerId, role: "farmer" });
    const partnerToken = server.jwt.sign({ id: partnerId, role: "agent" });

    // --- TEST 1: Day 1 Africa's Talking Airtime Flow ---
    console.log("\n--- TEST 1: Day 1 Africa's Talking Airtime Flow ---");
    
    // 1A. Success path
    const resAirtime1 = await server.inject({
      method: "POST",
      url: "/api/payments/airtime/redeem",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 40, phoneNumber: "+254711222222" }
    });
    console.log(`Success path status: ${resAirtime1.statusCode}`);
    const bodyAirtime1 = JSON.parse(resAirtime1.payload);
    console.log("Success path response:", bodyAirtime1);

    if (resAirtime1.statusCode !== 200 || !bodyAirtime1.success || bodyAirtime1.amountKes !== 22) {
      throw new Error("Airtime successful redemption failed.");
    }

    // Check balance reduced to 460
    const bal1 = await tokenService.getBalance(farmerId);
    console.log("Current balance after airtime:", bal1.balance);
    if (bal1.balance !== 460) {
      throw new Error(`Expected balance 460, got ${bal1.balance}`);
    }

    // 1B. Insufficient balance
    const resAirtime2 = await server.inject({
      method: "POST",
      url: "/api/payments/airtime/redeem",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 500, phoneNumber: "+254711222222" }
    });
    console.log(`Insufficient balance status: ${resAirtime2.statusCode}`);
    if (resAirtime2.statusCode !== 400) {
      throw new Error("Expected 400 for insufficient airtime balance.");
    }

    // 1C. Invalid phone format
    const resAirtime3 = await server.inject({
      method: "POST",
      url: "/api/payments/airtime/redeem",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 20, phoneNumber: "0711" }
    });
    console.log(`Invalid phone status: ${resAirtime3.statusCode}`);
    if (resAirtime3.statusCode !== 400) {
      throw new Error("Expected 400 for invalid phone format.");
    }
    console.log("✅ Test 1 passed!");


    // --- TEST 2: Month 1 Farm Input Vouchers Flow ---
    console.log("\n--- TEST 2: Month 1 Farm Input Vouchers Flow ---");
    
    // Resolve county name 'Nairobi' to county UUID
    const countyRes = await pool.query(
      "INSERT INTO counties (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      ["Nairobi"]
    );
    const countyUuid = countyRes.rows[0].id;

    // Seed agro dealer
    const dealerRes = await pool.query(
      `INSERT INTO agro_dealers (dealer_name, dealer_phone, county_id, bank_account, mou_signed_at)
       VALUES ('Nairobi Farm Supplies', '+254733333333', $1, '998877665544', CURRENT_TIMESTAMP)
       RETURNING id`,
      [countyUuid]
    );
    const dealerId = dealerRes.rows[0].id;

    // 2A. Generate input voucher
    const resVoucher1 = await server.inject({
      method: "POST",
      url: "/api/payments/vouchers/redeem",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 100, agroDealerId: dealerId }
    });
    console.log(`Voucher issue status: ${resVoucher1.statusCode}`);
    const bodyVoucher1 = JSON.parse(resVoucher1.payload);
    console.log("Voucher issue response:", bodyVoucher1);

    if (resVoucher1.statusCode !== 200 || !bodyVoucher1.success || !bodyVoucher1.code || !bodyVoucher1.qrHash) {
      throw new Error("Farm input voucher generation failed.");
    }

    // Check balance reduced to 360
    const bal2 = await tokenService.getBalance(farmerId);
    console.log("Current balance after voucher issue:", bal2.balance);
    if (bal2.balance !== 360) {
      throw new Error(`Expected balance 360, got ${bal2.balance}`);
    }

    const voucherCode = bodyVoucher1.code;
    const qrHash = bodyVoucher1.qrHash;

    // 2B. Partner validation (Scan)
    const resValidate = await server.inject({
      method: "POST",
      url: "/api/partner/vouchers/validate",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { voucherCode, qrHash }
    });
    console.log(`Partner validate status: ${resValidate.statusCode}`);
    const bodyValidate = JSON.parse(resValidate.payload);
    if (resValidate.statusCode !== 200 || !bodyValidate.valid) {
      throw new Error("Partner voucher validation scan failed.");
    }

    // 2C. Partner Claim/Redeem
    const resClaim = await server.inject({
      method: "POST",
      url: "/api/partner/vouchers/redeem",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { voucherCode, qrHash }
    });
    console.log(`Partner claim status: ${resClaim.statusCode}`);
    const bodyClaim = JSON.parse(resClaim.payload);
    if (resClaim.statusCode !== 200 || !bodyClaim.success) {
      throw new Error("Partner voucher claim failed.");
    }

    // Verify voucher status in DB
    const dbVchRes = await pool.query(
      "SELECT status, scanned_at FROM voucher_redemptions WHERE voucher_code = $1",
      [voucherCode]
    );
    console.log("Voucher status in database:", dbVchRes.rows[0]);
    if (dbVchRes.rows[0].status !== "scanned" || !dbVchRes.rows[0].scanned_at) {
      throw new Error("Voucher was not marked as scanned in database.");
    }
    console.log("✅ Test 2 passed!");


    // --- TEST 3: Month 2 Dira Circle Cash Pools ---
    console.log("\n--- TEST 3: Month 2 Dira Circle Cash Pools ---");
    
    // Ensure agent has a data_agents record
    const dataAgentRes = await pool.query(
      `INSERT INTO data_agents (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id`,
      [coordinatorUserId]
    );
    const dataAgentId = dataAgentRes.rows[0].id;

    // Seed active circle coordinator
    const coordRes = await pool.query(
      `INSERT INTO circle_coordinators (agent_id, county_id, mpesa_number, active_from)
       VALUES ($1, $2, '+254744444444', CURRENT_DATE)
       RETURNING id`,
      [dataAgentId, countyUuid]
    );

    // Contribute 60 tokens to Nairobi county Circle pool
    const resCircle = await server.inject({
      method: "POST",
      url: "/api/payments/circle/contribute",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 60, countyId: "Nairobi" }
    });
    console.log(`Circle pool contribution status: ${resCircle.statusCode}`);
    const bodyCircle = JSON.parse(resCircle.payload);
    console.log("Circle pool contribution response:", bodyCircle);

    if (resCircle.statusCode !== 200 || !bodyCircle.success || bodyCircle.kesValue !== 72.00) {
      throw new Error("Circle pool contribution failed.");
    }

    // Check balance reduced to 300
    const bal3 = await tokenService.getBalance(farmerId);
    console.log("Current balance after circle pool contribution:", bal3.balance);
    if (bal3.balance !== 300) {
      throw new Error(`Expected balance 300, got ${bal3.balance}`);
    }

    // Check distribution summary update
    const distRes = await pool.query(
      `SELECT d.* FROM dira_circle_distributions d
       JOIN counties ct ON d.county_id = ct.id
       WHERE ct.name = 'Nairobi'`
    );
    console.log("Circle distribution record:", distRes.rows[0]);
    if (
      distRes.rows.length === 0 || 
      Number(distRes.rows[0].total_tokens_redeemed) !== 60 || 
      Number(distRes.rows[0].total_kes_disbursed) !== 72.00
    ) {
      throw new Error("Circle distribution record aggregates were not updated correctly.");
    }
    console.log("✅ Test 3 passed!");


    // --- TEST 4: Month 3-4 Safaricom M-Pesa Flow (Gated) ---
    console.log("\n--- TEST 4: Month 3-4 Safaricom M-Pesa Flow (Gated) ---");
    
    // 4A. Test gate returning 503 Service Unavailable when flag is false
    env.DARAJA_PRODUCTION_ACTIVE = false;

    const resMpesaGated = await server.inject({
      method: "POST",
      url: "/api/payments/mpesa/cashout",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 100, phoneNumber: "+254711000000" }
    });
    console.log(`Gated M-Pesa status: ${resMpesaGated.statusCode}`);
    const bodyMpesaGated = JSON.parse(resMpesaGated.payload);
    console.log("Gated response body:", bodyMpesaGated);
    if (resMpesaGated.statusCode !== 503 || bodyMpesaGated.success !== false) {
      throw new Error("Expected 503 Service Unavailable for gated B2C route.");
    }

    // 4B. Toggle flag to true to test trigger flow
    env.DARAJA_PRODUCTION_ACTIVE = true;

    const resMpesaSuccess = await server.inject({
      method: "POST",
      url: "/api/payments/mpesa/cashout",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { tokenAmount: 100, phoneNumber: "+254711000000" }
    });
    console.log(`Active M-Pesa status: ${resMpesaSuccess.statusCode}`);
    const bodyMpesaSuccess = JSON.parse(resMpesaSuccess.payload);
    console.log("Active response body:", bodyMpesaSuccess);

    if (resMpesaSuccess.statusCode !== 200 || !bodyMpesaSuccess.success) {
      throw new Error("M-Pesa active trigger failed.");
    }

    // Check balance reduced to 200
    const bal4 = await tokenService.getBalance(farmerId);
    console.log("Current balance after active M-Pesa cashout:", bal4.balance);
    if (bal4.balance !== 200) {
      throw new Error(`Expected balance 200, got ${bal4.balance}`);
    }
    console.log("✅ Test 4 passed!");

    console.log("\n⭐️ ALL 4-LAYER TOKEN REDEMPTION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Token redemption test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
