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

  const { readingId } = job.data;

  // Delegate verification to triangulationService
  const triResult = await triangulationService.verifyAtmosphericReading(readingId);

  return { success: true, verified: triResult.verified };
}
