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
    let tokensAwarded = 0;

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
      const tempVal = temperatureC !== undefined ? temperatureC : 20.0;
      const humVal = humidityPct !== undefined ? humidityPct : 60.0;

      // 1. Insert reading initially unverified
      const insertRes = await query(
        `INSERT INTO atmospheric_readings (
          user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct,
          recorded_at, verified, anomaly_score, openmeteo_reference_hpa, network_consensus
        ) VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6, $7, $8, FALSE, 0.000, NULL, FALSE)
        RETURNING id`,
        [userId, longitude, latitude, pressureHpa, altitudeM, tempVal, humVal, recordedAtDate]
      );
      const readingId = insertRes.rows[0].id;

      // 2. Insert pending 1 token
      await tokenService.awardTokens(
        userId,
        1,
        "pending",
        "atmospheric_sync",
        readingId
      );

      // 3. Call verifyAtmosphericReading
      const verifyResult = await triangulationService.verifyAtmosphericReading(readingId);

      if (verifyResult.verified) {
        verifiedCount++;
        // Check if token was confirmed (not reversed due to limit)
        const checkLedger = await query(
          `SELECT id FROM token_ledger
           WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'confirmed'`,
          [readingId]
        );
        if (checkLedger.rows.length > 0) {
          tokensAwarded += 1;
        }
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
