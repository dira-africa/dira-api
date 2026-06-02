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
import agentsRoutes from "./routes/agents";
import tokensRoutes from "./routes/tokens";
import jwt from "@fastify/jwt";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import { errorHandler } from "./middleware/errorHandler";
import { triangulationService } from "./services/triangulationService";

async function runTests() {
  const server = Fastify();

  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);

  server.setErrorHandler(errorHandler);

  // Register routes
  await server.register(agentsRoutes, { prefix: "/api/agents" });
  await server.register(tokensRoutes, { prefix: "/api/tokens" });

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
      console.warn("⚠️ PostGIS functions are not available. Setting up PostGIS mock functions for test_triangulation...");
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

        CREATE OR REPLACE FUNCTION ST_X(geom geometry) RETURNS double precision AS $$
        BEGIN
          RETURN split_part(replace(replace(geom.dummy, 'POINT(', ''), ')', ''), ' ', 1)::double precision;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_Y(geom geometry) RETURNS double precision AS $$
        BEGIN
          RETURN split_part(replace(replace(geom.dummy, 'POINT(', ''), ')', ''), ' ', 2)::double precision;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION geometry_to_geography(geom geometry) RETURNS geography AS $$
        BEGIN
          RETURN ROW(geom.dummy)::geography;
        END;
        $$ LANGUAGE plpgsql;

        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_cast 
            WHERE castsource = 'geometry'::regtype 
              AND casttarget = 'geography'::regtype
          ) THEN
            CREATE CAST (geometry AS geography) WITH FUNCTION geometry_to_geography(geometry) AS IMPLICIT;
          END IF;
        END
        $$;

        CREATE OR REPLACE FUNCTION ST_Distance(g1 geography, g2 geography) RETURNS double precision AS $$
        DECLARE
          p1 text;
          p2 text;
          x1 double precision;
          y1 double precision;
          x2 double precision;
          y2 double precision;
          dist double precision;
        BEGIN
          p1 := (g1).dummy;
          p2 := (g2).dummy;
          
          x1 := split_part(replace(replace(p1, 'POINT(', ''), ')', ''), ' ', 1)::double precision;
          y1 := split_part(replace(replace(p1, 'POINT(', ''), ')', ''), ' ', 2)::double precision;
          
          x2 := split_part(replace(replace(p2, 'POINT(', ''), ')', ''), ' ', 1)::double precision;
          y2 := split_part(replace(replace(p2, 'POINT(', ''), ')', ''), ' ', 2)::double precision;
          
          dist := sqrt(power(x1 - x2, 2) + power(y1 - y2, 2)) * 111000;
          RETURN dist;
        END;
        $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION ST_DWithin(g1 geography, g2 geography, dist double precision) RETURNS boolean AS $$
        BEGIN
          RETURN ST_Distance(g1, g2) <= dist;
        END;
        $$ LANGUAGE plpgsql;
      `);
    }

    console.log("Cleaning up previous test agent data...");
    // Retrieve test users list
    const testIdsRes = await pool.query(
      "SELECT id FROM users WHERE telegram_id IN (88776655, 88776656, 88776657, 88776658)"
    );
    const testIds = testIdsRes.rows.map(r => r.id);

    if (testIds.length > 0) {
      await pool.query("DELETE FROM atmospheric_readings WHERE user_id = ANY($1)", [testIds]);
      await pool.query("DELETE FROM token_ledger WHERE user_id = ANY($1)", [testIds]);
      await pool.query("DELETE FROM agent_profiles WHERE user_id = ANY($1)", [testIds]);
      await pool.query("DELETE FROM users WHERE id = ANY($1)", [testIds]);
    }

    console.log("Seeding test Data Agent and peers...");
    const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;
    
    // Seed primary agent
    const agentRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (88776655, 'test_data_agent', pgp_sym_encrypt('+254711111111', $1), 'Primary Agent', 'agent', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const agentId = agentRes.rows[0].id;

    await pool.query(
      `INSERT INTO agent_profiles (user_id, coverage_center, coverage_radius_km, device_model)
       VALUES ($1, ST_SetSRID(ST_MakePoint(36.8219, -1.2921), 4326), 5.0, 'Safaricom Neon')`,
      [agentId]
    );

    // Fetch real or simulated Open-Meteo sea level pressure for target coordinate and hour
    const todayStr = new Date().toISOString().split("T")[0];
    const currentHour = new Date().getUTCHours();
    const openMeteoPressures = await triangulationService.fetchOpenMeteoReference(-1.2921, 36.8219, todayStr);
    const openMeteoRef = openMeteoPressures[currentHour] || 1013.25;

    // Calculate station pressure corresponding to exactly the Open-Meteo reference pressure
    const altitude = 1795.0;
    const peerStationPressure = Number((openMeteoRef - (altitude / 100 * 12)).toFixed(2));

    // Seed 3 peer agents to enable spatial triangulation consensus
    const peerIds: string[] = [];
    const peerData = [
      { id: 88776656, name: "Peer Agent 1", offsetLon: 0.01, offsetLat: 0.01 }, // ~1.5km away
      { id: 88776657, name: "Peer Agent 2", offsetLon: -0.01, offsetLat: 0.02 }, // ~2.5km away
      { id: 88776658, name: "Peer Agent 3", offsetLon: 0.02, offsetLat: -0.01 }  // ~2.5km away
    ];

    for (const peer of peerData) {
      const pRes = await pool.query(
        `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
         VALUES ($1, $2, pgp_sym_encrypt('+254722222222', $3), $4, 'agent', 'en', 'Nairobi')
         RETURNING id`,
        [peer.id, `peer_${peer.id}`, encryptionKey, peer.name]
      );
      const pId = pRes.rows[0].id;
      peerIds.push(pId);

      const lon = 36.8219 + peer.offsetLon;
      const lat = -1.2921 + peer.offsetLat;

      await pool.query(
        `INSERT INTO agent_profiles (user_id, coverage_center, coverage_radius_km, device_model)
         VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), 5.0, 'Infinix Smart 8')`,
        [pId, lon, lat]
      );

      // Insert active verified barometric readings for peers (calibrates to sea level ~openMeteoRef)
      await pool.query(
        `INSERT INTO atmospheric_readings (
          user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct,
          recorded_at, verified, anomaly_score, openmeteo_reference_hpa, network_consensus
        ) VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, 1795.0, 20.0, 60.0, CURRENT_TIMESTAMP, TRUE, 0.0, $5, FALSE)`,
        [pId, lon, lat, peerStationPressure, openMeteoRef]
      );
    }

    // Generate JWT token for primary agent
    const token = server.jwt.sign({ id: agentId, role: "agent" });

    // --- TEST 1: Retrieve Agent Profile ---
    console.log("\n--- TEST 1: Retrieve Agent Profile ---");
    const resProfile = await server.inject({
      method: "GET",
      url: "/api/agents/profile",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Response status: ${resProfile.statusCode}`);
    const bodyProfile = JSON.parse(resProfile.payload);
    console.log("Response body:", bodyProfile);

    if (resProfile.statusCode !== 200 || !bodyProfile.success) {
      throw new Error(`Profile query failed. Status: ${resProfile.statusCode}`);
    }
    if (bodyProfile.profile.full_name !== "Primary Agent") {
      throw new Error("Incorrect profile information returned.");
    }
    console.log("✅ Test 1 passed!");

    // --- TEST 2: Retrieve Initial Sync Stats ---
    console.log("\n--- TEST 2: Retrieve Initial Sync Stats ---");
    const resStats = await server.inject({
      method: "GET",
      url: "/api/agents/sync-stats",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Response status: ${resStats.statusCode}`);
    const bodyStats = JSON.parse(resStats.payload);
    console.log("Response body:", bodyStats);

    if (resStats.statusCode !== 200 || !bodyStats.success) {
      throw new Error(`Stats query failed. Status: ${resStats.statusCode}`);
    }
    if (bodyStats.syncsToday !== 0 || bodyStats.totalReadingsSynced !== 0) {
      throw new Error("Stats should indicate zero initially.");
    }
    console.log("✅ Test 2 passed!");

    // --- TEST 3: Submit Reading with Spatial Peer Consensus ---
    console.log("\n--- TEST 3: Submit verified reading (Network Consensus) ---");
    // Calculate station pressure that calibrates to openMeteoRef + 0.5 hPa (within 3.0 hPa of peer average)
    const validStationPressure = Number((openMeteoRef - (altitude / 100 * 12) + 0.5).toFixed(2));
    
    const resSync1 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        readings: [
          {
            pressureHpa: validStationPressure,
            altitudeM: 1795.0,
            temperatureC: 20.0,
            humidityPct: 60.0,
            latitude: -1.2921,
            longitude: 36.8219,
            recordedAt: new Date().toISOString()
          }
        ]
      }
    });

    console.log(`Response status: ${resSync1.statusCode}`);
    const bodySync1 = JSON.parse(resSync1.payload);
    console.log("Response body:", bodySync1);

    if (resSync1.statusCode !== 200 || bodySync1.verifiedCount !== 1 || bodySync1.tokensAwarded !== 1) {
      throw new Error(`Consensus sync failed. Status: ${resSync1.statusCode}, body: ${JSON.stringify(bodySync1)}`);
    }
    console.log("✅ Test 3 passed!");

    // --- TEST 4: Submit Anomaly Reading (Fails Peer Consensus) ---
    console.log("\n--- TEST 4: Submit anomaly reading (Fails Peer Consensus) ---");
    // Calculate station pressure that calibrates to openMeteoRef + 60.0 hPa (exceeds peer average by 60.0 hPa)
    const anomalyStationPressure = Number((openMeteoRef - (altitude / 100 * 12) + 60.0).toFixed(2));
    
    const resSync2 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        readings: [
          {
            pressureHpa: anomalyStationPressure,
            altitudeM: 1795.0,
            temperatureC: 20.0,
            humidityPct: 60.0,
            latitude: -1.2921,
            longitude: 36.8219,
            recordedAt: new Date().toISOString()
          }
        ]
      }
    });

    console.log(`Response status: ${resSync2.statusCode}`);
    const bodySync2 = JSON.parse(resSync2.payload);
    console.log("Response body:", bodySync2);

    if (resSync2.statusCode !== 200 || bodySync2.verifiedCount !== 0 || bodySync2.tokensAwarded !== 0) {
      throw new Error(`Expected anomaly rejection. Status: ${resSync2.statusCode}, body: ${JSON.stringify(bodySync2)}`);
    }

    // Verify it is flagged in DB
    const dbReadingRes = await pool.query(
      "SELECT verified, network_consensus, anomaly_score FROM atmospheric_readings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [agentId]
    );
    const dbReading = dbReadingRes.rows[0];
    console.log("Anomaly DB record:", dbReading);
    if (dbReading.verified !== false || dbReading.network_consensus !== false || Number(dbReading.anomaly_score) <= 0.05) {
      throw new Error("Anomaly DB values are incorrect.");
    }
    console.log("✅ Test 4 passed!");

    // --- TEST 5: Fallback Meteorological Reference (No Peers Nearby) ---
    console.log("\n--- TEST 5: Open-Meteo fallback (No peers) ---");
    // Clean up peer readings from DB to simulate low density
    await pool.query("DELETE FROM atmospheric_readings WHERE user_id = ANY($1)", [peerIds]);

    // Submit reading that calibrates to exactly openMeteoRef
    const fallbackStationPressure = Number((openMeteoRef - (altitude / 100 * 12)).toFixed(2));
    
    const resSync3 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        readings: [
          {
            pressureHpa: fallbackStationPressure,
            altitudeM: 1795.0,
            temperatureC: 20.0,
            humidityPct: 60.0,
            latitude: -1.2921,
            longitude: 36.8219,
            recordedAt: new Date().toISOString()
          }
        ]
      }
    });

    console.log(`Response status: ${resSync3.statusCode}`);
    const bodySync3 = JSON.parse(resSync3.payload);
    console.log("Response body:", bodySync3);

    if (resSync3.statusCode !== 200 || bodySync3.verifiedCount !== 1) {
      throw new Error(`Open-Meteo fallback verification failed. Status: ${resSync3.statusCode}`);
    }
    console.log("✅ Test 5 passed!");

    // --- TEST 6: Capping Daily Sync Rewards at 4 ---
    console.log("\n--- TEST 6: Verify daily reward capping limits ---");
    const cappingStationPressure = Number((openMeteoRef - (altitude / 100 * 12)).toFixed(2));
    
    // Sync run #3
    console.log("Sending successful sync #3...");
    const resSyncRun3 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: { readings: [{ pressureHpa: cappingStationPressure, altitudeM: 1795.0, temperatureC: 20.0, humidityPct: 60.0, latitude: -1.2921, longitude: 36.8219, recordedAt: new Date().toISOString() }] }
    });
    console.log(`  Sync #3 status: ${resSyncRun3.statusCode}, tokens: ${JSON.parse(resSyncRun3.payload).tokensAwarded}`);

    // Sync run #4
    console.log("Sending successful sync #4...");
    const resSyncRun4 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: { readings: [{ pressureHpa: cappingStationPressure, altitudeM: 1795.0, temperatureC: 20.0, humidityPct: 60.0, latitude: -1.2921, longitude: 36.8219, recordedAt: new Date().toISOString() }] }
    });
    console.log(`  Sync #4 status: ${resSyncRun4.statusCode}, tokens: ${JSON.parse(resSyncRun4.payload).tokensAwarded}`);

    // Sync run #5
    console.log("Sending successful sync #5...");
    const resSyncRun5 = await server.inject({
      method: "POST",
      url: "/api/agents/barometric-sync",
      headers: { Authorization: `Bearer ${token}` },
      payload: { readings: [{ pressureHpa: cappingStationPressure, altitudeM: 1795.0, temperatureC: 20.0, humidityPct: 60.0, latitude: -1.2921, longitude: 36.8219, recordedAt: new Date().toISOString() }] }
    });
    const bodySyncRun5 = JSON.parse(resSyncRun5.payload);
    console.log(`  Sync #5 status: ${resSyncRun5.statusCode}, tokens: ${bodySyncRun5.tokensAwarded}`);

    if (bodySyncRun5.tokensAwarded !== 0) {
      throw new Error(`Reward was awarded on the 5th sync, capping failed! Got tokens: ${bodySyncRun5.tokensAwarded}`);
    }
    console.log("✅ Test 6 passed!");

    // --- TEST 7: Tokens Balance and History ---
    console.log("\n--- TEST 7: Retrieve token balance and history ---");
    const resBal = await server.inject({
      method: "GET",
      url: "/api/tokens/balance",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`Balance status: ${resBal.statusCode}`);
    const bodyBal = JSON.parse(resBal.payload);
    console.log("Balance body:", bodyBal);

    if (resBal.statusCode !== 200 || bodyBal.balance !== 4) {
      throw new Error(`Expected balance to be exactly 4 DIRA (4 syncs * 1 DIRA). Got: ${bodyBal.balance}`);
    }

    const resHist = await server.inject({
      method: "GET",
      url: "/api/tokens/history",
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log(`History status: ${resHist.statusCode}`);
    const bodyHist = JSON.parse(resHist.payload);
    console.log("History transaction count:", bodyHist.transactions.length);
    
    if (resHist.statusCode !== 200 || bodyHist.transactions.length !== 8) {
      throw new Error(`Expected exactly 8 ledger entries. Got: ${bodyHist.transactions.length}`);
    }
    console.log("✅ Test 7 passed!");

    console.log("\n⭐️ ALL BAROMETRIC SYNC & TRIANGULATION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Barometric sync test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
