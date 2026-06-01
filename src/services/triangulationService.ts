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
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&hourly=pressure_msl&start_date=${dateStr}&end_date=${dateStr}`;
      
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        throw new Error(`Open-Meteo HTTP error: ${res.status}`);
      }

      const data = await res.json();
      const pressures = data.hourly?.pressure_msl;

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
}

export const triangulationService = new TriangulationService();
