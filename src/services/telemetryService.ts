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
import { createHmac } from "crypto";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  hederaAnchorQueue,
  airtimeQueue
} from "../jobs/queues";

// Sliding logs of API latencies and errors
interface ApiRequestRecord {
  latencyMs: number;
  statusCode: number;
  timestamp: number;
}

export class TelemetryService {
  private apiRequests: ApiRequestRecord[] = [];
  private metricHistory = new Map<string, number[]>();
  private lastAlertedAt = new Map<string, number>();
  private backgroundInterval: NodeJS.Timeout | null = null;

  // Trackers for mock or dynamic indicators
  private mirrorNodeLag = 2.5; // base healthy HCS mirror lag in seconds
  private airtimeBalance = 5000.0; // default cash float in KES

  /**
   * Tracks transient API request latency and status codes
   */
  recordApiRequest(latencyMs: number, statusCode: number) {
    this.apiRequests.push({ latencyMs, statusCode, timestamp: Date.now() });
    // Keep only the last 100 requests to avoid memory growth
    if (this.apiRequests.length > 100) {
      this.apiRequests.shift();
    }
  }

  setMirrorNodeLag(seconds: number) {
    this.mirrorNodeLag = seconds;
  }

  setAirtimeBalance(amount: number) {
    this.airtimeBalance = amount;
  }

  /**
   * Recursive Bayesian change-point/anomaly detector.
   * Estimates the probability that recent values belong to a shifted regime
   * (near the threshold) vs. the baseline normal regime, filtering temporary noise.
   */
  detectBayesianAnomaly(history: number[], thresholdValue: number, metricName: string): number {
    if (history.length < 3) return 0.1; // Not enough data points

    // Assume normal baseline mean is the first or typical normal value
    const muNormal = history[0];
    
    // Define heuristic standard deviation (expected noise variance) per metric
    let sigma = 0.05 * Math.abs(muNormal || 1.0);
    if (metricName === "verification_failure_rate") sigma = 0.05;
    if (metricName === "airtime_balance") sigma = 100.0;
    if (metricName === "queue_backlog") sigma = 3.0;
    if (metricName === "mirror_node_lag") sigma = 5.0;
    if (metricName === "api_error_rate") sigma = 0.02;
    if (metricName === "agent_submission_cadence") sigma = 1000.0;
    if (sigma === 0) sigma = 1.0;

    // Normal probability density function
    const normalPdf = (x: number, mean: number, stdDev: number) => {
      const exponent = -Math.pow(x - mean, 2) / (2 * Math.pow(stdDev, 2));
      return (1 / (stdDev * Math.sqrt(2 * Math.PI))) * Math.exp(exponent);
    };

    let pAnomaly = 0.1; // initial prior probability of anomaly
    for (const val of history) {
      const likelihoodNormal = Math.max(normalPdf(val, muNormal, sigma), 1e-6);
      const likelihoodAnomaly = Math.max(normalPdf(val, thresholdValue, sigma), 1e-6);

      // Recursive Bayes update
      const numerator = likelihoodAnomaly * pAnomaly;
      const denominator = (likelihoodNormal * (1 - pAnomaly)) + numerator;
      pAnomaly = denominator > 0 ? numerator / denominator : pAnomaly;
    }

    return pAnomaly;
  }

  /**
   * Generates a cryptographically signed HMAC for an alert message.
   */
  generateAlertSignature(message: string): string {
    const key = env.PGCRYPTO_SYMMETRIC_KEY || "dira-secret-warning-key";
    return createHmac("sha256", key).update(message).digest("hex");
  }

