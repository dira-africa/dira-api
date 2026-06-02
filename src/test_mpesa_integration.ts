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
import webhooksRoutes from "./routes/webhooks";
import publicRoutes from "./routes/public";
import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";

async function runMpesaTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(webhooksRoutes, { prefix: "/api/webhooks" });
  await server.register(publicRoutes);

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
       VALUES (998877, 'test_farmer_mpesa', pgp_sym_encrypt('+254711222222', $1), 'M-Pesa Farmer', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    // Seed token balance for the farmer (200 DIRA)
    await tokenService.creditTokens(farmerId, 200, "bonus", undefined, "Initial seed");

    const token = server.jwt.sign({ id: farmerId, role: "farmer" });

    // ==========================================
    // --- Test 1: Flag Gating (Inactive Mode) ---
    // ==========================================
    console.log("\n--- Test 1: Gating - DARAJA_PRODUCTION_ACTIVE = false ---");
    process.env.DARAJA_PRODUCTION_ACTIVE = "false";
    // Also override env object if configured globally
    env.DARAJA_PRODUCTION_ACTIVE = false;

    const res1 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 100, phone_number: "+254711222222" }
    });
    console.log(`Test 1 Status Code: ${res1.statusCode}`);
    const body1 = JSON.parse(res1.payload);
    console.log("Test 1 Response:", body1);

    if (res1.statusCode !== 503 || body1.error?.code !== "MPESA_NOT_YET_ACTIVE") {
      throw new Error(`Expected 503 MPESA_NOT_YET_ACTIVE when inactive, got ${res1.statusCode}`);
    }

    // ========================================
    // --- Activate M-Pesa B2C Production -----
    // ========================================
    process.env.DARAJA_PRODUCTION_ACTIVE = "true";
    env.DARAJA_PRODUCTION_ACTIVE = true;

    // ==========================================
    // --- Test 2: Validation Checks ------------
    // ==========================================
    console.log("\n--- Test 2a: Minimum Token Requirement (99 Tokens) ---");
    const res2a = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 99, phone_number: "+254711222222" }
    });
    console.log(`Test 2a Status Code: ${res2a.statusCode}`);
    const body2a = JSON.parse(res2a.payload);
    if (res2a.statusCode !== 400 || body2a.error?.code !== "BELOW_MINIMUM_TOKENS") {
      throw new Error(`Expected 400 BELOW_MINIMUM_TOKENS, got ${res2a.statusCode}`);
    }

    console.log("\n--- Test 2b: Invalid Phone Number format ---");
    const res2b = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 100, phone_number: "0123" }
    });
    console.log(`Test 2b Status Code: ${res2b.statusCode}`);
    const body2b = JSON.parse(res2b.payload);
    if (res2b.statusCode !== 400 || body2b.error?.code !== "INVALID_PHONE_NUMBER") {
      throw new Error(`Expected 400 INVALID_PHONE_NUMBER, got ${res2b.statusCode}`);
    }

    console.log("\n--- Test 2c: Insufficient Token Balance (300 Tokens) ---");
    const res2c = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 300, phone_number: "+254711222222" }
    });
    console.log(`Test 2c Status Code: ${res2c.statusCode}`);
    const body2c = JSON.parse(res2c.payload);
    if (res2c.statusCode !== 400 || body2c.error?.code !== "INSUFFICIENT_TOKENS") {
      throw new Error(`Expected 400 INSUFFICIENT_TOKENS, got ${res2c.statusCode}`);
    }

    // ==========================================
    // --- Test 3: Successful Cashout Trigger ---
    // ==========================================
    console.log("\n--- Test 3: Initiate Valid M-Pesa Cashout (100 Tokens) ---");
    const res3 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 100, phone_number: "+254711222222" }
    });
    console.log(`Test 3 Status Code: ${res3.statusCode}`);
    const body3 = JSON.parse(res3.payload);
    console.log("Test 3 Response:", body3);

    if (res3.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res3.statusCode}`);
    }
    if (!body3.success || body3.amountKes !== 50.00 || !body3.conversationId || !body3.redemptionId) {
      throw new Error(`Invalid response schema from initiateMpesaB2C: ${JSON.stringify(body3)}`);
    }

    // Verify token balance is deducted immediately (200 - 100 = 100)
    const bal3 = await tokenService.getBalance(farmerId);
    console.log("Farmer balance after Test 3 trigger:", bal3.balance);
    if (bal3.balance !== 100) {
      throw new Error(`Expected balance 100, got ${bal3.balance}`);
    }

    const test3ConversationId = body3.conversationId;
    const test3RedemptionId = body3.redemptionId;

    // Verify redemption request is created with 'processing' status in db
    const reqDb3 = await pool.query("SELECT status, at_transaction_id FROM redemption_requests WHERE id = $1", [test3RedemptionId]);
    console.log("DB Request for Test 3:", reqDb3.rows[0]);
    if (reqDb3.rows[0].status !== "processing" || reqDb3.rows[0].at_transaction_id !== test3ConversationId) {
      throw new Error(`Invalid DB transaction state: ${JSON.stringify(reqDb3.rows[0])}`);
    }

    // ==========================================
    // --- Test 4: Webhook Security (IP Guard) --
    // ==========================================
    console.log("\n--- Test 4: Webhook IP Allowlist Enforcement ---");
    const res4Result = await server.inject({
      method: "POST",
      url: "/api/webhooks/daraja/result",
      remoteAddress: "8.8.8.8",
      payload: { Result: { ConversationID: test3ConversationId, ResultCode: 0 } }
    });
    console.log(`Webhook Result (8.8.8.8) Status: ${res4Result.statusCode}`);
    if (res4Result.statusCode !== 401) {
      throw new Error(`Expected 401 for unauthorized IP on Result URL, got ${res4Result.statusCode}`);
    }

    const res4Timeout = await server.inject({
      method: "POST",
      url: "/api/webhooks/daraja/timeout",
      remoteAddress: "8.8.8.8",
      payload: { Result: { ConversationID: test3ConversationId } }
    });
    console.log(`Webhook Timeout (8.8.8.8) Status: ${res4Timeout.statusCode}`);
    if (res4Timeout.statusCode !== 401) {
      throw new Error(`Expected 401 for unauthorized IP on Timeout URL, got ${res4Timeout.statusCode}`);
    }

    // ==========================================
    // --- Test 5: Successful Webhook Callback -
    // ==========================================
    console.log("\n--- Test 5: Handle Successful Daraja Callback ---");
    const res5 = await server.inject({
      method: "POST",
      url: "/api/webhooks/daraja/result",
      remoteAddress: "127.0.0.1",
      payload: {
        Result: {
          ConversationID: test3ConversationId,
          ResultCode: 0,
          ResultDesc: "The service request has been accepted successfully.",
          TransactionID: "NL12345678",
          ResultParameters: {
            ResultParameter: [
              { Key: "TransactionReceipt", Value: "NL12345678" },
              { Key: "Amount", Value: 50.00 }
            ]
          }
        }
      }
    });
    console.log(`Webhook callback status: ${res5.statusCode}`);
    if (res5.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res5.statusCode}`);
    }

    // Verify DB request status is updated to 'completed'
    const reqDb5 = await pool.query("SELECT status, mpesa_receipt FROM redemption_requests WHERE id = $1", [test3RedemptionId]);
    console.log("DB Request after Test 5:", reqDb5.rows[0]);
    if (reqDb5.rows[0].status !== "completed" || reqDb5.rows[0].mpesa_receipt !== "NL12345678") {
      throw new Error(`Expected completed status and NL12345678 receipt, got: ${JSON.stringify(reqDb5.rows[0])}`);
    }

    // Verify token balance remains 100 (spent)
    const bal5 = await tokenService.getBalance(farmerId);
    console.log("Balance after Test 5 success:", bal5.balance);
    if (bal5.balance !== 100) {
      throw new Error(`Expected balance 100, got ${bal5.balance}`);
    }

    // ==========================================
    // --- Test 6: Failed Webhook Callback -----
    // ==========================================
    console.log("\n--- Test 6: Handle Failed Daraja Callback (Deduct & Refund) ---");
    // Initiate cashout of another 100 tokens (reducing balance to 0)
    const res6a = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 100, phone_number: "+254711222222" }
    });
    const body6a = JSON.parse(res6a.payload);
    const test6ConversationId = body6a.conversationId;
    const test6RedemptionId = body6a.redemptionId;

    // Check balance is 0
    const bal6a = await tokenService.getBalance(farmerId);
    console.log("Balance before failed callback:", bal6a.balance);
    if (bal6a.balance !== 0) {
      throw new Error(`Expected balance 0 before callback, got ${bal6a.balance}`);
    }

    // Trigger failed callback (ResultCode !== 0)
    const res6b = await server.inject({
      method: "POST",
      url: "/api/webhooks/daraja/result",
      remoteAddress: "127.0.0.1",
      payload: {
        Result: {
          ConversationID: test6ConversationId,
          ResultCode: 1,
          ResultDesc: "The balance is insufficient for the transaction."
        }
      }
    });
    console.log(`Failed Webhook callback status: ${res6b.statusCode}`);
    if (res6b.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res6b.statusCode}`);
    }

    // Verify DB request status is updated to 'failed' and failure reason logged
    const reqDb6 = await pool.query("SELECT status, failure_reason FROM redemption_requests WHERE id = $1", [test6RedemptionId]);
    console.log("DB Request after failed callback:", reqDb6.rows[0]);
    if (reqDb6.rows[0].status !== "failed" || !reqDb6.rows[0].failure_reason.includes("insufficient")) {
      throw new Error(`Expected status 'failed' with failure reason, got: ${JSON.stringify(reqDb6.rows[0])}`);
    }

    // Verify token balance is refunded (restored to 100)
    const bal6b = await tokenService.getBalance(farmerId);
    console.log("Balance after failed callback refund:", bal6b.balance);
    if (bal6b.balance !== 100) {
      throw new Error(`Expected balance 100 after refund, got ${bal6b.balance}`);
    }

    // ==========================================
    // --- Test 7: Timeout Webhook Callback -----
    // ==========================================
    console.log("\n--- Test 7: Handle Timeout Daraja Callback (Deduct & Refund) ---");
    // Initiate cashout of another 100 tokens (reducing balance to 0)
    const res7a = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/mpesa",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 100, phone_number: "+254711222222" }
    });
    const body7a = JSON.parse(res7a.payload);
    const test7ConversationId = body7a.conversationId;
    const test7RedemptionId = body7a.redemptionId;

    // Check balance is 0
    const bal7a = await tokenService.getBalance(farmerId);
    console.log("Balance before timeout callback:", bal7a.balance);
    if (bal7a.balance !== 0) {
      throw new Error(`Expected balance 0, got ${bal7a.balance}`);
    }

    // Trigger timeout callback
    const res7b = await server.inject({
      method: "POST",
      url: "/api/webhooks/daraja/timeout",
      remoteAddress: "127.0.0.1",
      payload: {
        Result: {
          ConversationID: test7ConversationId
        }
      }
    });
    console.log(`Timeout Webhook callback status: ${res7b.statusCode}`);
    if (res7b.statusCode !== 200) {
      throw new Error(`Expected status 200, got ${res7b.statusCode}`);
    }

    // Verify DB request status is updated to 'failed' and timeout logged
    const reqDb7 = await pool.query("SELECT status, failure_reason FROM redemption_requests WHERE id = $1", [test7RedemptionId]);
    console.log("DB Request after timeout callback:", reqDb7.rows[0]);
    if (reqDb7.rows[0].status !== "failed" || reqDb7.rows[0].failure_reason !== "Daraja timeout") {
      throw new Error(`Expected status 'failed' due to timeout, got: ${JSON.stringify(reqDb7.rows[0])}`);
    }

    // Verify token balance is refunded (restored to 100)
    const bal7b = await tokenService.getBalance(farmerId);
    console.log("Balance after timeout callback refund:", bal7b.balance);
    if (bal7b.balance !== 100) {
      throw new Error(`Expected balance 100, got ${bal7b.balance}`);
    }

    // ==========================================
    // --- Test 8: Public Polling Endpoint ------
    // ==========================================
    console.log("\n--- Test 8: Public Polling Endpoint GET /api/payments/:id/status ---");
    // Poll the first transaction (completed)
    const res8Completed = await server.inject({
      method: "GET",
      url: `/api/payments/${test3RedemptionId}/status`,
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`Polling status completed status: ${res8Completed.statusCode}`);
    const body8Completed = JSON.parse(res8Completed.payload);
    console.log("Completed payment status details:", body8Completed);
    if (res8Completed.statusCode !== 200 || !body8Completed.success || body8Completed.payment.status !== "completed") {
      throw new Error(`Invalid polling response for completed payout: ${JSON.stringify(body8Completed)}`);
    }

    // Poll the second transaction (failed)
    const res8Failed = await server.inject({
      method: "GET",
      url: `/api/payments/${test6RedemptionId}/status`,
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`Polling status failed status: ${res8Failed.statusCode}`);
    const body8Failed = JSON.parse(res8Failed.payload);
    console.log("Failed payment status details:", body8Failed);
    if (res8Failed.statusCode !== 200 || !body8Failed.success || body8Failed.payment.status !== "failed") {
      throw new Error(`Invalid polling response for failed payout: ${JSON.stringify(body8Failed)}`);
    }

    console.log("\n⭐️ ALL SAFARICOM DARAJA B2C INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Safaricom Daraja B2C integration tests failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runMpesaTests();
