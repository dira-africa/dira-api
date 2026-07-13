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

const mockDb = {
  api_clients: [] as any[],
  api_usage_logs: [] as any[],
  audit_log: [] as any[],
  hedera_attestations: [] as any[]
};

import { createHash } from "crypto";

// Seed mock database
const clientWithScopeId = "11111111-2222-3333-4444-555555555555";
const clientWithoutScopeId = "99999999-8888-7777-6666-555555555555";

const validKeyHash = createHash("sha256").update("valid-partner-key-123").digest("hex");
const unscopedKeyHash = createHash("sha256").update("unscoped-key-123").digest("hex");

mockDb.api_clients.push({
  id: clientWithScopeId,
  client_name: "Scoped Insurance Partner",
  client_email: "scoped@insurance.com",
  permissions: ["verify_provenance"],
  rate_limit_per_hour: 100,
  is_active: true,
  key_hash: validKeyHash
});

mockDb.api_clients.push({
  id: clientWithoutScopeId,
  client_name: "Unscoped Agro Partner",
  client_email: "unscoped@agro.com",
  permissions: ["dealer"],
  rate_limit_per_hour: 100,
  is_active: true,
  key_hash: unscopedKeyHash
});

// Seed an attestation
const attestationHash = "d5e786ef789ab3cd89a12e345f67abcd123e456789abcde0123456789abcdef0";
mockDb.hedera_attestations.push({
  id: "22222222-3333-4444-5555-666666666666",
  submission_id: "33333333-4444-5555-6666-777777777777",
  sha256: attestationHash,
  hcs_topic_id: "0.0.987654",
  consensus_timestamp: "1783886848.204061081",
  sequence_number: 42,
  network: "testnet"
});

(pool as any).query = async (text: string, params: any[] = []) => {
  const normalizedText = text.trim().replace(/\s+/g, " ");

  if (normalizedText.includes("SELECT 1")) {
    return { rows: [{ 1: 1 }] };
  }

  // api_clients lookup by key_hash
  if (normalizedText.includes("SELECT id, client_name, permissions, rate_limit_per_hour, is_active FROM api_clients")) {
    const keyHash = params[0];
    const match = mockDb.api_clients.find(c => c.key_hash === keyHash && c.is_active);
    return { rows: match ? [match] : [] };
  }

  // api_usage_logs hourly count
  if (normalizedText.includes("SELECT COUNT(*) AS count FROM api_usage_logs")) {
    const clientId = params[0];
    const matchLogs = mockDb.api_usage_logs.filter(l => l.client_id === clientId);
    return { rows: [{ count: matchLogs.length }] };
  }

  // insert into api_usage_logs
  if (normalizedText.includes("INSERT INTO api_usage_logs")) {
    const [client_id, endpoint, response_code] = params;
    const newLog = { id: "log-uuid", client_id, endpoint, response_code, created_at: new Date() };
    mockDb.api_usage_logs.push(newLog);
    return { rows: [newLog], rowCount: 1 };
  }

  // insert into audit_log
  if (normalizedText.includes("INSERT INTO audit_log")) {
    const [action, entity_type, metadata] = params;
    const newAudit = { id: "audit-uuid", action, entity_type, metadata: JSON.parse(metadata), created_at: new Date() };
    mockDb.audit_log.push(newAudit);
    return { rows: [newAudit], rowCount: 1 };
  }

  // query hedera_attestations by sha256
  if (normalizedText.includes("SELECT consensus_timestamp, sequence_number, hcs_topic_id, network FROM hedera_attestations WHERE sha256 = $1")) {
    const hashVal = params[0];
    const match = mockDb.hedera_attestations.find(a => a.sha256 === hashVal);
    return { rows: match ? [match] : [] };
  }

  // query hedera_attestations by topic and sequence
  if (normalizedText.includes("WHERE hcs_topic_id = $1 AND sequence_number = $2")) {
    const [topicId, seqNum] = params;
    const match = mockDb.hedera_attestations.find(a => a.hcs_topic_id === topicId && a.sequence_number === Number(seqNum));
    return { rows: match ? [match] : [] };
  }

  return { rows: [], rowCount: 0 };
};

(pool as any).connect = async () => {
  return {
    query: async (text: string, params: any[]) => {
      return { rows: [] };
    },
    release: () => {}
  } as any;
};

// 2. Mock Redis and BullMQ
import Redis from "ioredis";
(Redis.prototype as any).connect = () => Promise.resolve();
(Redis.prototype as any).disconnect = () => Promise.resolve();
(Redis.prototype as any).quit = () => Promise.resolve();
(Redis.prototype as any).on = function(event: string, handler: any) {
  if (event === "ready" || event === "connect") {
    setTimeout(handler, 0);
  }
  return this;
};

import { Queue } from "bullmq";
Queue.prototype.getJobCounts = async () => ({ active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0 } as any);

// 3. Import rest of requirements
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import partnerRoutes from "./routes/partner";

