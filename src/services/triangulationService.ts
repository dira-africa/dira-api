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
import { pool } from "../db/pool";
import { redis } from "../db/redis";

// Simple in-memory cache for Open-Meteo hourly reference results
// Key: lat_lng_date, Value: array of 24 pressure values
const openMeteoCache: Record<string, number[]> = {};

export interface TriangulationResult {
  verified: boolean;
  networkConsensus: boolean;
  anomalyScore: number;
  openmeteoReferenceHpa: number;
}

export class TriangulationService {
  /**
   * Calibrates local measured pressure to Sea Level Pressure (SLP)
   * Formula: P_slp = P * (1 - (0.0065 * h) / (T + 0.0065 * h + 273.15))^-5.257
   */
  calibrateToSeaLevel(pressureHpa: number, altitudeM: number, temperatureC: number): number {
    if (altitudeM === 0) return Number(pressureHpa.toFixed(2));
    
    const lapseRate = 0.0065; // K/m
    const kelvinOffset = 273.15;
    const exponent = -5.257;

    const base = 1 - (lapseRate * altitudeM) / (temperatureC + lapseRate * altitudeM + kelvinOffset);
    const slp = pressureHpa * Math.pow(base, exponent);

    return Number(slp.toFixed(2));
  }

  /**
   * Fetches hourly sea level pressure from Open-Meteo API
   * Falls back to a diurnal cycle simulation if offline or API error occurs
   */
  async fetchOpenMeteoReference(lat: number, lng: number, dateStr: string): Promise<number[]> {
    const roundedLat = Number(lat.toFixed(2));
    const roundedLng = Number(lng.toFixed(2));
    const cacheKey = `${roundedLat}_${roundedLng}_${dateStr}`;

    if (openMeteoCache[cacheKey]) {
      return openMeteoCache[cacheKey];
    }

    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&hourly=surface_pressure&start_date=${dateStr}&end_date=${dateStr}`;
      
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        throw new Error(`Open-Meteo HTTP error: ${res.status}`);
      }

      const data = await res.json();
      const pressures = data.hourly?.surface_pressure;

      if (pressures && Array.isArray(pressures) && pressures.length === 24) {
        openMeteoCache[cacheKey] = pressures.map(p => Number(p));
        return openMeteoCache[cacheKey];
      }

      throw new Error("Invalid hourly data response format from Open-Meteo");
    } catch (err) {
      console.warn(`Failed to fetch Open-Meteo for ${cacheKey}, running simulated diurnal cycle fallback:`, err);
      
      // Diurnal pressure cycle simulation:
      // Sea level pressure varies with two peaks (around 10:00 and 22:00 local time)
      // Standard sea level pressure = 1013.25 hPa
      const simulatedPressures: number[] = [];
      for (let hour = 0; hour < 24; hour++) {
        // Semi-diurnal wave approximation: 1013.25 + 1.2 * sin(2 * pi * (hour - 4) / 12) + 0.3 * sin(2 * pi * hour / 24)
        const wave1 = 1.2 * Math.sin((2 * Math.PI * (hour - 4)) / 12);
        const wave2 = 0.3 * Math.sin((2 * Math.PI * hour) / 24);
        const value = 1013.25 + wave1 + wave2;
        simulatedPressures.push(Number(value.toFixed(2)));
      }
      
      openMeteoCache[cacheKey] = simulatedPressures;
      return simulatedPressures;
    }
  }

  /**
   * Processes a barometric reading, checking peer consensus and Open-Meteo reference values.
   */
  async triangulateReading(
    userId: string,
    latitude: number,
    longitude: number,
    calibratedSlp: number,
    recordedAt: Date,
    openMeteoRef: number
  ): Promise<TriangulationResult> {
    const timeWindow = 60 * 60 * 1000; // 1 hour temporal window
    const startTime = new Date(recordedAt.getTime() - timeWindow);
    const endTime = new Date(recordedAt.getTime() + timeWindow);

    // Query active verified readings from other users within a 10km spatial radius and time window
    const peerRes = await query(
      `SELECT pressure_hpa, altitude_m, temperature_c 
       FROM atmospheric_readings
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 10000)
         AND recorded_at >= $3 AND recorded_at <= $4
         AND user_id != $5
         AND verified = TRUE`,
      [longitude, latitude, startTime, endTime, userId]
    );

    const peerReadings = peerRes.rows;

    if (peerReadings.length >= 3) {
      // Step A: Perform spatial triangulation peer consensus
      let slpSum = 0;
      for (const peer of peerReadings) {
        const peerSlp = this.calibrateToSeaLevel(
          Number(peer.pressure_hpa),
          Number(peer.altitude_m),
          Number(peer.temperature_c)
        );
        slpSum += peerSlp;
      }
      
      const networkAvg = slpSum / peerReadings.length;
      const diff = Math.abs(calibratedSlp - networkAvg);
      
      // Reading is verified if within 3.0 hPa of the spatial average of surrounding peers
      const verified = diff <= 3.0;
      const anomalyScore = Number(Math.min(9.999, diff / 3.0).toFixed(3));

      return {
        verified,
        networkConsensus: verified,
        anomalyScore,
        openmeteoReferenceHpa: openMeteoRef
      };
    } else {
      // Step B: Peer density too low, fallback to Open-Meteo meteorological reference check
      const diff = Math.abs(calibratedSlp - openMeteoRef);
      
      // Reading is verified if within 4.0 hPa of Open-Meteo local station value
      const verified = diff <= 4.0;
      const anomalyScore = Number(Math.min(9.999, diff / 4.0).toFixed(3));

      return {
        verified,
        networkConsensus: false,
        anomalyScore,
        openmeteoReferenceHpa: openMeteoRef
      };
    }
  }

  async verifyAtmosphericReading(readingId: string): Promise<TriangulationResult> {
    // 1. Fetch reading from DB
    const res = await query(
      `SELECT id, user_id, pressure_hpa, altitude_m, recorded_at,
              ST_X(location::geometry) AS longitude,
              ST_Y(location::geometry) AS latitude
       FROM atmospheric_readings
       WHERE id = $1`,
      [readingId]
    );

    if (res.rows.length === 0) {
      throw new Error(`Reading not found: ${readingId}`);
    }

    const reading = res.rows[0];
    const userId = reading.user_id;
    const submittedPressure = Number(reading.pressure_hpa);
    const altitudeM = Number(reading.altitude_m);
    const recordedAt = new Date(reading.recorded_at);
    const longitude = Number(reading.longitude);
    const latitude = Number(reading.latitude);

    const roundedLat = Number(latitude.toFixed(2));
    const roundedLng = Number(longitude.toFixed(2));
    const dateStr = recordedAt.toISOString().split("T")[0];
    const hour = recordedAt.getUTCHours();

    // 2. Fetch Open-Meteo reference (Redis Cache Grid key)
    const cacheKey = `openmeteo:surface_pressure:${roundedLat}:${roundedLng}`;
    let surfacePressures: number[] | null = null;

    if (redis.status === "ready" || (redis as any).connector) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          surfacePressures = JSON.parse(cached);
        }
      } catch (err) {
        console.warn("Redis read error:", err);
      }
    }

    if (!surfacePressures) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&hourly=surface_pressure&forecast_days=1`;
        const apiRes = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!apiRes.ok) {
          throw new Error(`Open-Meteo HTTP error: ${apiRes.status}`);
        }
        const data = await apiRes.json();
        
        if (data.hourly?.surface_pressure && Array.isArray(data.hourly.surface_pressure)) {
          surfacePressures = data.hourly.surface_pressure.map((p: any) => Number(p));
          
          if (redis.status === "ready" || (redis as any).connector) {
            try {
              await redis.set(cacheKey, JSON.stringify(surfacePressures), "EX", 3600);
            } catch (err) {
              console.warn("Redis write error:", err);
            }
          }
        } else {
          throw new Error("Invalid hourly data response format from Open-Meteo");
        }
      } catch (err) {
        console.warn(`Failed to fetch Open-Meteo for ${cacheKey}, running simulated diurnal cycle fallback:`, err);
        // Fallback simulated diurnal cycle
        surfacePressures = [];
        for (let h = 0; h < 24; h++) {
          const wave1 = 1.2 * Math.sin((2 * Math.PI * (h - 4)) / 12);
          const wave2 = 0.3 * Math.sin((2 * Math.PI * h) / 24);
          const value = 1013.25 + wave1 + wave2;
          surfacePressures.push(Number(value.toFixed(2)));
        }
      }
    }

    // Find the hour closest to recorded_at
    const openMeteoRef = surfacePressures ? (surfacePressures[hour] || 1013.25) : 1013.25;

    // 3. Calculate deviation
    const adjustedExpected = openMeteoRef - (altitudeM / 100 * 12);
    let anomalyScore = Math.abs(submittedPressure - adjustedExpected) / adjustedExpected;
    anomalyScore = Number(Math.min(9.999, anomalyScore).toFixed(3));

    // 4. Scoring thresholds
    let verified = anomalyScore <= 0.05;
    let networkConsensus = false;

    if (verified && anomalyScore >= 0.02) {
      console.warn(`Medium confidence reading ${readingId}: deviation is ${anomalyScore}`);
    }

    // 5. Network consensus validation (20km radius, same 1-hour temporal window)
    const timeWindow = 60 * 60 * 1000; // 1 hour temporal window
    const startTime = new Date(recordedAt.getTime() - timeWindow);
    const endTime = new Date(recordedAt.getTime() + timeWindow);

    const peerRes = await query(
      `SELECT id, pressure_hpa, user_id
       FROM atmospheric_readings
       WHERE ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 20000)
         AND recorded_at >= $3 AND recorded_at <= $4
         AND user_id != $5
         AND verified = TRUE`,
      [longitude, latitude, startTime, endTime, userId]
    );

    // Group peers by distinct user IDs to prevent Sybil/multisubmit from same user
    const peerGroups: Record<string, typeof peerRes.rows[0][]> = {};
    for (const row of peerRes.rows) {
      if (!peerGroups[row.user_id]) {
        peerGroups[row.user_id] = [];
      }
      peerGroups[row.user_id].push(row);
    }

    // Find if there are 2+ distinct peer users whose pressures agree within 3% of submittedPressure
    const agreeingPeers: typeof peerRes.rows[0][] = [];
    for (const pUserId of Object.keys(peerGroups)) {
      const userReadings = peerGroups[pUserId];
      const agreeing = userReadings.find(r => {
        const pVal = Number(r.pressure_hpa);
        return Math.abs(submittedPressure - pVal) / pVal <= 0.03;
      });
      if (agreeing) {
        agreeingPeers.push(agreeing);
      }
    }

    if (agreeingPeers.length >= 2) {
      // 3+ distinct agents in total agree (current + 2 peers)
      verified = true;
      networkConsensus = true;
      anomalyScore = 0.000; // Boosted to High confidence

      // Boost all agreeing peers to High confidence & network consensus = true
      const peerIdsToBoost = agreeingPeers.map(p => p.id);
      if (peerIdsToBoost.length > 0) {
        await query(
          `UPDATE atmospheric_readings
           SET verified = TRUE,
               anomaly_score = 0.000,
               network_consensus = TRUE
           WHERE id = ANY($1)`,
          [peerIdsToBoost]
        );
      }
    }

    // 6. Save reading update
    await query(
      `UPDATE atmospheric_readings
       SET verified = $1,
           anomaly_score = $2,
           openmeteo_reference_hpa = $3,
           network_consensus = $4
       WHERE id = $5`,
      [verified, anomalyScore, openMeteoRef, networkConsensus, readingId]
    );

    // 7. Token ledger handling
    const ledgerRes = await query(
      `SELECT id FROM token_ledger
       WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'pending'`,
      [readingId]
    );

    if (ledgerRes.rows.length > 0) {
      if (verified) {
        // Daily sync limit check
        const limitRes = await query(
          `SELECT count AS count FROM (
            SELECT COUNT(*) AS count 
            FROM token_ledger 
            WHERE user_id = $1 
              AND transaction_type = 'atmospheric_sync' 
              AND notes = 'confirmed' 
              AND created_at >= CURRENT_DATE
          ) t`,
          [userId]
        );
        const confirmedCount = Number(limitRes.rows[0].count);

        if (confirmedCount < 4) {
          // Confirm the pending 1 token
          await query(
            `UPDATE token_ledger
             SET notes = 'confirmed'
             WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'pending'`,
            [readingId]
          );
        } else {
          // Daily limit reached - reverse pending token
          await this.reversePendingToken(userId, readingId, "Daily limit reached - reversed");
        }
      } else {
        // Anomalous - reverse pending token
        await this.reversePendingToken(userId, readingId, "Failed consensus - reversed");
      }
    }

    return {
      verified,
      networkConsensus,
      anomalyScore,
      openmeteoReferenceHpa: openMeteoRef
    };
  }

  private async reversePendingToken(userId: string, readingId: string, reason: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      
      // Lock the user row first to prevent deadlocks with other transactions (like tokenService)
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);

      const balanceRes = await client.query(
        "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId]
      );
      const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance_after) : 0;
      const newBalance = Math.max(0, currentBalance - 1);
      
      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
         VALUES ($1, -1, $2, 'adjustment', $3, $4)`,
        [userId, newBalance, readingId, reason]
      );
      
      await client.query(
        `UPDATE token_ledger
         SET notes = 'reversed'
         WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync' AND notes = 'pending'`,
        [readingId]
      );
      
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export const triangulationService = new TriangulationService();
