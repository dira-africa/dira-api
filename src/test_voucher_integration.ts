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
import crypto from "crypto";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import tokensRoutes from "./routes/tokens";
import partnerRoutes from "./routes/partner";
import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";
import { voucherService } from "./services/voucherService";

async function runVoucherTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);

  // Register routes
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(partnerRoutes, { prefix: "/api/partner" });

  await server.ready();

  const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

  try {
    console.log("Cleaning up database tables for integration tests...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM voucher_redemptions");
    await pool.query("DELETE FROM agro_dealer_reconciliations");
    await pool.query("DELETE FROM agro_dealers");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM users WHERE telegram_id IN (998877, 998878)");

    console.log("Seeding test users...");
    // Farmer user
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (998877, 'farmer_integration_user', pgp_sym_encrypt('+254701234567', $1), 'Farmer Integration Joe', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    // Seed farmers table record
    const fRes = await pool.query(
      `INSERT INTO farmers (user_id) VALUES ($1) RETURNING id`,
      [farmerId]
    );
    const farmerUuid = fRes.rows[0].id;

    // Seed token balance for the farmer (600 DIRA)
    await tokenService.awardTokens(farmerId, 600, "Initial Seeding", "bonus");

    // Partner/Dealer Agent user
    const partnerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (998878, 'dealer_integration_user', pgp_sym_encrypt('+254799999999', $1), 'Dealer Integration Agent', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const partnerId = partnerRes.rows[0].id;

    // Resolve county name 'Nairobi' to county UUID
    const countyRes = await pool.query(
      "INSERT INTO counties (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      ["Nairobi"]
    );
    const countyUuid = countyRes.rows[0].id;

    // Seed Agro Dealer
    const dealerRes = await pool.query(
      `INSERT INTO agro_dealers (dealer_name, dealer_phone, county_id, bank_account, mou_signed_at, active)
       VALUES ('Integration Agro Supplies', '+254799999999', $1, '1122334455', CURRENT_TIMESTAMP, TRUE)
       RETURNING id`,
      [countyUuid]
    );
    const dealerId = dealerRes.rows[0].id;

    // Generate JWT tokens
    const farmerToken = server.jwt.sign({ id: farmerId, role: "farmer" });
    const partnerToken = server.jwt.sign({ id: partnerId, role: "agent" });

    // --- TEST 1: Generate signed QR voucher ---
    console.log("\n--- TEST 1: Generate signed QR voucher ---");
    const resGenerate = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/voucher",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { token_amount: 100, agro_dealer_id: dealerId }
    });

    console.log(`Voucher generate status: ${resGenerate.statusCode}`);
    const bodyGenerate = JSON.parse(resGenerate.payload);
    console.log("Voucher generate response keys:", Object.keys(bodyGenerate));

    if (resGenerate.statusCode !== 200 || !bodyGenerate.success || !bodyGenerate.voucherCode || !bodyGenerate.qrDataUrl) {
      throw new Error("Voucher generation route failed.");
    }

    if (Math.abs(bodyGenerate.kesValue - 55) > 0.01) {
      throw new Error(`Expected kesValue 55, got ${bodyGenerate.kesValue}`);
    }

    // Verify balance is 500
    const bal1 = await tokenService.getBalance(farmerId);
    console.log("Balance after generation:", bal1.balance);
    if (bal1.balance !== 500) {
      throw new Error(`Expected balance 500, got ${bal1.balance}`);
    }

    const voucherCode = bodyGenerate.voucherCode;
    const expiresAt = bodyGenerate.expiresAt;

    // --- TEST 2: Validate voucher (Legacy check) ---
    console.log("\n--- TEST 2: Validate voucher (Legacy check) ---");
    // Retrieve stored hash from DB
    const dbVchRes = await pool.query(
      "SELECT voucher_qr_hash FROM voucher_redemptions WHERE voucher_code = $1",
      [voucherCode]
    );
    const storedHash = dbVchRes.rows[0].voucher_qr_hash;

    const resValidate = await server.inject({
      method: "POST",
      url: "/api/partner/vouchers/validate",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { voucherCode, qrHash: storedHash }
    });

    console.log(`Partner validate status: ${resValidate.statusCode}`);
    const bodyValidate = JSON.parse(resValidate.payload);
    if (resValidate.statusCode !== 200 || !bodyValidate.valid) {
      throw new Error("Partner voucher validation route failed.");
    }
    console.log("Validation passed successfully!");

    // --- TEST 3: Scan voucher (Timing-safe JSON verification) ---
    console.log("\n--- TEST 3: Scan voucher (Timing-safe JSON verification) ---");
    // Construct signed QR payload
    const payloadObj = {
      voucherCode,
      farmerId,
      agroDealerId: dealerId,
      tokenAmount: 100,
      kesValue: 55,
      expiresAt,
      keyVersion: 1
    };
    const payloadStr = JSON.stringify(payloadObj);
    const payloadBase64 = Buffer.from(payloadStr).toString("base64");
    const signature = crypto.createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(payloadBase64)
      .digest("hex");
    const testQrPayload = JSON.stringify({ payload: payloadBase64, signature });

    const resScan = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: testQrPayload, agroDealerId: dealerId }
    });

    console.log(`Scan voucher status: ${resScan.statusCode}`);
    const bodyScan = JSON.parse(resScan.payload);
    if (resScan.statusCode !== 200 || !bodyScan.success) {
      throw new Error("Partner voucher scan route failed.");
    }
    console.log("Voucher scanned and redeemed successfully!");

    // Verify voucher status in DB is 'redeemed'
    const finalVchRes = await pool.query(
      "SELECT status, scanned_at FROM voucher_redemptions WHERE voucher_code = $1",
      [voucherCode]
    );
    console.log("Voucher status in DB after scan:", finalVchRes.rows[0]);
    if (finalVchRes.rows[0].status !== "redeemed" || !finalVchRes.rows[0].scanned_at) {
      throw new Error("Voucher is not marked as redeemed/scanned in DB.");
    }

    // --- TEST 4: Double-spend / rescan error ---
    console.log("\n--- TEST 4: Double-spend / rescan error ---");
    const resScanAgain = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: testQrPayload, agroDealerId: dealerId }
    });
    console.log(`Rescan status code: ${resScanAgain.statusCode}`);
    const bodyScanAgain = JSON.parse(resScanAgain.payload);
    console.log("Rescan response:", bodyScanAgain);
    if (resScanAgain.statusCode !== 400 || bodyScanAgain.error?.code !== "VOUCHER_ALREADY_REDEEMED") {
      throw new Error("Expected VOUCHER_ALREADY_REDEEMED error on rescan.");
    }
    console.log("Double-spend validation passed!");

    // --- TEST 5: Expired scan error ---
    console.log("\n--- TEST 5: Expired scan error ---");
    const expiredVchCode = crypto.randomUUID();
    const expiredTime = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    
    // Insert pre-expired voucher record in db
    await pool.query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
       VALUES ($1, $2, 100, 55, $3, 'expired-hash', $4, 'generated')`,
      [farmerUuid, dealerId, expiredVchCode, expiredTime]
    );

    const expiredPayloadObj = {
      voucherCode: expiredVchCode,
      farmerId,
      agroDealerId: dealerId,
      tokenAmount: 100,
      kesValue: 55,
      expiresAt: expiredTime.toISOString(),
      keyVersion: 1
    };
    const expiredPayloadStr = JSON.stringify(expiredPayloadObj);
    const expiredPayloadBase64 = Buffer.from(expiredPayloadStr).toString("base64");
    const expiredSignature = crypto.createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(expiredPayloadBase64)
      .digest("hex");
    const expiredQrPayload = JSON.stringify({ payload: expiredPayloadBase64, signature: expiredSignature });

    const resScanExpired = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: expiredQrPayload, agroDealerId: dealerId }
    });
    console.log(`Expired scan status code: ${resScanExpired.statusCode}`);
    const bodyScanExpired = JSON.parse(resScanExpired.payload);
    console.log("Expired scan response:", bodyScanExpired);
    if (resScanExpired.statusCode !== 400 || bodyScanExpired.error?.code !== "VOUCHER_EXPIRED") {
      throw new Error("Expected VOUCHER_EXPIRED error on scanning expired voucher.");
    }
    console.log("Expiration check passed!");

    // --- TEST 6: Tampered payload scan error ---
    console.log("\n--- TEST 6: Tampered payload scan error ---");
    // Modify one character of the signature to simulate tampering
    const tamperedSignature = signature.substring(0, signature.length - 1) + (signature.endsWith("0") ? "1" : "0");
    const tamperedQrPayload = JSON.stringify({ payload: payloadBase64, signature: tamperedSignature });

    const resScanTampered = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: tamperedQrPayload, agroDealerId: dealerId }
    });
    console.log(`Tampered scan status code: ${resScanTampered.statusCode}`);
    const bodyScanTampered = JSON.parse(resScanTampered.payload);
    console.log("Tampered scan response:", bodyScanTampered);
    if (resScanTampered.statusCode !== 400 || bodyScanTampered.error?.code !== "INVALID_SIGNATURE") {
      throw new Error("Expected INVALID_SIGNATURE error on tampered voucher.");
    }
    console.log("Tampering check passed!");

    // --- TEST 7: Weekly reconciliation job ---
    console.log("\n--- TEST 7: Weekly reconciliation job ---");
    const reconResult = await voucherService.runWeeklyReconciliation();
    console.log("Reconciliation result:", reconResult);
    if (reconResult.processedDealersCount !== 1) {
      throw new Error(`Expected 1 processed dealer, got ${reconResult.processedDealersCount}`);
    }

    // Verify reconciliation row
    const reconRowRes = await pool.query(
      "SELECT * FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1",
      [dealerId]
    );
    console.log("Reconciliation DB row:", reconRowRes.rows[0]);
    if (reconRowRes.rows.length === 0) {
      throw new Error("Reconciliation record was not created in DB.");
    }
    
    // Net KES should be: 55.00 * (1 - 3.50/100) = 55 * 0.965 = 53.075 -> rounded to 2 decimal places DECIMAL(12,2)
    const expectedKesOwed = 53.08;
    const actualKesOwed = Number(reconRowRes.rows[0].total_kes_owed);
    console.log(`Expected KES owed: ${expectedKesOwed}, got: ${actualKesOwed}`);
    if (Math.abs(actualKesOwed - expectedKesOwed) > 0.01) {
      throw new Error(`Expected total_kes_owed close to ${expectedKesOwed}, got ${actualKesOwed}`);
    }

    // Verify voucher status is now 'reconciled'
    const finalReconciledVch = await pool.query(
      "SELECT status, reconciled_at FROM voucher_redemptions WHERE voucher_code = $1",
      [voucherCode]
    );
    console.log("Reconciled voucher status:", finalReconciledVch.rows[0]);
    if (finalReconciledVch.rows[0].status !== "reconciled" || !finalReconciledVch.rows[0].reconciled_at) {
      throw new Error("Voucher was not marked as reconciled in database.");
    }

    console.log("Reconciliation tests passed!");

    console.log("\n⭐️ ALL MONTH 1 FARM INPUT VOUCHER INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Integration test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runVoucherTests();
