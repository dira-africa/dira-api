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
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import publicRoutes from "./routes/public";
import { pool } from "./db/pool";
import { redis } from "./db/redis";
import { env } from "./config/env";

async function runTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(publicRoutes);

  await server.ready();

  try {
    console.log("Setting up PostGIS database mocks if needed...");
    let postgisAvailable = true;
    try {
      const checkRes = await pool.query("SELECT 1 FROM pg_proc WHERE proname = 'st_dwithin';");
      if (checkRes.rows.length === 0) {
        postgisAvailable = false;
      }
    } catch (e) {
      postgisAvailable = false;
    }

    if (!postgisAvailable) {
      console.warn("⚠️ PostGIS functions are not available. Setting up PostGIS mock functions for test...");
      await pool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geometry') THEN
            CREATE TYPE geometry AS (dummy text);
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geography') THEN
            CREATE TYPE geography AS (dummy text);
          END IF;
        END
        $$;

        CREATE OR REPLACE FUNCTION ST_Point(x double precision, y double precision) RETURNS geometry AS $$
        BEGIN
          RETURN ROW('POINT(' || x || ' ' || y || ')')::geometry;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_MakePoint(x double precision, y double precision) RETURNS geometry AS $$
        BEGIN
          RETURN ROW('POINT(' || x || ' ' || y || ')')::geometry;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_SetSRID(geom geometry, srid integer) RETURNS geometry AS $$
        BEGIN
          RETURN geom;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }

    console.log("Cleaning up previous test data...");
    await pool.query("DELETE FROM redemption_requests");
    await pool.query("DELETE FROM midnight_anchors");
    await pool.query("DELETE FROM crop_submissions");
    await pool.query("DELETE FROM farms");
    await pool.query("DELETE FROM atmospheric_readings");
    await pool.query("DELETE FROM users WHERE telegram_id IN (888811, 888822)");

    console.log("Seeding test users (Farmer & Agent) and redemptions...");
    const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

    // Seed Farmer
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (888811, 'test_farmer_dash', pgp_sym_encrypt('+254711888811', $1), 'Test Farmer', 'farmer', 'en', 'Nakuru')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    // Seed Farm
    const farmRes = await pool.query(
      `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
       VALUES ($1, ST_SetSRID(ST_MakePoint(36.08, -0.30), 4326), 5.5, ARRAY['Maize'], 'Nakuru', 'Njoro')
       RETURNING id`,
      [farmerId]
    );
    const farmId = farmRes.rows[0].id;

    // Seed verified crop submission
    await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, photo_url, crop_type, growth_stage, verification_status, location, ai_health_score, ai_confidence)
       VALUES ($1, $2, 'https://test-photo.jpg', 'Maize', 'Vegetative', 'verified', ST_SetSRID(ST_MakePoint(36.08, -0.30), 4326), 0.95, 0.99)`,
      [farmerId, farmId]
    );

    // Seed Agent
    const agentRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (888822, 'test_agent_dash', pgp_sym_encrypt('+254722888822', $1), 'Test Agent', 'agent', 'en', 'Meru')
       RETURNING id`,
      [encryptionKey]
    );
    const agentId = agentRes.rows[0].id;

    // Seed verified atmospheric readings for last 30 days
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      const recordedAt = new Date(now.getTime() - i * 24 * 60 * 60 * 1000); // 1 per day
      await pool.query(
        `INSERT INTO atmospheric_readings (user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified, anomaly_score, network_consensus)
         VALUES ($1, ST_SetSRID(ST_MakePoint(37.5, 0.05), 4326), 1013.25, 100, 22.0, 50.0, $2, TRUE, 0.005, TRUE)`,
        [agentId, recordedAt]
      );
    }

    // Seed redemptions across all 4 layers
    await pool.query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
       VALUES ($1, 40, 'airtime', 22.00, pgp_sym_encrypt('+254711888811', $2), 'completed', CURRENT_TIMESTAMP)`,
      [farmerId, encryptionKey]
    );
    await pool.query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
       VALUES ($1, 100, 'voucher', 55.00, pgp_sym_encrypt('+254711888811', $2), 'completed', CURRENT_TIMESTAMP)`,
      [farmerId, encryptionKey]
    );
    await pool.query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
       VALUES ($1, 100, 'circle', 50.00, pgp_sym_encrypt('+254711888811', $2), 'completed', CURRENT_TIMESTAMP)`,
      [farmerId, encryptionKey]
    );
    await pool.query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
       VALUES ($1, 100, 'mpesa', 50.00, pgp_sym_encrypt('+254711888811', $2), 'completed', CURRENT_TIMESTAMP)`,
      [farmerId, encryptionKey]
    );

    // Seed Midnight anchors
    await pool.query(
      `INSERT INTO midnight_anchors (week_number, batch_hash, data_point_count, midnight_tx_hash, anchored_at)
       VALUES (202622, 'b67549b28ee4f25b417c237a2a67d98cce6316cba2ead4ee15391dce704ff714', 5, '0xanchor_tx_b98de253310ea19517c336eda6dd40d0', CURRENT_TIMESTAMP)`
    );

    // Clear any existing redis public keys for test consistency
    if (redis.status === "ready") {
      await redis.del("dira:public:stats");
      await redis.del("dira:public:coverage-map");
      await redis.del("dira:public:circular-economy-summary");
      await redis.del("dira:public:activity-feed");
      await redis.del("dira:public:quality-metrics");
      await redis.del("dira:public:midnight-anchors");
    }

    console.log("\n--- TEST 1: GET /public/stats ---");
    const statsRes = await server.inject({ method: "GET", url: "/public/stats" });
    console.log("Stats Status:", statsRes.statusCode);
    const statsBody = JSON.parse(statsRes.payload);
    console.log("Stats Response:", statsBody);
    if (statsRes.statusCode !== 200 || !statsBody.success || !statsBody.stats) {
      throw new Error("Stats endpoint failed.");
    }
    const { totalVerifiedDataPoints, activeUsers7Days, countiesCovered, cropSubmissionsMonth, tokensDisbursedKes } = statsBody.stats;
    if (totalVerifiedDataPoints !== 6) { // 1 crop + 5 weather readings
      throw new Error(`Expected 6 verified data points, got ${totalVerifiedDataPoints}`);
    }
    if (activeUsers7Days !== 2) { // farmer + agent
      throw new Error(`Expected 2 active users, got ${activeUsers7Days}`);
    }
    if (countiesCovered < 2) { // Nakuru + Meru
      throw new Error(`Expected at least 2 counties covered, got ${countiesCovered}`);
    }
    if (cropSubmissionsMonth !== 1) {
      throw new Error(`Expected 1 crop submission this month, got ${cropSubmissionsMonth}`);
    }
    if (tokensDisbursedKes !== 177.0) { // 22 + 55 + 50 + 50
      throw new Error(`Expected 177 KES disbursed, got ${tokensDisbursedKes}`);
    }
    console.log("✅ Test 1 passed!");

    console.log("\n--- TEST 2: GET /public/coverage-map ---");
    const mapRes = await server.inject({ method: "GET", url: "/public/coverage-map" });
    console.log("Map Status:", mapRes.statusCode);
    const mapBody = JSON.parse(mapRes.payload);
    console.log("Map Response:", { activeCounties: mapBody.activeCounties, gridCount: mapBody.grids?.length });
    if (mapRes.statusCode !== 200 || !mapBody.success) {
      throw new Error("Coverage map endpoint failed.");
    }
    if (!mapBody.activeCounties.includes("Nakuru") || !mapBody.activeCounties.includes("Meru")) {
      throw new Error("Active counties does not contain seeded counties.");
    }
    if (mapBody.grids.length === 0) {
      throw new Error("Expected some grid data coordinate points.");
    }
    console.log("✅ Test 2 passed!");

    console.log("\n--- TEST 3: GET /public/circular-economy-summary ---");
    const circularRes = await server.inject({ method: "GET", url: "/public/circular-economy-summary" });
    console.log("Circular Status:", circularRes.statusCode);
    const circularBody = JSON.parse(circularRes.payload);
    console.log("Circular Response:", circularBody.summary);
    if (circularRes.statusCode !== 200 || !circularBody.success || !circularBody.summary) {
      throw new Error("Circular economy summary endpoint failed.");
    }
    const { airtime30Days, vouchersAllTime, circleAllTime, mpesaAllTime } = circularBody.summary;
    if (airtime30Days !== 22.0 || vouchersAllTime !== 55.0 || circleAllTime !== 50.0 || mpesaAllTime !== 50.0) {
      throw new Error("Circular economy summary returns mismatch values.");
    }
    console.log("✅ Test 3 passed!");

    console.log("\n--- TEST 4: GET /public/activity-feed ---");
    const feedRes = await server.inject({ method: "GET", url: "/public/activity-feed" });
    console.log("Feed Status:", feedRes.statusCode);
    const feedBody = JSON.parse(feedRes.payload);
    console.log("Feed Response (top 2):", feedBody.activities.slice(0, 2));
    if (feedRes.statusCode !== 200 || !feedBody.success || feedBody.activities.length === 0) {
      throw new Error("Activity feed endpoint failed.");
    }
    const topActivity = feedBody.activities[0];
    if (!topActivity.role || !topActivity.county || !topActivity.timestamp) {
      throw new Error("Activity record is missing core parameters.");
    }
    console.log("✅ Test 4 passed!");

    console.log("\n--- TEST 5: GET /public/quality-metrics ---");
    const qualityRes = await server.inject({ method: "GET", url: "/public/quality-metrics" });
    console.log("Quality Status:", qualityRes.statusCode);
    const qualityBody = JSON.parse(qualityRes.payload);
    console.log("Quality Response:", qualityBody.metrics);
    if (qualityRes.statusCode !== 200 || !qualityBody.success || qualityBody.metrics.length === 0) {
      throw new Error("Quality metrics endpoint failed.");
    }
    const dayMetric = qualityBody.metrics[0];
    if (dayMetric.pctHigh === undefined || dayMetric.pctMedium === undefined || dayMetric.pctLow === undefined || dayMetric.networkConsensusRate === undefined) {
      throw new Error("Quality metrics object is missing core fields.");
    }
    console.log("✅ Test 5 passed!");

    console.log("\n--- TEST 6: GET /public/midnight-anchors ---");
    const anchorRes = await server.inject({ method: "GET", url: "/public/midnight-anchors" });
    console.log("Anchors Status:", anchorRes.statusCode);
    const anchorBody = JSON.parse(anchorRes.payload);
    console.log("Anchors Response:", anchorBody.anchors);
    if (anchorRes.statusCode !== 200 || !anchorBody.success || anchorBody.anchors.length === 0) {
      throw new Error("Midnight anchors endpoint failed.");
    }
    const anchor = anchorBody.anchors[0];
    if (anchor.weekNumber !== 202622 || anchor.batchHash !== 'b67549b28ee4f25b417c237a2a67d98cce6316cba2ead4ee15391dce704ff714' || !anchor.midnightTxHash) {
      throw new Error("Midnight anchor details mismatch.");
    }
    console.log("✅ Test 6 passed!");

    console.log("\n--- TEST 7: Redis Caching Verification ---");
    if (redis.status === "ready") {
      // Modify database values directly
      await pool.query("UPDATE redemption_requests SET amount_kes = 100.00 WHERE redemption_type = 'airtime'");

      // Fetch circular summary again - should still return cached amount (22.0)
      const cachedCircularRes = await server.inject({ method: "GET", url: "/public/circular-economy-summary" });
      const cachedCircularBody = JSON.parse(cachedCircularRes.payload);
      console.log("Cached Airtime Amount:", cachedCircularBody.summary.airtime30Days);
      if (cachedCircularBody.summary.airtime30Days !== 22.0) {
        throw new Error("Expected circular economy summary response to be cached (22.0 KES).");
      }

      // Clear cache and fetch again - should now return updated amount (100.0)
      await redis.del("dira:public:circular-economy-summary");
      const freshCircularRes = await server.inject({ method: "GET", url: "/public/circular-economy-summary" });
      const freshCircularBody = JSON.parse(freshCircularRes.payload);
      console.log("Fresh Airtime Amount:", freshCircularBody.summary.airtime30Days);
      if (freshCircularBody.summary.airtime30Days !== 100.0) {
        throw new Error("Expected fresh circular economy summary response to be updated (100.0 KES).");
      }
      console.log("✅ Test 7 passed!");
    } else {
      console.log("⚠️ Redis not connected. Skipping Caching tests.");
    }

    console.log("\n⭐️ ALL PUBLIC REAL-TIME DASHBOARD INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Public dashboard test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
    try {
      await redis.quit();
    } catch (e) {
      // Ignore redis quit failure
    }
    process.exit(0);
  }
}

runTests();
