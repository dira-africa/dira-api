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

import { Job } from "bullmq";
import { query } from "../db/query";
import { pool } from "../db/pool";
import { triangulationService } from "../services/triangulationService";
import { agentSyncService } from "../services/agentSyncService";

async function simulatePassiveAgentSyncs() {
  console.log("Starting simulation of passive agent barometric syncs...");
  const agentsRes = await query(
    `SELECT ap.user_id, ST_X(ap.coverage_center::geometry) AS longitude, ST_Y(ap.coverage_center::geometry) AS latitude
     FROM agent_profiles ap`
  );

  let processedCount = 0;
  for (const agent of agentsRes.rows) {
    const userId = agent.user_id;
    const baseLng = Number(agent.longitude);
    const baseLat = Number(agent.latitude);

    const altitudeM = 1600 + (Math.random() - 0.5) * 50;
    const pressureHpa = 840 + (Math.random() - 0.5) * 10;
    const temperatureC = 18 + (Math.random() - 0.5) * 6;
    const humidityPct = 65 + (Math.random() - 0.5) * 15;
    
    const latitude = baseLat + (Math.random() - 0.5) * 0.01;
    const longitude = baseLng + (Math.random() - 0.5) * 0.01;

    try {
      await agentSyncService.processSyncBatch(userId, [
        {
          pressureHpa,
          altitudeM,
          temperatureC,
          humidityPct,
          latitude,
          longitude,
          recordedAt: new Date().toISOString()
        }
      ]);
      processedCount++;
    } catch (err: any) {
      console.error(`Simulated sync failed for agent ${userId}: ${err.message}`);
    }
  }

  console.log(`Simulated passive syncs processed for ${processedCount} agents.`);
}

export async function processAtmosphericVerification(job: Job) {
  if (job.name === "passive-agent-sync-polling") {
    await simulatePassiveAgentSyncs();
    return { success: true };
  }

  const { readingId, userId, pressureHpa, altitudeM, temperatureC, humidityPct, latitude, longitude, recordedAt } = job.data;

  const recordedAtDate = new Date(recordedAt);
  const dateStr = recordedAtDate.toISOString().split("T")[0];
  const hour = recordedAtDate.getUTCHours();

  // A. Fetch OpenMeteo hourly reference
  const openMeteoPressures = await triangulationService.fetchOpenMeteoReference(latitude, longitude, dateStr);
  const openMeteoRef = openMeteoPressures[hour] || 1013.25;

  // B. Calibrate station pressure reading
  const calibratedSlp = triangulationService.calibrateToSeaLevel(pressureHpa, altitudeM, temperatureC);

  // C. Perform peer triangulation
  const triResult = await triangulationService.triangulateReading(
    userId,
    latitude,
    longitude,
    calibratedSlp,
    recordedAtDate,
    openMeteoRef
  );

  // D. Update atmospheric_readings record
  await query(
    `UPDATE atmospheric_readings
     SET verified = $1,
         anomaly_score = $2,
         openmeteo_reference_hpa = $3,
         network_consensus = $4
     WHERE id = $5`,
    [
      triResult.verified,
      triResult.anomalyScore,
      triResult.openmeteoReferenceHpa,
      triResult.networkConsensus,
      readingId
    ]
  );

  // E. Adjust token status
  if (triResult.verified) {
    // Confirm the pending token
    await query(
      `UPDATE token_ledger
       SET notes = 'confirmed'
       WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync'`,
      [readingId]
    );
  } else {
    // Reverse the pending token: insert a debit of -1 token
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const balanceRes = await client.query(
        "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId]
      );
      const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance_after) : 0;
      const newBalance = Math.max(0, currentBalance - 1);
      
      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
         VALUES ($1, -1, $2, 'adjustment', $3, 'Failed triangulation consensus - reversed')`,
         [userId, newBalance, readingId]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { success: true, verified: triResult.verified };
}
