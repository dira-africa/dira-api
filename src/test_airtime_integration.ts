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
import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";

async function runTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(tokensRoutes, { prefix: "/api/tokens" });

  await server.ready();

  const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

  try {
    console.log("Cleaning up previous test redemption data...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM users WHERE telegram_id = 998877");

    console.log("Seeding test farmer user...");
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (998877, 'test_farmer_airtime', pgp_sym_encrypt('+254711222222', $1), 'Airtime Farmer', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    // Seed token balance for the farmer (100 DIRA)
    await tokenService.creditTokens(farmerId, 100, "bonus", undefined, "Initial seed");

    const token = server.jwt.sign({ id: farmerId, role: "farmer" });

    // --- Test 1: Redeem 20 tokens → AT sandbox confirms 'Sent', token balance decreases by 20 ---
    console.log("\n--- Test 1: Redeem 20 tokens (Safaricom) ---");
    const res1 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 20, phone_number: "+254711222222" }
    });
    console.log(`Test 1 Status Code: ${res1.statusCode}`);
    const body1 = JSON.parse(res1.payload);
    console.log("Test 1 Response:", body1);

    if (res1.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res1.statusCode}`);
    }
    if (!body1.success || body1.kes_disbursed !== 11.00 || !body1.transactionId) {
      throw new Error(`Invalid success response structure: ${JSON.stringify(body1)}`);
    }

    // Verify token balance decreased by 20 (100 - 20 = 80)
    const bal1 = await tokenService.getBalance(farmerId);
    console.log("Current balance after Test 1:", bal1.balance);
    if (bal1.balance !== 80) {
      throw new Error(`Expected balance 80, got ${bal1.balance}`);
    }

    // Verify redemption record exists and is completed
    const dbRecordRes1 = await pool.query(
      "SELECT status, at_transaction_id, pgp_sym_decrypt(phone_number::bytea, $1) as phone FROM redemption_requests WHERE user_id = $2",
      [encryptionKey, farmerId]
    );
    console.log("Database record for Test 1:", dbRecordRes1.rows[0]);
    if (dbRecordRes1.rows[0].status !== "completed" || dbRecordRes1.rows[0].phone !== "+254711222222") {
      throw new Error(`Database check failed: ${JSON.stringify(dbRecordRes1.rows[0])}`);
    }


    // --- Test 2: Redeem 19 tokens (below minimum) → 400 error 'BELOW_MINIMUM_TOKENS' ---
    console.log("\n--- Test 2: Redeem 19 tokens ---");
    const res2 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 19, phone_number: "+254711222222" }
    });
    console.log(`Test 2 Status Code: ${res2.statusCode}`);
    const body2 = JSON.parse(res2.payload);
    console.log("Test 2 Response:", body2);

    if (res2.statusCode !== 400 || body2.error?.code !== "BELOW_MINIMUM_TOKENS") {
      throw new Error(`Expected 400 BELOW_MINIMUM_TOKENS, got status ${res2.statusCode} and body: ${JSON.stringify(body2)}`);
    }


    // --- Test 3: Use invalid phone format → 400 error 'INVALID_PHONE_NUMBER' ---
    console.log("\n--- Test 3: Invalid phone format ---");
    const res3 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 20, phone_number: "0711" }
    });
    console.log(`Test 3 Status Code: ${res3.statusCode}`);
    const body3 = JSON.parse(res3.payload);
    console.log("Test 3 Response:", body3);

    if (res3.statusCode !== 400 || body3.error?.code !== "INVALID_PHONE_NUMBER") {
      throw new Error(`Expected 400 INVALID_PHONE_NUMBER, got status ${res3.statusCode} and body: ${JSON.stringify(body3)}`);
    }


    // --- Test 4: Mock AT failure → tokens refunded, redemption_requests table shows status 'failed' ---
    console.log("\n--- Test 4: Mock AT failure ---");
    // Trigger mock failure using a phone number containing 999999
    const balBefore4 = await tokenService.getBalance(farmerId);
    console.log(`Balance before Test 4: ${balBefore4.balance}`);

    const res4 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 30, phone_number: "+254711999999" }
    });
    console.log(`Test 4 Status Code: ${res4.statusCode}`);
    const body4 = JSON.parse(res4.payload);
    console.log("Test 4 Response:", body4);

    if (res4.statusCode !== 502 || body4.error?.code !== "AIRTIME_SEND_FAILED") {
      throw new Error(`Expected 502 AIRTIME_SEND_FAILED, got status ${res4.statusCode} and body: ${JSON.stringify(body4)}`);
    }

    // Verify token balance is still 80 (was 80, deducted 30 to 50, then refunded 30 back to 80)
    const balAfter4 = await tokenService.getBalance(farmerId);
    console.log("Current balance after Test 4 refund:", balAfter4.balance);
    if (balAfter4.balance !== balBefore4.balance) {
      throw new Error(`Expected balance to be refunded back to ${balBefore4.balance}, but got ${balAfter4.balance}`);
    }

    // Verify redemption record exists and is failed
    const dbRecordRes4 = await pool.query(
      "SELECT status, failure_reason FROM redemption_requests WHERE status = 'failed' AND user_id = $1 ORDER BY initiated_at DESC LIMIT 1",
      [farmerId]
    );
    console.log("Database record for Test 4:", dbRecordRes4.rows[0]);
    if (dbRecordRes4.rows.length === 0 || dbRecordRes4.rows[0].status !== "failed") {
      throw new Error(`Expected failed record in database, got: ${JSON.stringify(dbRecordRes4.rows)}`);
    }


    // --- Test 5: All three Kenyan networks (Safaricom, Airtel, Telkom) tested in AT sandbox ---
    console.log("\n--- Test 5: Three Kenyan Networks ---");
    const networks = [
      { name: "Safaricom", phone: "+254712345678" },
      { name: "Airtel", phone: "+254734567890" },
      { name: "Telkom", phone: "+254776543210" }
    ];

    for (const net of networks) {
      console.log(`Testing ${net.name} network with phone number ${net.phone}...`);
      const resNet = await server.inject({
        method: "POST",
        url: "/api/tokens/redeem/airtime",
        headers: { Authorization: `Bearer ${token}` },
        payload: { token_amount: 20, phone_number: net.phone }
      });
      console.log(`${net.name} response status: ${resNet.statusCode}`);
      const bodyNet = JSON.parse(resNet.payload);
      if (resNet.statusCode !== 200 || !bodyNet.success) {
        throw new Error(`Failed network test for ${net.name} phone ${net.phone}`);
      }
    }

    console.log("\n⭐️ ALL AIRTIME INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Airtime integration tests failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
