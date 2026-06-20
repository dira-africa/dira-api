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
import fp from "fastify-plugin";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import jobsPlugin from "./plugins/jobs";
import adminRoutes from "./routes/admin";
import { pool } from "./db/pool";
import { xionService } from "./services/xionService";
import { redis } from "./db/redis";

async function runTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });

  // Register separate admin JWT namespace
  await server.register(fp(async (instance) => {
    await instance.register(jwt, {
      secret: process.env.ADMIN_JWT_SECRET || (env.JWT_SECRET + "_admin_hardened"),
      namespace: "admin",
    });
  }));

  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(jobsPlugin);

  // Register routes
  await server.register(adminRoutes, { prefix: "/api/admin" });

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
    await pool.query("DELETE FROM zkverify_certificates");
    await pool.query("DELETE FROM zkverify_anchors");
    await pool.query("DELETE FROM atmospheric_readings");
    await pool.query("DELETE FROM users WHERE telegram_id IN (99887766, 99887767)");

    console.log("Seeding test users (Admin and Agent)...");
    const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

    const adminRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (99887766, 'test_admin_user', pgp_sym_encrypt('+254711999999', $1), 'Admin User', 'admin', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const adminId = adminRes.rows[0].id;

    const agentRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (99887767, 'test_agent_user', pgp_sym_encrypt('+254722999999', $1), 'Agent User', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const agentId = agentRes.rows[0].id;

    // Generate JWT token for admin
    const adminToken = server.jwt.admin.sign({ id: adminId, role: "admin" });
    await redis.set(`dira:admin:session:${adminId}`, "active", "EX", 7200);

    // --- TEST 1: Merkle Root Calculation ---
    console.log("\n--- TEST 1: Merkle Root Calculation ---");
    const emptyRoot = xionService.computeMerkleRoot([]);
    console.log("Empty root:", emptyRoot);
    if (!emptyRoot || emptyRoot.length !== 64) {
      throw new Error("Empty Merkle Root calculation failed.");
    }

    const testIds = [
      "d78a9c3b-74b8-4c8d-8a29-792fdf10950a",
      "e38bf349-2e3b-48cd-8a24-91e8df10950b",
      "f48cf350-2e3c-48ce-8a25-92e8df10950c"
    ];
    const merkleRoot = xionService.computeMerkleRoot(testIds);
    console.log("3-item Merkle root:", merkleRoot);
    if (!merkleRoot || merkleRoot.length !== 64) {
      throw new Error("Standard Merkle Root calculation failed.");
    }
    console.log("✅ Test 1 passed!");

    // --- TEST 2: Weekly Anchor (Direct Service Call) ---
    console.log("\n--- TEST 2: Weekly Anchor (Direct Service Call) ---");
    const week20Range = xionService.getISOWeekRange(2026, 20);
    const midWeek20 = new Date(week20Range.start.getTime() + 2 * 24 * 60 * 60 * 1000); // Wednesday of Week 20

    await pool.query(
      `INSERT INTO atmospheric_readings (
         user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct,
         recorded_at, verified, anomaly_score, openmeteo_reference_hpa, network_consensus
       ) VALUES ($1, ST_SetSRID(ST_MakePoint(36.8, -1.2), 4326), 1013.25, 0, 15, 60, $2, TRUE, 0.0, 1013.25, TRUE)`,
      [agentId, midWeek20]
    );

    const anchorRes = await xionService.anchorWeeklyBatch(202620);
    console.log("Anchor result:", anchorRes);
    if (!anchorRes.anchored || anchorRes.dataPointCount !== 1) {
      throw new Error("Weekly batch anchoring failed.");
    }

    const dbAnchorRes = await pool.query(
      "SELECT * FROM zkverify_anchors WHERE week_number = 202620"
    );
    if (dbAnchorRes.rows.length === 0) {
      throw new Error("Weekly anchor not saved in database.");
    }
    console.log("Database Anchor Record:", dbAnchorRes.rows[0]);
    console.log("✅ Test 2 passed!");

    // --- TEST 3: Completed Weeks Catch-up Anchoring ---
    console.log("\n--- TEST 3: Completed Weeks Catch-up Anchoring ---");
    const week21Range = xionService.getISOWeekRange(2026, 21);
    const midWeek21 = new Date(week21Range.start.getTime() + 2 * 24 * 60 * 60 * 1000); // Wednesday of Week 21

    await pool.query(
      `INSERT INTO atmospheric_readings (
         user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct,
         recorded_at, verified, anomaly_score, openmeteo_reference_hpa, network_consensus
       ) VALUES ($1, ST_SetSRID(ST_MakePoint(36.8, -1.2), 4326), 1013.25, 0, 15, 60, $2, TRUE, 0.0, 1013.25, TRUE)`,
      [agentId, midWeek21]
    );

    // Running catchup
    const catchupRes = await xionService.anchorAllCompletedWeeks();
    console.log("Catchup result:", catchupRes);
    if (!catchupRes.success || catchupRes.anchoredWeeksCount !== 1) {
      throw new Error("Historical completed weeks catchup anchoring failed.");
    }

    const dbAnchorCheck21 = await pool.query(
      "SELECT * FROM zkverify_anchors WHERE week_number = 202621"
    );
    if (dbAnchorCheck21.rows.length === 0) {
      throw new Error("Weekly catch-up anchor for week 202621 was not saved.");
    }
    console.log("✅ Test 3 passed!");

    // --- TEST 4: Certificate Generation ---
    console.log("\n--- TEST 4: Certificate Generation ---");
    const startDate = new Date("2026-05-10");
    const endDate = new Date("2026-05-17");
    const certRes = await xionService.issueCertificate("NBI", startDate, endDate, "High Quality Ingestion", 0.98);
    console.log("Certificate result:", certRes);

    const dbCertRes = await pool.query(
      "SELECT * FROM zkverify_certificates WHERE cert_id = $1",
      [certRes.certId]
    );
    if (dbCertRes.rows.length === 0) {
      throw new Error("Certificate not saved in database.");
    }
    console.log("Database Certificate Record:", dbCertRes.rows[0]);
    console.log("✅ Test 4 passed!");

    // --- TEST 5: Admin HTTP Endpoints ---
    console.log("\n--- TEST 5: Admin HTTP Endpoints ---");
    
    // Test 5A: GET /api/admin/xion-zkverify/status
    const statusRes = await server.inject({
      method: "GET",
      url: "/api/admin/xion-zkverify/status",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`GET status response: ${statusRes.statusCode}`);
    const statusBody = JSON.parse(statusRes.payload);
    if (statusRes.statusCode !== 200 || !statusBody.success) {
      throw new Error("GET /api/admin/xion-zkverify/status failed.");
    }
    console.log("Anchors in status:", statusBody.anchors.length);
    console.log("Certificates in status:", statusBody.certificates.length);

    // Test 5B: POST /api/admin/xion-zkverify/anchor
    const postAnchorRes = await server.inject({
      method: "POST",
      url: "/api/admin/xion-zkverify/anchor",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log(`POST anchor response: ${postAnchorRes.statusCode}`);
    const postAnchorBody = JSON.parse(postAnchorRes.payload);
    if (postAnchorRes.statusCode !== 200 || !postAnchorBody.success) {
      throw new Error("POST /api/admin/xion-zkverify/anchor failed.");
    }

    // Test 5C: POST /api/admin/xion-zkverify/certificate
    const postCertRes = await server.inject({
      method: "POST",
      url: "/api/admin/xion-zkverify/certificate",
      headers: { Authorization: `Bearer ${adminToken}` },
      payload: {
        countyCode: "KUM",
        periodStart: "2026-05-18",
        periodEnd: "2026-05-25",
        conditionType: "Rainfall Index Peak",
        confidenceThreshold: 0.925
      }
    });
    console.log(`POST certificate response: ${postCertRes.statusCode}`);
    const postCertBody = JSON.parse(postCertRes.payload);
    if (postCertRes.statusCode !== 200 || !postCertBody.success) {
      throw new Error("POST /api/admin/xion-zkverify/certificate failed.");
    }
    console.log("✅ Test 5 passed!");

    // --- TEST 6: BullMQ Repeatable Jobs Registration ---
    console.log("\n--- TEST 6: BullMQ Repeatable Jobs Registration ---");
    if (!server.jobsQueue) {
      throw new Error("BullMQ Queue is not decorated on the Fastify instance.");
    }

    const repeatableJobs = await server.xionAnchorQueue.getRepeatableJobs();
    console.log("Registered repeatable jobs count on xionAnchorQueue:", repeatableJobs.length);
    for (const rJob of repeatableJobs) {
      console.log(`- Job: ${rJob.name}, Pattern: ${rJob.pattern}, Key: ${rJob.key}`);
    }

    const anchoringJobExists = repeatableJobs.some(j => j.name === "xion-weekly-anchoring");
    if (!anchoringJobExists) {
      throw new Error("Repeatable anchoring job is not correctly registered in BullMQ Queue.");
    }
    console.log("✅ Test 6 passed!");

    console.log("\n⭐️ ALL XION & BULLMQ INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ XION & BullMQ test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
    await redis.quit();
  }
}

runTests();
