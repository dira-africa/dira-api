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
import { env } from "./config/env";
import atmosphericRoutes from "./routes/atmospheric";
import agentsRoutes from "./routes/agents";
import jwt from "@fastify/jwt";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import jobsPlugin from "./plugins/jobs";
import { errorHandler } from "./middleware/errorHandler";

async function runTests() {
  const server = Fastify();

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(jobsPlugin); // Jobs queue registered for verification

  server.setErrorHandler(errorHandler);

  // Register routes
  await server.register(atmosphericRoutes, { prefix: "/api/atmospheric" });
  await server.register(agentsRoutes, { prefix: "/api/agents" });

  await server.ready();

  const testAgentId = "d7d14d24-cb01-4475-8120-d332d7abf404";
  const testPhone = "+254700999999";

  try {
    console.log("Cleaning up previous test data...");
    await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM atmospheric_readings WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM agent_profiles WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM users WHERE id = $1", [testAgentId]);

    console.log("Seeding test Data Agent...");
    await pool.query(
      `INSERT INTO users (id, telegram_id, phone_number, full_name, role, county)
       VALUES ($1, 9999999, pgp_sym_encrypt($2, $3), 'Validation Test Agent', 'agent', 'Nairobi')`,
      [testAgentId, testPhone, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    await pool.query(
      `INSERT INTO agent_profiles (user_id, coverage_center, coverage_radius_km, device_model)
       VALUES ($1, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 5.0, 'Test Ingestion Mobile')`,
      [testAgentId]
    );

    // Generate JWT token
    const token = server.jwt.sign({ id: testAgentId, role: "agent" });

    // --- TEST 3: Pressure out of range (500 hPa) ---
    console.log("\n--- TEST 3: Physical Pressure Validation ---");
    const test3Res = await server.inject({
      method: "POST",
      url: "/api/atmospheric/submit",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pressure_hpa: 500,
        altitude_m: 1600,
        latitude: -1.2921,
        longitude: 36.8219,
        accuracy_m: 5.0,
        sensor_type: "hardware_barometer",
        timestamp: new Date().toISOString()
      }
    });

    console.log(`Status: ${test3Res.statusCode}`);
    console.log(`Body: ${test3Res.body}`);
    const body3 = JSON.parse(test3Res.body);
    if (test3Res.statusCode === 422 && body3.error?.code === "PRESSURE_OUT_OF_RANGE") {
      console.log("✅ Test 3 Passed: Blocked pressure out of range!");
    } else {
      throw new Error("Test 3 Failed: expected 422 PRESSURE_OUT_OF_RANGE");
    }

    // --- TEST 4: Location outside Kenya (London coords) ---
    console.log("\n--- TEST 4: Geographic Location Validation ---");
    const test4Res = await server.inject({
      method: "POST",
      url: "/api/atmospheric/submit",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pressure_hpa: 1010,
        altitude_m: 10,
        latitude: 51.5074,  // London
        longitude: -0.1278, // London
        accuracy_m: 10.0,
        sensor_type: "hardware_barometer",
        timestamp: new Date().toISOString()
      }
    });

    console.log(`Status: ${test4Res.statusCode}`);
    console.log(`Body: ${test4Res.body}`);
    const body4 = JSON.parse(test4Res.body);
    if (test4Res.statusCode === 422 && body4.error?.code === "LOCATION_OUTSIDE_KENYA") {
      console.log("✅ Test 4 Passed: Blocked coordinates outside Kenya!");
    } else {
      throw new Error("Test 4 Failed: expected 422 LOCATION_OUTSIDE_KENYA");
    }

    // --- TEST 5: Daily limit reached ---
    console.log("\n--- TEST 5: Daily Limit Cap Validation ---");
    // Submit 4 valid syncs
    for (let i = 1; i <= 4; i++) {
      const validRes = await server.inject({
        method: "POST",
        url: "/api/atmospheric/submit",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          pressure_hpa: 1000 + i,
          altitude_m: 1500,
          latitude: -1.2921,
          longitude: 36.8219,
          accuracy_m: 5.0,
          sensor_type: "hardware_barometer",
          timestamp: new Date().toISOString()
        }
      });
      console.log(`Submitted sync #${i} status: ${validRes.statusCode}`);
      if (validRes.statusCode !== 200) {
        throw new Error(`Failed to submit valid sync #${i}`);
      }
    }

    // Submit 5th sync
    const test5Res = await server.inject({
      method: "POST",
      url: "/api/atmospheric/submit",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pressure_hpa: 1005,
        altitude_m: 1500,
        latitude: -1.2921,
        longitude: 36.8219,
        accuracy_m: 5.0,
        sensor_type: "hardware_barometer",
        timestamp: new Date().toISOString()
      }
    });

    console.log(`5th Sync Status: ${test5Res.statusCode}`);
    console.log(`5th Sync Body: ${test5Res.body}`);
    const body5 = JSON.parse(test5Res.body);
    if (test5Res.statusCode === 429 && body5.error?.code === "DAILY_LIMIT_REACHED") {
      console.log("✅ Test 5 Passed: Successfully capped submissions at 4!");
    } else {
      throw new Error("Test 5 Failed: expected 429 DAILY_LIMIT_REACHED");
    }

    // --- TEST: Get Sync History & Streak ---
    console.log("\n--- TEST: Retrieve Sync History & Streak ---");
    const historyRes = await server.inject({
      method: "GET",
      url: "/api/agents/sync-history",
      headers: { authorization: `Bearer ${token}` }
    });

    console.log(`History Status: ${historyRes.statusCode}`);
    console.log(`History Body: ${historyRes.body}`);
    const history = JSON.parse(historyRes.body);
    if (history.success && Array.isArray(history.syncsToday) && history.syncsToday.length === 4) {
      console.log("✅ History Test Passed: Returned 4 syncs completed today!");
    } else {
      throw new Error("History Test Failed: expected 4 syncs in todaySyncs list");
    }

    console.log("\n⭐️ ALL INGESTION & VALIDATION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");

  } catch (err: any) {
    console.error("Test execution failed:", err.message);
    process.exit(1);
  } finally {
    // Cleanup seeded user
    await pool.query("DELETE FROM token_ledger WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM atmospheric_readings WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM agent_profiles WHERE user_id = $1", [testAgentId]);
    await pool.query("DELETE FROM users WHERE id = $1", [testAgentId]);
    
    await server.close();
    process.exit(0);
  }
}

runTests();
