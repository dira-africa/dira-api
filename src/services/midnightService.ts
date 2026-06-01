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
import { createHash } from "crypto";
import { env } from "../config/env";

// Dummy compiled contract definitions to represent the output of the Compact compiler
export const diraDataAnchorContract = {
  name: "DiraDataAnchor",
  source: "weekly_anchors: Map<Uint<64>, Bytes<32>>"
};

export const diraDataCertificateContract = {
  name: "DiraDataCertificate",
  source: "certificates: Map<Bytes<32>, WeatherCertificate>"
};

export class MidnightService {
  /**
   * Helper to retrieve the Midnight JS SDK dynamically if available in local node_modules.
   * This prevents runtime crashes in development/test/sandbox environments where
   * the SDK packages are not installed, while enabling production on-chain anchoring.
   */
  private async getMidnightSdk(): Promise<typeof import("@midnight-ntwrk/midnight-js") | null> {
    try {
      return await import("@midnight-ntwrk/midnight-js");
    } catch (e) {
      return null;
    }
  }

  /**
   * Checks if the Midnight production connection credentials are configured in the environment.
   */
  isMidnightConfigured(): boolean {
    return !!(
      env.MIDNIGHT_PROOF_SERVER_URL &&
      env.MIDNIGHT_INDEXER_URL &&
      env.MIDNIGHT_WALLET_SEED
    );
  }

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
    txHash?: string;
    batchHash?: string;
    dataPointCount?: number;
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

    let txHash = "";

    if (this.isMidnightConfigured()) {
      const sdk = await this.getMidnightSdk();
      if (sdk) {
        // Setup Midnight Providers
        const proofProvider = { proofServerUrl: env.MIDNIGHT_PROOF_SERVER_URL! };
        const indexerPublicDataProvider = { indexerUrl: env.MIDNIGHT_INDEXER_URL! };
        const walletProvider = { walletSeed: env.MIDNIGHT_WALLET_SEED! };
        const providers = { proofProvider, indexerPublicDataProvider, walletProvider };

        let contract;
        if (env.MIDNIGHT_ANCHOR_CONTRACT_ADDRESS) {
          contract = await sdk.findDeployedContract(providers, {
            compiledContract: diraDataAnchorContract,
            contractAddress: env.MIDNIGHT_ANCHOR_CONTRACT_ADDRESS,
            privateStateId: "dira-data-anchor-state"
          });
        } else {
          contract = await sdk.deployContract(providers, {
            compiledContract: diraDataAnchorContract,
            privateStateId: "dira-data-anchor-state"
          });
        }

        // Call the anchor_week circuit on the smart contract
        // Converting batchHash (hex string) into Bytes<32> representation
        const resCall = await contract.callTx.anchor_week(BigInt(weekNumber), batchHash);
        txHash = resCall.txHash;
      } else {
        throw new Error("Midnight SDK is configured but packages are not installed.");
      }
    } else {
      // Cryptographic Simulation / Sandbox mock fallback
      txHash = `0xanchor_tx_${createHash("sha256").update(`${weekNumber}_${batchHash}`).digest("hex").substring(0, 32)}`;
    }

    await query(
      `INSERT INTO midnight_anchors (week_number, batch_hash, data_point_count, midnight_tx_hash, anchored_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (week_number) DO UPDATE
       SET batch_hash = EXCLUDED.batch_hash,
           data_point_count = EXCLUDED.data_point_count,
           midnight_tx_hash = EXCLUDED.midnight_tx_hash,
           anchored_at = EXCLUDED.anchored_at`,
      [weekNumber, batchHash, dataPointCount, txHash]
    );

    return {
      anchored: true,
      txHash,
      batchHash,
      dataPointCount
    };
  }

  /**
   * Finds all past completed weeks since the first verified reading,
   * and anchors any weeks that are not yet recorded in the midnight_anchors table.
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
        "SELECT id FROM midnight_anchors WHERE week_number = $1",
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
    txHash: string;
  }> {
    const startStr = periodStart.toISOString().split("T")[0];
    const endStr = periodEnd.toISOString().split("T")[0];

    // Cryptographic Certificate ID: SHA-256 of parameters
    const certPayload = `${countyCode}_${startStr}_${endStr}_${conditionType}_${confidenceThreshold.toFixed(3)}`;
    const certId = createHash("sha256").update(certPayload).digest("hex");
    let txHash = "";

    if (this.isMidnightConfigured()) {
      const sdk = await this.getMidnightSdk();
      if (sdk) {
        // Setup Midnight Providers
        const proofProvider = { proofServerUrl: env.MIDNIGHT_PROOF_SERVER_URL! };
        const indexerPublicDataProvider = { indexerUrl: env.MIDNIGHT_INDEXER_URL! };
        const walletProvider = { walletSeed: env.MIDNIGHT_WALLET_SEED! };
        const providers = { proofProvider, indexerPublicDataProvider, walletProvider };

        let contract;
        if (env.MIDNIGHT_CERTIFICATE_CONTRACT_ADDRESS) {
          contract = await sdk.findDeployedContract(providers, {
            compiledContract: diraDataCertificateContract,
            contractAddress: env.MIDNIGHT_CERTIFICATE_CONTRACT_ADDRESS,
            privateStateId: "dira-data-certificate-state"
          });
        } else {
          contract = await sdk.deployContract(providers, {
            compiledContract: diraDataCertificateContract,
            privateStateId: "dira-data-certificate-state"
          });
        }

        // Call the issue_certificate circuit
        // Map Compact fields:
        // - cert_id: Bytes<32>
        // - county_code: Bytes<10>
        // - period_start: Uint<64> (UNIX timestamp seconds)
        // - period_end: Uint<64> (UNIX timestamp seconds)
        // - condition_type: Bytes<32>
        // - confidence_threshold: Uint<64> (scaled integer, e.g. 985 for 0.985)
        const resCall = await contract.callTx.issue_certificate(
          certId,
          countyCode.substring(0, 10),
          BigInt(Math.floor(periodStart.getTime() / 1000)),
          BigInt(Math.floor(periodEnd.getTime() / 1000)),
          conditionType.substring(0, 32),
          BigInt(Math.round(confidenceThreshold * 1000))
        );
        txHash = resCall.txHash;
      } else {
        throw new Error("Midnight SDK is configured but packages are not installed.");
      }
    } else {
      // Cryptographic Simulation / Sandbox mock fallback
      txHash = `0xcertificate_tx_${createHash("sha256").update(certId).digest("hex").substring(0, 32)}`;
    }

    await query(
      `INSERT INTO midnight_certificates (
        cert_id, county_code, period_start, period_end, condition_type, confidence_threshold, midnight_tx_hash, issued_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       ON CONFLICT (cert_id) DO UPDATE
       SET midnight_tx_hash = EXCLUDED.midnight_tx_hash,
           issued_at = EXCLUDED.issued_at`,
      [certId, countyCode, periodStart, periodEnd, conditionType, confidenceThreshold, txHash]
    );

    return {
      success: true,
      certId,
      txHash
    };
  }
}

export const midnightService = new MidnightService();
