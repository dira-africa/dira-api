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

import { pool } from "./db/pool";
import { tokenService } from "./services/tokenService";
import { env } from "./config/env";

async function runConcurrencyTests() {
  console.log("Starting Token Ledger Concurrency & Safety Tests...");

  const testTelegramId = 99887766;
  let testUserId: string | null = null;

  try {
    // 1. Clean up previous test user data if any
    const existingUser = await pool.query(
      "SELECT id FROM users WHERE telegram_id = $1",
      [testTelegramId]
    );
    if (existingUser.rows.length > 0) {
      testUserId = existingUser.rows[0].id;
      await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [testUserId]);
      await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    }

    // 2. Seed test user
    console.log("Seeding test user...");
    const userRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES ($1, 'wallet_test_agent', pgp_sym_encrypt('+254799887766', $2), 'Wallet Test Agent', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [testTelegramId, env.PGCRYPTO_SYMMETRIC_KEY]
    );
    testUserId = userRes.rows[0].id as string;

    // 3. Test Initial Balance
    console.log("Test: Check initial balance...");
    const initialBal = await tokenService.getBalance(testUserId);
    console.log(`Initial balance: ${initialBal.balance}`);
    if (initialBal.balance !== 0) {
      throw new Error(`Expected initial balance of 0, got ${initialBal.balance}`);
    }
    console.log("✅ Initial balance test passed.");

    // 4. Test Credit Tokens
    console.log("Test: Credit 20.00 DIRA tokens...");
    const creditSuccess = await tokenService.creditTokens(
      testUserId,
      20,
      "atmospheric_sync",
      undefined,
      "Test credit of 20 tokens"
    );
    if (!creditSuccess) {
      throw new Error("Credit operation returned false");
    }
    const midBal = await tokenService.getBalance(testUserId);
    console.log(`Balance after credit: ${midBal.balance}`);
    if (midBal.balance !== 20) {
      throw new Error(`Expected balance of 20, got ${midBal.balance}`);
    }
    console.log("✅ Credit test passed.");

    // 5. Test Double-Spend Concurrency: Deduct 20 tokens concurrently twice
    console.log("Test: Triggering two concurrent deduction requests of 20 DIRA...");
    
    let successCount = 0;
    let failureCount = 0;
    let failureError: any = null;

    const promise1 = tokenService.deductTokens(testUserId, 20, "redeem_airtime");
    const promise2 = tokenService.deductTokens(testUserId, 20, "redeem_airtime");

    const results = await Promise.allSettled([promise1, promise2]);

    for (const res of results) {
      if (res.status === "fulfilled") {
        successCount++;
      } else {
        failureCount++;
        failureError = res.reason;
      }
    }

    console.log(`Concurrent results - Success: ${successCount}, Failures: ${failureCount}`);
    if (failureError) {
      console.log(`Deduction rejection error message: ${failureError.message}`);
    }

    // Assert that exactly one deduction succeeds, and exactly one fails with INSUFFICIENT_TOKENS
    if (successCount !== 1 || failureCount !== 1) {
      throw new Error(
        `Concurrency Assert Failed: Expected exactly 1 success and 1 failure. Got: ${successCount} successes, ${failureCount} failures`
      );
    }

    if (failureError?.message !== "INSUFFICIENT_TOKENS") {
      throw new Error(
        `Concurrency Assert Failed: Expected failure error to be 'INSUFFICIENT_TOKENS'. Got: '${failureError?.message}'`
      );
    }

    const finalBal = await tokenService.getBalance(testUserId);
    console.log(`Final balance in DB: ${finalBal.balance} DIRA`);
    if (finalBal.balance !== 0) {
      throw new Error(`Expected final balance to be 0 DIRA, got ${finalBal.balance}`);
    }
    console.log("✅ Double-Spend Concurrency Protection verified successfully!");

    // 6. Test concurrent crediting (should execute serially under SELECT FOR UPDATE and result in correct sum)
    console.log("Test: Running concurrent credits of 10.00 DIRA x 3...");
    const creditPromises = [
      tokenService.creditTokens(testUserId, 10, "bonus", undefined, "Credit A"),
      tokenService.creditTokens(testUserId, 10, "bonus", undefined, "Credit B"),
      tokenService.creditTokens(testUserId, 10, "bonus", undefined, "Credit C")
    ];

    await Promise.all(creditPromises);

    const postCreditBal = await tokenService.getBalance(testUserId);
    console.log(`Balance after concurrent credits: ${postCreditBal.balance} DIRA`);
    if (postCreditBal.balance !== 30) {
      throw new Error(`Expected final balance of 30, got ${postCreditBal.balance}`);
    }
    console.log("✅ Concurrent credit serialization verified successfully!");

    console.log("\n⭐️ ALL TOKEN LEDGER CONCURRENCY & SAFETY TESTS PASSED SUCCESSFULLY! ⭐️");

  } catch (err: any) {
    console.error("❌ Concurrency test runner failed:", err.message || err);
    process.exit(1);
  } finally {
    // Cleanup
    if (testUserId) {
      console.log("Cleaning up test user data...");
      await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [testUserId]);
      await pool.query("DELETE FROM users WHERE id = $1", [testUserId]);
    }
    await pool.end();
    process.exit(0);
  }
}

runConcurrencyTests();
