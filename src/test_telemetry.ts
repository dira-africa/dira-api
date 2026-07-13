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

// Mock Redis and BullMQ to prevent localhost connection attempts in tests
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
Queue.prototype.getJobCounts = async function() {
  return { active: 1, completed: 5, failed: 0, delayed: 0, waiting: 2 } as any;
};

// Mock database pool
import { pool } from "./db/pool";

pool.query = async (text: string, params?: any[]) => {
  const normalizedText = text.trim().replace(/\s+/g, " ");

  if (normalizedText.includes("SELECT 1")) {
    return { rows: [{ 1: 1 }] };
  }

  // Fallbacks for public stats queries
  if (normalizedText.includes("COUNT(DISTINCT user_id)")) {
    return { rows: [{ total_verified: "45" }] };
  }
  if (normalizedText.includes("COUNT(DISTINCT user_id) AS active_users")) {
    return { rows: [{ active_users: "12" }] };
  }
  if (normalizedText.includes("COUNT(DISTINCT county)")) {
    return { rows: [{ counties_covered: "3" }] };
  }
  if (normalizedText.includes("COUNT(*) AS crops_this_month")) {
    return { rows: [{ crops_this_month: "8" }] };
  }
  if (normalizedText.includes("COALESCE(SUM(amount_kes)")) {
    return { rows: [{ total_disbursed_kes: "2500" }] };
  }
  if (normalizedText.includes("SELECT COUNT(*) AS count FROM hedera_attestations")) {
    return { rows: [{ count: "12" }] };
  }
  if (normalizedText.includes("SELECT COALESCE(SUM(amount)")) {
    return { rows: [{ total: "350" }] };
  }
  if (normalizedText.includes("SELECT COUNT(DISTINCT user_id) AS count FROM token_transactions")) {
    return { rows: [{ count: "7" }] };
  }
  if (normalizedText.includes("date_trunc('month'")) {
    return { rows: [{ total: "15" }] };
  }

  // Telemetry fallbacks
  if (normalizedText.includes("crop_submissions GROUP BY verification_status")) {
    return { rows: [
      { verification_status: "verified", count: "35" },
      { verification_status: "rejected", count: "5" }
    ] };
  }
  if (normalizedText.includes("atmospheric_sync")) {
    return { rows: [{ count: "112" }] };
  }
  if (normalizedText.includes("redemption_requests GROUP BY redemption_type, status")) {
    return { rows: [
      { redemption_type: "airtime", status: "completed", count: "21" },
      { redemption_type: "mpesa", status: "failed", count: "2" }
    ] };
  }

  return { rows: [], rowCount: 0 };
};

pool.connect = async () => {
  return {
    query: async (text: string, params: any[]) => {
      return { rows: [] };
    },
    release: () => {}
  } as any;
};

// 2. Import rest of requirements
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import publicRoutes from "./routes/public";
import { metricsService } from "./services/metricsService";

async function runTelemetryTests() {
  console.log("=== STARTING DIRA TELEMETRY & PUBLIC TRACTION TESTS ===");

  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register global metrics hook to count HTTP requests
  server.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url || request.url;
    if (route === "/metrics" || route === "/api/metrics") return;
    const { metricsService } = await import("./services/metricsService");
    metricsService.incrementRequests(request.method, route, reply.statusCode);
  });

  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(publicRoutes);

  await server.ready();

  try {
    // --- Test 1: Hit some endpoints to generate request rate metrics ---
    console.log("\n--- Test 1: Generate request rates ---");
    const testRoutes = ["/public/coverage-map", "/public/hedera-anchors", "/public/stats"];
    for (const r of testRoutes) {
      const res = await server.inject({
        method: "GET",
        url: r
      });
      console.log(`GET ${r} -> Status ${res.statusCode}`);
    }

    // --- Test 2: Query /metrics Prometheus endpoint ---
    console.log("\n--- Test 2: Fetch Prometheus metrics ---");
    const resMetrics = await server.inject({
      method: "GET",
      url: "/metrics"
    });
    console.log(`GET /metrics -> Status ${resMetrics.statusCode}`);
    const metricsText = resMetrics.payload;
    console.log("Exposed Prometheus Metrics (Partial):");
    console.log(metricsText.split("\n").filter(line => !line.startsWith("#") && line.trim() !== "").slice(0, 10).join("\n"));

    // Verify key metrics exist in output
    if (!metricsText.includes("dira_http_requests_total")) {
      throw new Error("Missing metric: dira_http_requests_total");
    }
    if (!metricsText.includes("dira_verifications_total")) {
      throw new Error("Missing metric: dira_verifications_total");
    }
    if (!metricsText.includes("dira_redemptions_total")) {
      throw new Error("Missing metric: dira_redemptions_total");
    }
    if (!metricsText.includes("dira_settlement_float_kes")) {
      throw new Error("Missing metric: dira_settlement_float_kes");
    }
    if (!metricsText.includes("bullmq_job_status_total")) {
      throw new Error("Missing metric: bullmq_job_status_total");
    }

    // --- Test 3: Query /public/stats and verify HashScan links ---
    console.log("\n--- Test 3: Fetch public stats & verify HashScan links ---");
    const resStats = await server.inject({
      method: "GET",
      url: "/public/stats"
    });
    console.log(`GET /public/stats -> Status ${resStats.statusCode}`);
    const bodyStats = JSON.parse(resStats.payload);
    console.log("Stats Response Object:", JSON.stringify(bodyStats, null, 2));

    if (!bodyStats.success || !bodyStats.stats.hedera) {
      throw new Error("Invalid stats response structure");
    }

    const hedera = bodyStats.stats.hedera;
    console.log(`Topic Link: ${hedera.topicLink}`);
    console.log(`Token Link: ${hedera.tokenLink}`);

    const network = env.HEDERA_NETWORK || "testnet";
    if (env.DIRA_HCS_TOPIC_ID && !hedera.topicLink.includes(`hashscan.io/${network}/topic/`)) {
      throw new Error("Invalid HashScan topic link format");
    }
    if (env.DIRA_HTS_TOKEN_ID && !hedera.tokenLink.includes(`hashscan.io/${network}/token/`)) {
      throw new Error("Invalid HashScan token link format");
    }

    console.log("\n⭐️ ALL TELEMETRY & TRACTION DASHBOARD TESTS PASSED SUCCESSFULLY! ⭐️");
    process.exit(0);
  } catch (err) {
    console.error("❌ Tests failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTelemetryTests();
