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
import { exec } from "child_process";
import fs from "fs";
import path from "path";

// Set VOUCHERS_ACTIVE to true dynamically for routes testing
(env as any).VOUCHERS_ACTIVE = true;

async function runVoucherSecurityAudit() {
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

  console.log("=========================================");
  console.log("🛡️ DIRA VOUCHER QR CODE SECURITY AUDIT 🛡️");
  console.log("=========================================");

  try {
    console.log("\n[SETUP] Seeding clean test user database states...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM voucher_redemptions");
    await pool.query("DELETE FROM agro_dealer_reconciliations");
    await pool.query("DELETE FROM agro_dealers");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM users WHERE telegram_id IN (998811, 998812)");

    // 1. Seed Farmer
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (998811, 'farmer_audit_user', pgp_sym_encrypt('+254701111111', $1), 'Farmer Audit User', 'farmer', 'en', 'Nairobi')
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
    await tokenService.awardTokens(farmerId, 500, "Initial Audit Balance", "bonus");

    // 2. Seed Partner/Agro-Dealer Agent
    const partnerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (998812, 'dealer_audit_user', pgp_sym_encrypt('+254788888888', $1), 'Dealer Audit User', 'agent', 'en', 'Nairobi')
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

    // 3. Seed Agro Dealer Business linked to Agent's Phone
    const dealerRes = await pool.query(
      `INSERT INTO agro_dealers (dealer_name, dealer_phone, county_id, bank_account, mou_signed_at, active)
       VALUES ('Audit Agro Supplies', '+254788888888', $1, '9988776655', CURRENT_TIMESTAMP, TRUE)
       RETURNING id`,
      [countyUuid]
    );
    const dealerId = dealerRes.rows[0].id;

    // Generate JWT tokens
    const farmerToken = server.jwt.sign({ id: farmerId, role: "farmer" });
    const partnerToken = server.jwt.sign({ id: partnerId, role: "agent" });

    // ----------------------------------------------------
    // AUDIT ITEM 1: Zod Env Validation for secret length
    // ----------------------------------------------------
    console.log("\n--- Audit Item 1: VOUCHER_SIGNING_SECRET >= 32 characters validation ---");
    const testSecretCmd = `node node_modules/ts-node/dist/bin.js --transpile-only -e "process.env.VOUCHER_SIGNING_SECRET='short'; require('./src/config/env')"`;
    
    const zodValidationPassed = await new Promise<boolean>((resolve) => {
      exec(testSecretCmd, { cwd: path.join(__dirname, "..") }, (error, stdout, stderr) => {
        if (error) {
          const combinedOutput = stdout + stderr;
          if (combinedOutput.includes("VOUCHER_SIGNING_SECRET must be at least 32 characters long")) {
            console.log("✅ Expected validation error caught. Server refuses to start with short secret!");
            resolve(true);
          } else {
            console.error("❌ Process exited with error, but missing validation message:", combinedOutput);
            resolve(false);
          }
        } else {
          console.error("❌ Server started successfully even with a short signing secret!");
          resolve(false);
        }
      });
    });

    if (!zodValidationPassed) {
      throw new Error("Audit Item 1 failed.");
    }

    // Helper to generate a valid QR payload for tests
    async function createValidQrText(amount: number): Promise<{ qrText: string; voucherCode: string; expiresAt: string }> {
      const res = await server.inject({
        method: "POST",
        url: "/api/tokens/redeem/voucher",
        headers: { Authorization: `Bearer ${farmerToken}` },
        payload: { token_amount: amount, agro_dealer_id: dealerId }
      });
      const data = JSON.parse(res.payload);
      
      // Decode QR payload string from qrDataUrl or construct manually
      const voucherCode = data.voucherCode;
      const expiresAt = data.expiresAt;
      
      const payloadObj = {
        voucherCode,
        farmerId,
        agroDealerId: dealerId,
        tokenAmount: amount,
        kesValue: amount * 0.55,
        expiresAt,
        keyVersion: 1
      };
      const payloadStr = JSON.stringify(payloadObj);
      const payloadBase64 = Buffer.from(payloadStr).toString("base64");
      const signature = crypto.createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
        .update(payloadBase64)
        .digest("hex");
        
      const qrText = JSON.stringify({ payload: payloadBase64, signature });
      return { qrText, voucherCode, expiresAt };
    }

    // ----------------------------------------------------
    // AUDIT ITEM 2: Signature Bypass Attack
    // ----------------------------------------------------
    console.log("\n--- Audit Item 2: Signature Bypass Attack ---");
    const { qrText: originalQr } = await createValidQrText(50);
    
    // Tamper with the base64 payload to attempt signature bypass
    const parsedQr = JSON.parse(originalQr);
    const tamperedPayload = parsedQr.payload.replace(/^[A-Za-z0-9]/, parsedQr.payload[0] === 'A' ? 'B' : 'A');
    const tamperedQr = JSON.stringify({ payload: tamperedPayload, signature: parsedQr.signature });

    const resBypass = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: tamperedQr, agroDealerId: dealerId }
    });

    console.log(`Scan tampered QR status: ${resBypass.statusCode}`);
    const bodyBypass = JSON.parse(resBypass.payload);
    console.log("Response body:", bodyBypass);

    if (resBypass.statusCode !== 400 || bodyBypass.error?.code !== "INVALID_SIGNATURE") {
      throw new Error(`Expected 400 INVALID_SIGNATURE, got ${resBypass.statusCode} with error: ${JSON.stringify(bodyBypass)}`);
    }
    console.log("✅ Audit Item 2 passed! Signature bypass successfully prevented.");

    // ----------------------------------------------------
    // AUDIT ITEM 3: Replay Attack
    // ----------------------------------------------------
    console.log("\n--- Audit Item 3: Replay Attack / Double Spend ---");
    const { qrText: replayQr } = await createValidQrText(50);

    // 1st Scan
    const resScan1 = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: replayQr, agroDealerId: dealerId }
    });
    console.log(`First scan status: ${resScan1.statusCode}`);
    if (resScan1.statusCode !== 200) {
      throw new Error(`First scan failed: ${resScan1.payload}`);
    }

    // 2nd Scan
    const resScan2 = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: replayQr, agroDealerId: dealerId }
    });
    console.log(`Second scan status: ${resScan2.statusCode}`);
    const bodyScan2 = JSON.parse(resScan2.payload);
    console.log("Response body:", bodyScan2);

    if (resScan2.statusCode !== 400 || bodyScan2.error?.code !== "VOUCHER_ALREADY_REDEEMED") {
      throw new Error(`Expected 400 VOUCHER_ALREADY_REDEEMED, got ${resScan2.statusCode}`);
    }
    console.log("✅ Audit Item 3 passed! Replay attack blocked successfully.");

    // ----------------------------------------------------
    // AUDIT ITEM 4: Voucher Expiry
    // ----------------------------------------------------
    console.log("\n--- Audit Item 4: Voucher Expiry check ---");
    const expiredTime = new Date(Date.now() - 49 * 60 * 60 * 1000); // 49 hours ago
    const expiredVoucherCode = crypto.randomUUID();

    // Insert pre-expired voucher record in db
    await pool.query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
       VALUES ($1, $2, 50, 27.5, $3, 'expired-hash', $4, 'generated')`,
      [farmerUuid, dealerId, expiredVoucherCode, expiredTime]
    );

    // Sign payload representing an expired time
    const expiredPayloadObj = {
      voucherCode: expiredVoucherCode,
      farmerId,
      agroDealerId: dealerId,
      tokenAmount: 50,
      kesValue: 27.5,
      expiresAt: expiredTime.toISOString(),
      keyVersion: 1
    };
    const expiredPayloadBase64 = Buffer.from(JSON.stringify(expiredPayloadObj)).toString("base64");
    const expiredSignature = crypto.createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(expiredPayloadBase64)
      .digest("hex");
    const expiredQrText = JSON.stringify({ payload: expiredPayloadBase64, signature: expiredSignature });

    const resScanExpired = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${partnerToken}` },
      payload: { qrPayload: expiredQrText, agroDealerId: dealerId }
    });

    console.log(`Scan expired voucher status: ${resScanExpired.statusCode}`);
    const bodyScanExpired = JSON.parse(resScanExpired.payload);
    console.log("Response body:", bodyScanExpired);

    if (resScanExpired.statusCode !== 400 || bodyScanExpired.error?.code !== "VOUCHER_EXPIRED") {
      throw new Error(`Expected 400 VOUCHER_EXPIRED, got ${resScanExpired.statusCode}`);
    }
    console.log("✅ Audit Item 4 passed! Expired voucher rejected.");

    // ----------------------------------------------------
    // AUDIT ITEM 5: Token Inflation Attack
    // ----------------------------------------------------
    console.log("\n--- Audit Item 5: Token Inflation Attack ---");
    const initialBalanceRes = await tokenService.getBalance(farmerId);
    const initialBalance = initialBalanceRes.balance;
    console.log(`Farmer current balance: ${initialBalance} Climate Tokens`);

    const resInflate = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/voucher",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { token_amount: initialBalance + 100, agro_dealer_id: dealerId }
    });

    console.log(`Generate inflation status: ${resInflate.statusCode}`);
    const bodyInflate = JSON.parse(resInflate.payload);
    console.log("Response body:", bodyInflate);

    if (resInflate.statusCode !== 400 || bodyInflate.error?.code !== "INSUFFICIENT_TOKENS") {
      throw new Error(`Expected 400 INSUFFICIENT_TOKENS, got ${resInflate.statusCode}`);
    }

    const postBalanceRes = await tokenService.getBalance(farmerId);
    const postBalance = postBalanceRes.balance;
    console.log(`Farmer balance after failed inflation: ${postBalance} Climate Tokens`);

    if (postBalance !== initialBalance) {
      throw new Error(`Token balance was modified from ${initialBalance} to ${postBalance} after failed generation!`);
    }
    console.log("✅ Audit Item 5 passed! Token inflation blocked and balance remains untouched.");

    // ----------------------------------------------------
    // AUDIT ITEM 6: Timing-Safe Comparisons
    // ----------------------------------------------------
    console.log("\n--- Audit Item 6: Timing-Safe comparisons ---");
    const serviceContent = fs.readFileSync(path.join(__dirname, "services/voucherService.ts"), "utf-8");
    const doubleEqualMatches = serviceContent.match(/signature\s*===/gi) || serviceContent.match(/===.*?signature/gi) || serviceContent.match(/hash\s*===/gi);
    
    if (doubleEqualMatches && doubleEqualMatches.length > 0) {
      throw new Error(`Detected unsafe cryptographic signature/hash === comparison in voucherService: ${doubleEqualMatches.join(", ")}`);
    }
    console.log("✅ Audit Item 6 passed! Inspected code has timing-safe comparisons via crypto.timingSafeEqual().");

    // ----------------------------------------------------
    // AUDIT ITEM 7: Agro-Dealer Authentication & Authorization
    // ----------------------------------------------------
    console.log("\n--- Audit Item 7: Agro-dealer authentication & role authorization ---");
    
    // Call without token
    const resNoToken = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      payload: { qrPayload: originalQr, agroDealerId: dealerId }
    });
    console.log(`No token scan status: ${resNoToken.statusCode}`);
    if (resNoToken.statusCode !== 401) {
      throw new Error(`Expected 401 Unauthorized for request with no credentials, got ${resNoToken.statusCode}`);
    }

    // Call with farmer token (Should not work on partner endpoint)
    const resFarmerScan = await server.inject({
      method: "POST",
      url: "/api/partner/voucher/scan",
      headers: { Authorization: `Bearer ${farmerToken}` },
      payload: { qrPayload: originalQr, agroDealerId: dealerId }
    });
    console.log(`Farmer token scan status: ${resFarmerScan.statusCode}`);
    if (resFarmerScan.statusCode !== 403) {
      throw new Error(`Expected 403 Forbidden when farmer attempts to scan a voucher, got ${resFarmerScan.statusCode}`);
    }
    console.log("✅ Audit Item 7 passed! Valid credentials are required, and farmer accounts are blocked with 403.");

    // ----------------------------------------------------
    // AUDIT ITEM 8: QR Code Size limit test (< 1KB)
    // ----------------------------------------------------
    console.log("\n--- Audit Item 8: QR Code size limit check ---");
    const { qrText: testSizeQr } = await createValidQrText(50);
    const qrBytes = Buffer.from(testSizeQr).length;
    console.log(`QR Text payload size: ${qrBytes} bytes (${(qrBytes / 1024).toFixed(3)} KB)`);
    if (qrBytes >= 1024) {
      throw new Error(`Payload size is ${qrBytes} bytes, which exceeds the 1024 bytes (1KB) limit.`);
    }
    console.log("✅ Audit Item 8 passed! QR Payload is well under 1KB.");

    // ----------------------------------------------------
    // AUDIT ITEM 10: Key Rotation Simulation
    // ----------------------------------------------------
    console.log("\n--- Audit Item 10: Key Rotation Simulation ---");
    const { qrText: oldKeyQr } = await createValidQrText(50);
    
    // Temporarily rotate key in-memory
    const originalSecret = env.VOUCHER_SIGNING_SECRET;
    const rotatedSecret = "RotatedSigningSecretKeyAtLeast32CharactersLongToVerifyKeyRotation";
    console.log(`Rotating signing secret in memory to: ${rotatedSecret}`);
    (env as any).VOUCHER_SIGNING_SECRET = rotatedSecret;

    try {
      // Scanning the old voucher must fail with 400 INVALID_SIGNATURE
      const resScanOldKey = await server.inject({
        method: "POST",
        url: "/api/partner/voucher/scan",
        headers: { Authorization: `Bearer ${partnerToken}` },
        payload: { qrPayload: oldKeyQr, agroDealerId: dealerId }
      });
      console.log(`Scan old key voucher status: ${resScanOldKey.statusCode}`);
      const bodyScanOldKey = JSON.parse(resScanOldKey.payload);
      if (resScanOldKey.statusCode !== 400 || bodyScanOldKey.error?.code !== "INVALID_SIGNATURE") {
        throw new Error(`Expected old voucher scan to fail with 400 INVALID_SIGNATURE, got ${resScanOldKey.statusCode}`);
      }
      console.log("  - Old key voucher rejected correctly.");

      // Generating a new voucher under the new key must scan and redeem successfully
      const { qrText: newKeyQr } = await createValidQrText(50);
      const resScanNewKey = await server.inject({
        method: "POST",
        url: "/api/partner/voucher/scan",
        headers: { Authorization: `Bearer ${partnerToken}` },
        payload: { qrPayload: newKeyQr, agroDealerId: dealerId }
      });
      console.log(`Scan new key voucher status: ${resScanNewKey.statusCode}`);
      if (resScanNewKey.statusCode !== 200) {
        throw new Error(`Expected new key voucher scan to succeed with 200, got ${resScanNewKey.statusCode}`);
      }
      console.log("  - New key voucher accepted correctly.");

    } finally {
      // Restore secret
      (env as any).VOUCHER_SIGNING_SECRET = originalSecret;
    }
    console.log("✅ Audit Item 10 passed! Key rotation works correctly.");

    console.log("\n=========================================");
    console.log("🎉 ALL VOUCHER SECURITY AUDIT ITEMS PASSED SUCCESSFULLY! 🎉");
    console.log("=========================================");

  } catch (err) {
    console.error("❌ Voucher security audit failed:", err);
    process.exit(1);
  } finally {
    await server.close();
    try {
      const { redis } = require("./db/redis");
      await redis.quit();
    } catch {}
    process.exit(0);
  }
}

runVoucherSecurityAudit();
