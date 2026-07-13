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

// 1. Monkey-patch database pool before any other imports
import { pool } from "./db/pool";
import { randomUUID } from "crypto";

const mockDb = {
  users: [] as any[],
  redemption_requests: [] as any[],
  token_transactions: [] as any[],
  token_ledger: [] as any[]
};

const mockUserId = "123e4567-e89b-12d3-a456-426614174000";
mockDb.users.push({
  id: mockUserId,
  telegram_id: 998877,
  telegram_username: "test_farmer_airtime_callback",
  phone_number: "+254711222222",
  full_name: "Airtime Callback Farmer",
  role: "farmer",
  language: "en",
  county: "Nairobi"
});

(pool as any).query = async (text: any, params: any[] = []) => {
  const normalizedText = text.trim().replace(/\s+/g, " ");

  if (normalizedText.includes("SELECT 1")) {
    return { rows: [{ 1: 1 }] };
  }

  if (normalizedText.includes("DELETE FROM")) {
    if (normalizedText.includes("redemption_requests")) mockDb.redemption_requests = [];
    if (normalizedText.includes("token_ledger")) mockDb.token_ledger = [];
    if (normalizedText.includes("users")) {
      mockDb.users = mockDb.users.filter(u => u.telegram_id !== 998877);
    }
    return { rows: [], rowCount: 0 };
  }

  if (normalizedText.includes("INSERT INTO users")) {
    const newUser = {
      id: mockUserId,
      telegram_id: params[0],
      telegram_username: params[1],
      phone_number: "+254711222222",
      full_name: params[3],
      role: params[4],
      language: params[5],
      county: params[6]
    };
    mockDb.users.push(newUser);
    return { rows: [newUser], rowCount: 1 };
  }

  if (normalizedText.includes("SELECT COALESCE(SUM")) {
    let balance = 0;
    const userId = params[0];
    for (const tx of mockDb.token_transactions) {
      if (tx.user_id === userId && tx.status === "confirmed") {
        if (tx.type === "earn") balance += Number(tx.amount);
        else balance -= Number(tx.amount);
      }
    }
    return { rows: [{ balance: String(balance) }], rowCount: 1 };
  }

  if (normalizedText.includes("SELECT") && normalizedText.includes("redemption_requests") && normalizedText.includes("at_transaction_id = $1")) {
    const atTxId = params[0];
    const red = mockDb.redemption_requests.find(r => r.at_transaction_id === atTxId);
    return { rows: red ? [red] : [], rowCount: red ? 1 : 0 };
  }

  if (normalizedText.includes("SELECT") && normalizedText.includes("redemption_requests") && normalizedText.includes("id = $1")) {
    const id = params[0];
    const match = mockDb.redemption_requests.find(r => r.id === id);
    return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
  }

  if (normalizedText.includes("INSERT INTO redemption_requests")) {
    const newRed = {
      id: params[0],
      user_id: params[1],
      tokens_spent: params[2],
      redemption_type: params[3],
      amount_kes: params[4],
      phone_number: "+254711222222",
      status: params[6] || "pending",
      at_transaction_id: null
    };
    mockDb.redemption_requests.push(newRed);
    return { rows: [newRed], rowCount: 1 };
  }

  if (normalizedText.includes("UPDATE redemption_requests") && normalizedText.includes("at_transaction_id = $1")) {
    const atTxId = params[0];
    const redId = params[1];
    const red = mockDb.redemption_requests.find(r => r.id === redId);
    if (red) {
      red.status = "completed";
      red.at_transaction_id = atTxId;
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalizedText.includes("UPDATE redemption_requests") && normalizedText.includes("status = 'completed'") && normalizedText.includes("WHERE id = $1")) {
    const redId = params[0];
    const red = mockDb.redemption_requests.find(r => r.id === redId);
    if (red) {
      red.status = "completed";
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalizedText.includes("UPDATE redemption_requests") && normalizedText.includes("status = 'failed'") && normalizedText.includes("WHERE id = $2")) {
    const reason = params[0];
    const redId = params[1];
    const red = mockDb.redemption_requests.find(r => r.id === redId);
    if (red) {
      red.status = "failed";
      red.failure_reason = reason;
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalizedText.includes("UPDATE redemption_requests") && normalizedText.includes("status = 'failed'") && normalizedText.includes("WHERE id = $1")) {
    const redId = params[0];
    const red = mockDb.redemption_requests.find(r => r.id === redId);
    if (red) {
      red.status = "failed";
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalizedText.includes("UPDATE redemption_requests") && normalizedText.includes("status = 'failed'") && normalizedText.includes("WHERE at_transaction_id = $2")) {
    const reason = params[0];
    const atTxId = params[1];
    const red = mockDb.redemption_requests.find(r => r.at_transaction_id === atTxId);
    if (red) {
      red.status = "failed";
      red.failure_reason = reason;
    }
    return { rows: [], rowCount: 1 };
  }

  if (normalizedText.includes("SELECT") && normalizedText.includes("token_transactions")) {
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
};

(pool as any).connect = async () => {
  return {
    query: async (text: string, params: any[]) => {
      const normalizedText = text.trim().replace(/\s+/g, " ");

      if (normalizedText.includes("SELECT id FROM users WHERE id = $1 FOR UPDATE")) {
        const userId = params[0];
        const match = mockDb.users.find(u => u.id === userId);
        return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
      }

      if (normalizedText.includes("SELECT COALESCE(SUM")) {
        let balance = 0;
        const userId = params[0];
        for (const tx of mockDb.token_transactions) {
          if (tx.user_id === userId && tx.status === "confirmed") {
            if (tx.type === "earn") balance += Number(tx.amount);
            else balance -= Number(tx.amount);
          }
        }
        return { rows: [{ balance: String(balance) }], rowCount: 1 };
      }

      if (normalizedText.includes("INSERT INTO token_transactions")) {
        const isEarn = normalizedText.includes("'earn'");
        const newTx = {
          id: randomUUID(),
          user_id: params[0],
          amount: params[1],
          type: isEarn ? "earn" : params[2],
          reference_id: isEarn ? params[2] : params[3],
          status: "confirmed",
          hts_tx_id: isEarn ? params[3] : params[4]
        };
        mockDb.token_transactions.push(newTx);
        return { rows: [newTx], rowCount: 1 };
      }

      if (normalizedText.includes("INSERT INTO token_ledger")) {
        const newLed = {
          id: randomUUID(),
          user_id: params[0],
          amount: params[1],
          balance_after: params[2],
          transaction_type: params[3],
          reference_id: params[4],
          notes: params[5],
          hts_tx_id: params[6] || null
        };
        mockDb.token_ledger.push(newLed);
        return { rows: [newLed], rowCount: 1 };
      }

      if (normalizedText.includes("BEGIN") || normalizedText.includes("COMMIT") || normalizedText.includes("ROLLBACK")) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    release: () => {}
  } as any;
};

// 2. Monkey-patch Hedera transaction calls before importing tokenService
import * as hashgraphSdk from "@hashgraph/sdk";

hashgraphSdk.TokenMintTransaction.prototype.execute = async function() {
  return {
    transactionId: {
      toString: () => "0.0.9457591@1783886848.204061081"
    },
    getReceipt: async () => {
      return {};
    }
  } as any;
};
hashgraphSdk.TokenBurnTransaction.prototype.execute = async function() {
  return {
    transactionId: {
      toString: () => "0.0.9457591@1783886848.204061081"
    },
    getReceipt: async () => {
      return {};
    }
  } as any;
};

// 3. Import rest of requirements
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import tokensRoutes from "./routes/tokens";
import webhooksRoutes from "./routes/webhooks";
import { tokenService } from "./services/tokenService";

async function runCallbackTests() {
  console.log("=== STARTING AFRICA'S TALKING AIRTIME TRIGGER & CALLBACK TESTS ===");

  const server = Fastify({
    logger: { level: "warn" }
  });

  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(webhooksRoutes, { prefix: "/api/webhooks" });

  await server.ready();

  try {
    // Clean up mockDb in-memory database
    mockDb.redemption_requests = [];
    mockDb.token_transactions = [];
    mockDb.token_ledger = [];

    // Seed token balance for the farmer (3000 DIRA)
    await tokenService.creditTokens(mockUserId, 3000, "bonus", undefined, "Initial seed");

    const token = server.jwt.sign({ id: mockUserId, role: "farmer" });

    // --- Test 1: Limit validation (Redeem 2001 tokens - above max limit) ---
    console.log("\n--- Test 1: Redeem 2001 tokens (Above 2000 Cap) ---");
    const res1 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { token_amount: 2001, phone_number: "+254711222222" }
    });
    console.log(`Test 1 Status Code: ${res1.statusCode}`);
    const body1 = JSON.parse(res1.payload);
    console.log("Test 1 Response:", body1);

    if (res1.statusCode !== 400 || body1.error?.code !== "EXCEEDS_MAX_LIMIT") {
      throw new Error(`Expected 400 EXCEEDS_MAX_LIMIT, got ${res1.statusCode}`);
    }

    // --- Test 2: Successful redemption initiation & first call ---
    console.log("\n--- Test 2: Redeem 50 tokens (Successful Initiation) ---");
    const redemptionId = randomUUID();
    const res2 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { 
        token_amount: 50, 
        phone_number: "+254711222222",
        redemption_id: redemptionId
      }
    });
    console.log(`Test 2 Status Code: ${res2.statusCode}`);
    const body2 = JSON.parse(res2.payload);
    console.log("Test 2 Response:", body2);

    if (res2.statusCode !== 200 || !body2.success) {
      throw new Error(`Expected success, got status ${res2.statusCode}`);
    }

    // Verify token balance decreased by 50 (3000 - 50 = 2950)
    const balAfter2 = await tokenService.getBalance(mockUserId);
    console.log("Current balance after Test 2:", balAfter2.balance);
    if (balAfter2.balance !== 2950) {
      throw new Error(`Expected balance 2950, got ${balAfter2.balance}`);
    }

    // --- Test 3: Idempotency (Re-send identical request with same redemption_id) ---
    console.log("\n--- Test 3: Re-send identical request (Idempotency check) ---");
    const res3 = await server.inject({
      method: "POST",
      url: "/api/tokens/redeem/airtime",
      headers: { Authorization: `Bearer ${token}` },
      payload: { 
        token_amount: 50, 
        phone_number: "+254711222222",
        redemption_id: redemptionId
      }
    });
    console.log(`Test 3 Status Code: ${res3.statusCode}`);
    const body3 = JSON.parse(res3.payload);
    console.log("Test 3 Response:", body3);

    if (res3.statusCode !== 200 || !body3.success) {
      throw new Error(`Expected cached success, got status ${res3.statusCode}`);
    }

    // Verify balance DID NOT decrease again (still 2950)
    const balAfter3 = await tokenService.getBalance(mockUserId);
    console.log("Current balance after Test 3 (Should be unchanged):", balAfter3.balance);
    if (balAfter3.balance !== 2950) {
      throw new Error(`Expected balance to remain 2950, but got ${balAfter3.balance}`);
    }

    // --- Test 4: Callback processing (Trigger a delivery failure callback) ---
    console.log("\n--- Test 4: Simulate Africa's Talking Delivery Failure Callback ---");
    const redMatch = mockDb.redemption_requests.find(r => r.id === redemptionId);
    if (!redMatch) {
      throw new Error("Redemption request not found in mock DB");
    }
    const atTxId = redMatch.at_transaction_id;
    console.log(`Matching Africa's Talking Transaction ID (requestId): ${atTxId}`);

    const res4 = await server.inject({
      method: "POST",
      url: "/api/webhooks/africastalking/callback",
      payload: {
        requestId: atTxId,
        status: "Failed",
        phoneNumber: "+254711222222",
        value: "KES 27.50",
        errorMessage: "User Phone Number is suspended/inactive"
      }
    });
    console.log(`Test 4 Status Code: ${res4.statusCode}`);
    const body4 = JSON.parse(res4.payload);
    console.log("Test 4 Response:", body4);

    if (res4.statusCode !== 200 || !body4.success) {
      throw new Error(`Expected 200 success callback response, got ${res4.statusCode}`);
    }

    // Verify token balance was refunded (2950 + 50 = 3000)
    const balAfter4 = await tokenService.getBalance(mockUserId);
    console.log("Current balance after Test 4 (Refunded back to original):", balAfter4.balance);
    if (balAfter4.balance !== 3000) {
      throw new Error(`Expected balance 3000 after refund, got ${balAfter4.balance}`);
    }

    // Verify database record status is 'failed' and error message is saved
    const dbRecordAfterCallback = mockDb.redemption_requests.find(r => r.id === redemptionId);
    console.log("Database record after callback:", dbRecordAfterCallback);
    if (
      dbRecordAfterCallback.status !== "failed" ||
      dbRecordAfterCallback.failure_reason !== "User Phone Number is suspended/inactive"
    ) {
      throw new Error("Failed to update DB record correctly");
    }

    console.log("\n⭐️ ALL AFRICA'S TALKING AIRTIME CALLBACK & IDEMPOTENCY TESTS PASSED SUCCESSFULLY! ⭐️");
    process.exit(0);
  } catch (err) {
    console.error("❌ Tests failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runCallbackTests();
