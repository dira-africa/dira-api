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

import { query } from "../db/query";
import { triangulationService } from "./triangulationService";
import { tokenService } from "./tokenService";

export interface BarometricDataPoint {
  pressureHpa: number;
  altitudeM: number;
  temperatureC: number;
  humidityPct: number;
  latitude: number;
  longitude: number;
  recordedAt: string; // ISO datetime string
}

export class AgentSyncService {
  async processSyncBatch(
    userId: string,
    readings: BarometricDataPoint[]
  ): Promise<{
    success: boolean;
    pointsProcessed: number;
    verifiedCount: number;
    tokensAwarded: number;
  }> {
    if (!readings || !Array.isArray(readings) || readings.length === 0) {
      throw new Error("A non-empty array of readings is required.");
    }

    let verifiedCount = 0;

    for (const reading of readings) {
      const { pressureHpa, altitudeM, temperatureC, humidityPct, latitude, longitude, recordedAt } = reading;

      if (
        pressureHpa === undefined ||
        altitudeM === undefined ||
        temperatureC === undefined ||
        humidityPct === undefined ||
        latitude === undefined ||
        longitude === undefined ||
        !recordedAt
      ) {
        continue; // Skip invalid readings in the batch
      }

      const recordedAtDate = new Date(recordedAt);
      const dateStr = recordedAtDate.toISOString().split("T")[0];
      const hour = recordedAtDate.getUTCHours();

      // A. Fetch OpenMeteo hourly reference for Sea Level Pressure comparison
      const openMeteoPressures = await triangulationService.fetchOpenMeteoReference(latitude, longitude, dateStr);
      const openMeteoRef = openMeteoPressures[hour] || 1013.25;

      // B. Calibrate station pressure reading to sea level based on altitude and temperature
      const calibratedSlp = triangulationService.calibrateToSeaLevel(pressureHpa, altitudeM, temperatureC);

      // C. Perform spatial triangulation consensus check against neighboring agents
      const triResult = await triangulationService.triangulateReading(
        userId,
        latitude,
        longitude,
        calibratedSlp,
        recordedAtDate,
        openMeteoRef
      );

      if (triResult.verified) {
        verifiedCount++;
      }

      // D. Save record to atmospheric_readings
      await query(
        `INSERT INTO atmospheric_readings (
          user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct,
          recorded_at, verified, anomaly_score, openmeteo_reference_hpa, network_consensus
        ) VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          userId,
          longitude,
          latitude,
          pressureHpa,
          altitudeM,
          temperatureC,
          humidityPct,
          recordedAtDate,
          triResult.verified,
          triResult.anomalyScore,
          triResult.openmeteoReferenceHpa,
          triResult.networkConsensus
        ]
      );
    }

    // E. Award tokens if at least one reading is successfully verified and within daily limit
    let tokensAwarded = 0;
    if (verifiedCount > 0) {
      const limitRes = await query(
        `SELECT COUNT(*) AS sync_count 
         FROM token_ledger 
         WHERE user_id = $1 
           AND transaction_type = 'atmospheric_sync' 
           AND created_at >= CURRENT_DATE`,
        [userId]
      );

      const syncCount = Number(limitRes.rows[0].sync_count);
      if (syncCount < 4) {
        tokensAwarded = 3;
        await tokenService.awardTokens(
          userId,
          tokensAwarded,
          `Reward for verified atmospheric pressure synchronization (${verifiedCount} verified)`,
          "atmospheric_sync"
        );
      }
    }

    return {
      success: true,
      pointsProcessed: readings.length,
      verifiedCount,
      tokensAwarded
    };
  }
}

export const agentSyncService = new AgentSyncService();
