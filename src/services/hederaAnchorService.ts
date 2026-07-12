/*
 * Copyright 2026 Dira Africa
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
import { createHash } from "crypto";
import { env } from "../config/env";

export class HederaAnchorService {
  /**
   * Computes the Merkle Root of a list of UUID strings.
   * IDs are sorted alphabetically to ensure deterministic hash trees.
   */
  computeMerkleRoot(ids: string[]): string {
    if (ids.length === 0) {
      return createHash("sha256").update("").digest("hex");
    }

    // Sort IDs to ensure deterministic tree structure
    const sortedIds = [...ids].sort();
    let currentLevel = sortedIds.map(id => createHash("sha256").update(id).digest("hex"));

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        if (i + 1 < currentLevel.length) {
          nextLevel.push(
            createHash("sha256")
              .update(currentLevel[i] + currentLevel[i + 1])
              .digest("hex")
          );
        } else {
          // Duplicate odd node
          nextLevel.push(
            createHash("sha256")
              .update(currentLevel[i] + currentLevel[i])
              .digest("hex")
          );
        }
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  /**
   * Helper to calculate the UTC Monday and Sunday of an ISO week number YYYYWW
   */
  getISOWeekRange(year: number, week: number): { start: Date; end: Date } {
    const jan4 = new Date(Date.UTC(year, 0, 4, 0, 0, 0, 0));
    const day = jan4.getUTCDay() || 7;
    const mondayOfW1 = new Date(jan4);
    mondayOfW1.setUTCDate(jan4.getUTCDate() - day + 1);

    const start = new Date(mondayOfW1);
    start.setUTCDate(mondayOfW1.getUTCDate() + (week - 1) * 7);
    start.setUTCHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    end.setUTCMilliseconds(-1);

    return { start, end };
  }

  /**
   * Helper to determine ISO week and year of a Date
   */
  getISOWeekNumber(date: Date): { year: number; week: number } {
    const tempDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    tempDate.setUTCDate(tempDate.getUTCDate() + 4 - (tempDate.getUTCDay() || 7));
    const year = tempDate.getUTCFullYear();
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((tempDate.getTime() - jan1.getTime()) / 86400000) + 1) / 7);
    return { year, week };
  }

  /**
   * Anchors all verified readings for a given week number.
   * If there are no readings, it skips.
   */
  async anchorWeeklyBatch(weekNumber: number): Promise<{
    anchored: boolean;
    hcsTxId?: string;
    batchHash?: string;
    dataPointCount?: number;
    hcsSequenceNumber?: string;
    htsTxId?: string;
  }> {
    const year = Math.floor(weekNumber / 100);
    const week = weekNumber % 100;
    const { start, end } = this.getISOWeekRange(year, week);

    // Query all verified atmospheric readings within this week
    const res = await query(
      `SELECT id FROM atmospheric_readings
       WHERE verified = TRUE
         AND recorded_at >= $1 AND recorded_at <= $2`,
      [start, end]
    );

    const dataPointCount = res.rows.length;
    if (dataPointCount === 0) {
      return { anchored: false };
    }

    const ids = res.rows.map(row => row.id as string);
    const batchHash = this.computeMerkleRoot(ids);

    // Stub anchoring values (Hedera integration pending)
    const hcsTxId = null;
    const hcsSequenceNumber = null;
    const htsTxId = null;

    console.log(`Hedera anchoring pending for week ${weekNumber} with batch root ${batchHash}`);

    await query(
      `INSERT INTO hedera_anchors (week_number, batch_hash, data_point_count, hcs_tx_id, hcs_sequence_number, hts_tx_id, anchored_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (week_number) DO UPDATE
       SET batch_hash = EXCLUDED.batch_hash,
           data_point_count = EXCLUDED.data_point_count,
           hcs_tx_id = EXCLUDED.hcs_tx_id,
           hcs_sequence_number = EXCLUDED.hcs_sequence_number,
           hts_tx_id = EXCLUDED.hts_tx_id,
           anchored_at = EXCLUDED.anchored_at`,
      [weekNumber, batchHash, dataPointCount, hcsTxId, hcsSequenceNumber, htsTxId]
    );

    return {
      anchored: true,
      hcsTxId: hcsTxId || undefined,
      batchHash,
      dataPointCount,
      hcsSequenceNumber: hcsSequenceNumber || undefined,
      htsTxId: htsTxId || undefined,
    };
  }

  /**
   * Finds all past completed weeks since the first verified reading,
   * and anchors any weeks that are not yet recorded in the hedera_anchors table.
   */
  async anchorAllCompletedWeeks(): Promise<{
    success: boolean;
    anchoredWeeksCount: number;
  }> {
    // Get earliest verified reading date
    const minRes = await query(
      "SELECT MIN(recorded_at) AS min_date FROM atmospheric_readings WHERE verified = TRUE"
    );

    const minDateRaw = minRes.rows[0]?.min_date;
    if (!minDateRaw) {
      return { success: true, anchoredWeeksCount: 0 };
    }

    const minDate = new Date(minDateRaw);
    const now = new Date();

    // Get ISO week range of the minDate
    const startWeek = this.getISOWeekNumber(minDate);
    const currentWeek = this.getISOWeekNumber(now);

    let anchoredWeeksCount = 0;

    // Loop weekly from startWeek's Monday up to now's ISO Monday (excluding the active current week)
    let currentLoopMonday = this.getISOWeekRange(startWeek.year, startWeek.week).start;
    const currentActiveMonday = this.getISOWeekRange(currentWeek.year, currentWeek.week).start;

    while (currentLoopMonday.getTime() < currentActiveMonday.getTime()) {
      const loopWeek = this.getISOWeekNumber(currentLoopMonday);
      const weekNumber = loopWeek.year * 100 + loopWeek.week;

      // Check if already anchored
      const anchorCheck = await query(
        "SELECT id FROM hedera_anchors WHERE week_number = $1",
        [weekNumber]
      );

      if (anchorCheck.rows.length === 0) {
        const anchorRes = await this.anchorWeeklyBatch(weekNumber);
        if (anchorRes.anchored) {
          anchoredWeeksCount++;
        }
      }

      // Increment by 7 days
      currentLoopMonday = new Date(currentLoopMonday.getTime() + 7 * 24 * 60 * 60 * 1000);
    }

    return {
      success: true,
      anchoredWeeksCount
    };
  }

  /**
   * Generates and registers a cryptographic data certificate for a county and time period.
   */
  async issueCertificate(
    countyCode: string,
    periodStart: Date,
    periodEnd: Date,
    conditionType: string,
    confidenceThreshold: number
  ): Promise<{
    success: boolean;
    certId: string;
    hcsTxId?: string;
    hcsSequenceNumber?: string;
    htsTxId?: string;
  }> {
    const startStr = periodStart.toISOString().split("T")[0];
    const endStr = periodEnd.toISOString().split("T")[0];

    // Cryptographic Certificate ID: SHA-256 of parameters
    const certPayload = `${countyCode}_${startStr}_${endStr}_${conditionType}_${confidenceThreshold.toFixed(3)}`;
    const certId = createHash("sha256").update(certPayload).digest("hex");
    
    // Stub anchoring values (Hedera integration pending)
    const hcsTxId = null;
    const hcsSequenceNumber = null;
    const htsTxId = null;

    await query(
      `INSERT INTO hedera_certificates (
        cert_id, county_code, period_start, period_end, condition_type, confidence_threshold, hcs_tx_id, hcs_sequence_number, hts_tx_id, issued_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
       ON CONFLICT (cert_id) DO UPDATE
       SET hcs_tx_id = EXCLUDED.hcs_tx_id,
           hcs_sequence_number = EXCLUDED.hcs_sequence_number,
           hts_tx_id = EXCLUDED.hts_tx_id,
           issued_at = EXCLUDED.issued_at`,
      [certId, countyCode, periodStart, periodEnd, conditionType, confidenceThreshold, hcsTxId, hcsSequenceNumber, htsTxId]
    );

    return {
      success: true,
      certId,
      hcsTxId: hcsTxId || undefined,
      hcsSequenceNumber: hcsSequenceNumber || undefined,
      htsTxId: htsTxId || undefined,
    };
  }
}

export const hederaAnchorService = new HederaAnchorService();
