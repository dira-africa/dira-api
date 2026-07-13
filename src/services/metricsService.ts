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
import { env } from "../config/env";
import { hederaService } from "./hederaService";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  hederaAnchorQueue
} from "../jobs/queues";

export class MetricsService {
  private httpRequests = new Map<string, number>();

  // Default sandbox/mock values for cash floats
  private airtimeFloat = 10000;
  private mpesaFloat = 15000;

  /**
   * Tracks transient HTTP requests in-memory.
   */
  incrementRequests(method: string, route: string, status: number) {
    const key = `method="${method}",route="${route}",status="${status}"`;
    this.httpRequests.set(key, (this.httpRequests.get(key) || 0) + 1);
  }

  setAirtimeFloat(amount: number) {
    this.airtimeFloat = amount;
  }

  setMpesaFloat(amount: number) {
    this.mpesaFloat = amount;
  }

  /**
   * Builds the Prometheus exposition text by combining in-memory metrics,
   * database aggregations, queue counts, and Hedera HTS queries.
   */
  async getMetricsText(): Promise<string> {
    const lines: string[] = [];

    // 1. HTTP Request Metrics (In-Memory)
    lines.push("# HELP dira_http_requests_total Total number of HTTP requests");
    lines.push("# TYPE dira_http_requests_total counter");
    for (const [labels, val] of this.httpRequests.entries()) {
      lines.push(`dira_http_requests_total{${labels}} ${val}`);
    }

    // 2. Verification metrics (Database-driven)
    lines.push("# HELP dira_verifications_total Total number of data verifications");
    lines.push("# TYPE dira_verifications_total counter");
    try {
      // Photo verifications from crop_submissions
      const cropRes = await query(
        "SELECT verification_status, COUNT(*) AS count FROM crop_submissions GROUP BY verification_status"
      );
      for (const row of cropRes.rows) {
        lines.push(`dira_verifications_total{type="photo",status="${row.verification_status}"} ${row.count}`);
      }

      // Atmospheric verifications from token_ledger (passive syncs)
      const atmosphericRes = await query(
        "SELECT COUNT(*) AS count FROM token_ledger WHERE transaction_type = 'atmospheric_sync'"
      );
      const count = Number(atmosphericRes.rows[0]?.count || 0);
      lines.push(`dira_verifications_total{type="atmospheric",status="verified"} ${count}`);
    } catch (err: any) {
      console.warn("[MetricsService] Failed to fetch database verification metrics:", err.message);
    }

    // 3. Redemption metrics (Database-driven)
    lines.push("# HELP dira_redemptions_total Total number of token redemptions");
    lines.push("# TYPE dira_redemptions_total counter");
    try {
      const redRes = await query(
        "SELECT redemption_type, status, COUNT(*) AS count FROM redemption_requests GROUP BY redemption_type, status"
      );
      for (const row of redRes.rows) {
        lines.push(`dira_redemptions_total{type="${row.redemption_type}",status="${row.status}"} ${row.count}`);
      }
    } catch (err: any) {
      console.warn("[MetricsService] Failed to fetch database redemption metrics:", err.message);
    }

    // 4. Float levels
    lines.push("# HELP dira_settlement_float_kes Float balance level in KES");
    lines.push("# TYPE dira_settlement_float_kes gauge");
    lines.push(`dira_settlement_float_kes{channel="airtime"} ${this.airtimeFloat}`);
    lines.push(`dira_settlement_float_kes{channel="mpesa"} ${this.mpesaFloat}`);

    // 5. On-chain HTS balance
    let treasuryBalance = 0;
    try {
      const operatorId = env.HEDERA_OPERATOR_ID;
      const tokenId = env.DIRA_HTS_TOKEN_ID;
      if (operatorId && tokenId && tokenId !== "0.0.12345") {
        const client = await hederaService.getClient(false);
        const { AccountBalanceQuery, AccountId } = await import("@hashgraph/sdk");
        const balQuery = new AccountBalanceQuery().setAccountId(AccountId.fromString(operatorId));
        const balance = await balQuery.execute(client);
        const tokenLong = balance.tokens.get(AccountId.fromString(tokenId));
        if (tokenLong) {
          treasuryBalance = tokenLong.toNumber() / 100;
        }
      }
    } catch (err: any) {
      console.warn("[MetricsService] Failed to fetch HTS token balance:", err.message);
    }
    lines.push("# HELP hedera_treasury_token_balance Climate Token balance of the treasury account on Hedera");
    lines.push("# TYPE hedera_treasury_token_balance gauge");
    lines.push(`hedera_treasury_token_balance ${treasuryBalance}`);

    // 6. BullMQ job health
    lines.push("# HELP bullmq_job_status_total Total number of jobs in BullMQ queues");
    lines.push("# TYPE bullmq_job_status_total gauge");

    const queues = [
      { name: "photo-verification", queue: photoVerificationQueue },
      { name: "atmospheric-verification", queue: atmosphericVerificationQueue },
      { name: "notifications", queue: notificationsQueue },
      { name: "hedera-anchor", queue: hederaAnchorQueue }
    ];

    for (const q of queues) {
      try {
        const counts = await q.queue.getJobCounts();
        for (const [status, count] of Object.entries(counts)) {
          lines.push(`bullmq_job_status_total{queue="${q.name}",status="${status}"} ${count}`);
        }
      } catch (err: any) {
        console.warn(`[MetricsService] Failed to fetch job counts for queue ${q.name}:`, err.message);
      }
    }

    return lines.join("\n") + "\n";
  }
}

export const metricsService = new MetricsService();