async function runB2BVerificationTests() {
  console.log("=== STARTING DIRA B2B HEDERA PROVENANCE VERIFICATION TESTS ===");

  const server = Fastify({
    logger: { level: "warn" }
  });

  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(partnerRoutes);

  await server.ready();

  try {
    // --- Test 1: Hit without API Key (Unauthenticated) ---
    console.log("\n--- Test 1: Hit without API key ---");
    const res1 = await server.inject({
      method: "GET",
      url: "/verify?hash=" + attestationHash
    });
    console.log(`GET /verify (No Key) -> Status ${res1.statusCode}`);
    console.log(`Response:`, res1.payload);
    if (res1.statusCode !== 401) {
      throw new Error("Expected status 401 for missing key");
    }

    // --- Test 2: Hit with invalid API Key (Unauthenticated) ---
    console.log("\n--- Test 2: Hit with invalid API key ---");
    const res2 = await server.inject({
      method: "GET",
      url: "/verify?hash=" + attestationHash,
      headers: { "x-api-key": "invalid-key-xyz" }
    });
    console.log(`GET /verify (Invalid Key) -> Status ${res2.statusCode}`);
    console.log(`Response:`, res2.payload);
    if (res2.statusCode !== 401) {
      throw new Error("Expected status 401 for invalid key");
    }

    // --- Test 3: Hit with unscoped API Key (Forbidden) ---
    console.log("\n--- Test 3: Hit with unscoped API key ---");
    const res3 = await server.inject({
      method: "GET",
      url: "/verify?hash=" + attestationHash,
      headers: { "x-api-key": "unscoped-key-123" }
    });
    console.log(`GET /verify (Unscoped Key) -> Status ${res3.statusCode}`);
    console.log(`Response:`, res3.payload);
    if (res3.statusCode !== 403) {
      throw new Error("Expected status 403 for unscoped key");
    }

    // --- Test 4: Hit with valid Key & Scopes (By Hash) ---
    console.log("\n--- Test 4: Hit with valid key (By Hash) ---");
    const res4 = await server.inject({
      method: "GET",
      url: "/verify?hash=" + attestationHash,
      headers: { "x-api-key": "valid-partner-key-123" }
    });
    console.log(`GET /verify (Valid Scoped Key) -> Status ${res4.statusCode}`);
    console.log(`Response:`, res4.payload);
    if (res4.statusCode !== 200) {
      throw new Error("Expected status 200 for valid verification by hash");
    }
    const body4 = JSON.parse(res4.payload);
    if (!body4.verified || body4.attestation.sequenceNumber !== 42) {
      throw new Error("Verification response data mismatch");
    }
    if (body4.attestation.hashscanLink !== "https://hashscan.io/testnet/topic/0.0.987654") {
      throw new Error("Invalid HashScan link in response");
    }

    // --- Test 5: Hit with valid Key & Scopes (By Topic & Seq) ---
    console.log("\n--- Test 5: Hit with valid key (By Topic & Seq) ---");
    const res5 = await server.inject({
      method: "GET",
      url: "/verify?topic=0.0.987654&seq=42",
      headers: { "x-api-key": "valid-partner-key-123" }
    });
    console.log(`GET /verify (Topic & Seq) -> Status ${res5.statusCode}`);
    console.log(`Response:`, res5.payload);
    if (res5.statusCode !== 200) {
      throw new Error("Expected status 200 for valid verification by topic/seq");
    }

    // --- Test 6: Query for non-existent attestation ---
    console.log("\n--- Test 6: Query for non-existent hash ---");
    const res6 = await server.inject({
      method: "GET",
      url: "/verify?hash=d5e786ef789ab3cd89a12e345f67abcd123e456789abcde0123456789abcdeff",
      headers: { "x-api-key": "valid-partner-key-123" }
    });
    console.log(`GET /verify (Non-existent Hash) -> Status ${res6.statusCode}`);
    console.log(`Response:`, res6.payload);
    if (res6.statusCode !== 404) {
      throw new Error("Expected status 404 for non-existent hash");
    }

    // --- Test 7: Verify Audit Logging ---
    console.log("\n--- Test 7: Check audit & usage logging counts ---");
    console.log("Mock API Usage Logs Count:", mockDb.api_usage_logs.length);
    console.log("Mock Audit Logs Count:", mockDb.audit_log.length);

    // Filter by clientWithScopeId
    const scopedUsage = mockDb.api_usage_logs.filter(l => l.client_id === clientWithScopeId);
    console.log(`Usage Logs for ${clientWithScopeId}:`, scopedUsage);

    if (mockDb.api_usage_logs.length < 3) {
      throw new Error("Expected at least 3 API usage log entries recorded");
    }
    if (mockDb.audit_log.length < 3) {
      throw new Error("Expected at least 3 audit log entries recorded");
    }

    console.log("\n⭐️ ALL B2B HEDERA PROVENANCE VERIFICATION TESTS PASSED SUCCESSFULLY! ⭐️");
    process.exit(0);
  } catch (err) {
    console.error("❌ Tests failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runB2BVerificationTests();