  /**
   * Gathers live metrics from database and active queues
   */
  async gatherMetrics(): Promise<Record<string, number>> {
    const metrics: Record<string, number> = {};

    // 1. Verification failure rate (last 20 completed photo submissions)
    try {
      const subRes = await query(
        `SELECT verification_status FROM crop_submissions 
         WHERE verification_status IN ('verified', 'rejected') 
         ORDER BY created_at DESC LIMIT 20`
      );
      if (subRes.rows.length > 0) {
        const failedCount = subRes.rows.filter(r => r.verification_status === "rejected").length;
        metrics["verification_failure_rate"] = Number((failedCount / subRes.rows.length).toFixed(4));
      } else {
        metrics["verification_failure_rate"] = 0.0;
      }
    } catch (err: any) {
      console.warn("Failed to gather verification failure rate:", err.message);
      metrics["verification_failure_rate"] = 0.05;
    }

    // 2. Airtime float balance
    metrics["airtime_balance"] = this.airtimeBalance;

    // 3. Queue backlog (BullMQ job backlogs across all 5 queues)
    let backlog = 0;
    const queues = [
      photoVerificationQueue,
      atmosphericVerificationQueue,
      notificationsQueue,
      hederaAnchorQueue,
      airtimeQueue
    ];
    for (const q of queues) {
      try {
        const counts = await q.getJobCounts();
        backlog += (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
      } catch (err: any) {
        console.warn("Failed to read backlog for queue:", err.message);
      }
    }
    metrics["queue_backlog"] = backlog;

    // 4. Mirror node lag
    metrics["mirror_node_lag"] = this.mirrorNodeLag;

    // 5. API latency and API error rate
    const recentRequests = this.apiRequests.slice(-50); // look at last 50 requests
    if (recentRequests.length > 0) {
      const sumLatency = recentRequests.reduce((sum, r) => sum + r.latencyMs, 0);
      const errorsCount = recentRequests.filter(r => r.statusCode >= 400).length;
      metrics["api_error_rate"] = Number((errorsCount / recentRequests.length).toFixed(4));
    } else {
      metrics["api_error_rate"] = 0.0;
    }

    // 6. Agent submission cadence (average time gap in seconds between consecutive syncs in last 24h)
    try {
      const readingsRes = await query(
        `SELECT created_at FROM atmospheric_readings 
         WHERE created_at >= NOW() - INTERVAL '24 hours' 
         ORDER BY created_at DESC LIMIT 20`
      );
      if (readingsRes.rows.length >= 2) {
        let gapSum = 0;
        for (let i = 0; i < readingsRes.rows.length - 1; i++) {
          const t1 = new Date(readingsRes.rows[i].created_at).getTime();
          const t2 = new Date(readingsRes.rows[i + 1].created_at).getTime();
          gapSum += (t1 - t2) / 1000;
        }
        metrics["agent_submission_cadence"] = Number((gapSum / (readingsRes.rows.length - 1)).toFixed(1));
      } else {
        metrics["agent_submission_cadence"] = 3600.0; // fallback to healthy 1 hour gap
      }
    } catch (err: any) {
      console.warn("Failed to calculate agent cadence:", err.message);
      metrics["agent_submission_cadence"] = 3600.0;
    }

    return metrics;
  }

  /**
   * Runs the anomaly evaluation loop, updating database metrics history
   * and raising authenticated alerts on breached thresholds.
   */
  async evaluateMetrics(customMetrics?: Record<string, number>) {
    const gathered = customMetrics || (await this.gatherMetrics());

    // Fetch threshold settings from database
    const thresholdRes = await query("SELECT * FROM early_warning_thresholds");
    for (const row of thresholdRes.rows) {
      const { metric, threshold_value: threshold, protective_action: action, owner_name: owner } = row;
      const currentVal = gathered[metric] !== undefined ? gathered[metric] : row.last_value;

      // Update history rolling array
      if (!this.metricHistory.has(metric)) {
        this.metricHistory.set(metric, [currentVal]);
      } else {
        const history = this.metricHistory.get(metric)!;
        history.push(currentVal);
        if (history.length > 5) {
          history.shift();
        }
      }

      const history = this.metricHistory.get(metric)!;
      const pAnomaly = this.detectBayesianAnomaly(history, threshold, metric);

      // Determine breach state based on anomaly probability
      let isBreached = false;
      if (metric === "airtime_balance") {
        // Airtime is a lower-bound threshold: anomaly if balance falls below threshold
        isBreached = currentVal <= threshold && pAnomaly > 0.95;
      } else {
        // Other metrics are upper-bound thresholds: anomaly if value exceeds threshold
        isBreached = currentVal >= threshold && pAnomaly > 0.95;
      }

      const newStatus = isBreached ? "breached" : "normal";

      // Save metrics point to history
      await query(
        `UPDATE early_warning_thresholds 
         SET last_value = $1, current_status = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE metric = $3`,
        [currentVal, newStatus, metric]
      );

      // Trigger alert if status transitioned to breached and not in cooldown
      if (isBreached) {
        const lastAlertTime = this.lastAlertedAt.get(metric) || 0;
        const coolDownMs = 5 * 60 * 1000; // 5 minute cooldown
        if (Date.now() - lastAlertTime > coolDownMs) {
          this.lastAlertedAt.set(metric, Date.now());

          const alertMsg = `⚠️ ALERT: Leading indicator metric [${metric}] has breached threshold ${threshold}. Current value: ${currentVal}. Protective action: "${action}". Named Owner: ${owner}.`;
          const signature = this.generateAlertSignature(alertMsg);
          const signedMsg = `${alertMsg}\n\n[Authenticated Alert Signature: hmac-sha256:${signature}]`;

          // Queue the signed Telegram alert notification
          try {
            const adminRes = await query("SELECT telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL LIMIT 1");
            const adminId = adminRes.rows[0]?.telegram_id;
            if (adminId) {
              await notificationsQueue.add("send-telegram", {
                telegramId: String(adminId),
                message: signedMsg
              });
            }
          } catch (notifErr: any) {
            console.error("Failed to queue Telegram alert notification:", notifErr.message);
          }

          // Save alert log
          await query(
            `INSERT INTO early_warning_alerts (metric, threshold_value, current_value, status, message, signature)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [metric, threshold, currentVal, "breached", alertMsg, signature]
          );

          console.log(`🚨 Early-Warning Alert dispatched for ${metric}: ${alertMsg}`);
        }
      }
    }
  }

  /**
   * Helper to force-inject a metric value for testing and trigger evaluations.
   */
  async injectMetricValue(metricName: string, value: number) {
    if (metricName === "airtime_balance") {
      this.setAirtimeBalance(value);
    } else if (metricName === "mirror_node_lag") {
      this.setMirrorNodeLag(value);
    }
    const gathered = await this.gatherMetrics();
    gathered[metricName] = value; // override with exact injected value
    await this.evaluateMetrics(gathered);
  }

  /**
   * Start background gathering loop every 30 seconds
   */
  start() {
    if (this.backgroundInterval) return;
    this.backgroundInterval = setInterval(() => {
      this.evaluateMetrics().catch(err => console.error("Telemetry gather error:", err.message));
    }, 30000);
    console.log("📈 TelemetryService active warning system loop started.");
  }

  /**
   * Stop background loop
   */
  stop() {
    if (this.backgroundInterval) {
      clearInterval(this.backgroundInterval);
      this.backgroundInterval = null;
      console.log("📈 TelemetryService active warning system loop stopped.");
    }
  }
}

export const telemetryService = new TelemetryService();
