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

// Programmatic mock of bullmq to prevent Redis connection attempts during test
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === "bullmq") {
    return {
      Queue: class MockQueue {
        constructor(public name: string) {}
        add = async () => ({ id: "mock-job-id" });
        close = async () => {};
        getRepeatableJobs = async () => [];
        removeRepeatableByKey = async () => {};
        getJobCounts = async () => ({ active: 0, waiting: 0, delayed: 0 });
      },
      Worker: class MockWorker {
        constructor(public name: string, public handler: any) {}
        close = async () => {};
        on = () => {};
      }
    };
  }
  return originalRequire.apply(this, arguments);
};

// Use require instead of hoisted import to ensure the mock is loaded first
const { pool } = require("./db/pool");
const { telemetryService } = require("./services/telemetryService");
const { notificationsQueue } = require("./jobs/queues");
const { query } = require("./db/query");

// Mock database state
const dbThresholds: Record<string, any> = {
  verification_failure_rate: {
    metric: "verification_failure_rate",
    threshold_value: 0.30,
    protective_action: "Inspect Gemini model logs and check AI fallback configurations",
    owner_name: "Alice (AI Lead)",
    current_status: "normal",
    last_value: 0.05
  }
};
const dbAlertLogs: any[] = [];
let dbTelegramNotifications: any[] = [];

// Override pool.query to simulate PostgreSQL in-memory
(pool as any).query = async (text: string, params?: any[]): Promise<any> => {
  const sql = text.toLowerCase();

  if (sql.includes("select") && sql.includes("early_warning_thresholds")) {
    return { rows: Object.values(dbThresholds) };
  }

  if (sql.includes("update") && sql.includes("early_warning_thresholds")) {
    const [lastVal, status, metric] = params!;
    if (dbThresholds[metric]) {
      dbThresholds[metric].last_value = lastVal;
      dbThresholds[metric].current_status = status;
    }
    return { rows: [] };
  }

  if (sql.includes("insert into") && sql.includes("early_warning_alerts")) {
    const [metric, threshold, current, status, message, signature] = params!;
    const alert = { metric, threshold_value: threshold, current_value: current, status, message, signature, created_at: new Date() };
    dbAlertLogs.push(alert);
    return { rows: [alert] };
  }

  if (sql.includes("select") && sql.includes("users")) {
    return { rows: [{ telegram_id: "12345" }] };
  }

  return { rows: [] };
};

(pool as any).connect = async (): Promise<any> => {
  return {
    query: pool.query,
    release: () => {}
  };
};

// Mock notificationsQueue
notificationsQueue.add = async (name: string, data: any) => {
  dbTelegramNotifications.push({ name, data });
  console.log(`[NotificationsQueue Mock] Sent Alert Notification: ${data.message}`);
  return {} as any;
};

async function runEarlyWarningTests() {
  console.log("🧪 Starting R4 Early-Warning System Simulation Tests...");

  // ========================================================
  // TEST 1: Baseline Normal Fluctuations (No Alerts)
  // ========================================================
  console.log("\n--- TEST 1: Injecting normal baseline fluctuations ---");
  const normalValues = [0.04, 0.06, 0.05, 0.03, 0.05];

  for (const val of normalValues) {
    console.log(`Injecting normal failure rate: ${val}`);
    await telemetryService.injectMetricValue("verification_failure_rate", val);
  }

  console.log(`Current Status: ${dbThresholds.verification_failure_rate.current_status}`);
  console.log(`Alerts Triggered: ${dbAlertLogs.length}`);

  if (dbThresholds.verification_failure_rate.current_status !== "normal" || dbAlertLogs.length > 0) {
    throw new Error("Test 1 Failed: Alerts triggered on normal baseline fluctuations");
  }
  console.log("✅ Test 1 Passed: baseline fluctuations generated no false alarms.");

  // ========================================================
  // TEST 2: Transient Noise Spike (Noise Filter Test)
  // ========================================================
  console.log("\n--- TEST 2: Injecting transient noise spike ---");
  // A single high spike (0.35) followed immediately by normal values
  const spikeValues = [0.35, 0.05, 0.04];
  for (const val of spikeValues) {
    console.log(`Injecting transient spike/normal value: ${val}`);
    await telemetryService.injectMetricValue("verification_failure_rate", val);
  }

  console.log(`Current Status: ${dbThresholds.verification_failure_rate.current_status}`);
  console.log(`Alerts Triggered: ${dbAlertLogs.length}`);

  if (dbThresholds.verification_failure_rate.current_status !== "normal" || dbAlertLogs.length > 0) {
    throw new Error("Test 2 Failed: Alert triggered on transient noise spike");
  }
  console.log("✅ Test 2 Passed: transient noise spike was filtered correctly.");

  // ========================================================
  // TEST 3: Sustained Regime Shift (Breach Trigger)
  // ========================================================
  console.log("\n--- TEST 3: Injecting sustained regime shift (breach) ---");
  // Gradual, sustained increase above threshold (0.30)
  const breachValues = [0.12, 0.18, 0.25, 0.32, 0.34];

  for (const val of breachValues) {
    console.log(`Injecting breaching failure rate: ${val}`);
    await telemetryService.injectMetricValue("verification_failure_rate", val);
  }

  console.log(`Current Status: ${dbThresholds.verification_failure_rate.current_status}`);
  console.log(`Alerts Triggered: ${dbAlertLogs.length}`);

  if (dbThresholds.verification_failure_rate.current_status !== "breached" || dbAlertLogs.length !== 1) {
    throw new Error("Test 3 Failed: Breached state or alert not triggered on sustained regime shift");
  }

  const alert = dbAlertLogs[0];
  console.log(`\nTriggered Alert Log:`);
  console.log(`Message: ${alert.message}`);
  console.log(`Signature: ${alert.signature}`);

  // Verify alert contains the protective action and owner
  if (
    !alert.message.includes("Alice (AI Lead)") ||
    !alert.message.includes("Inspect Gemini model logs and check AI fallback configurations")
  ) {
    throw new Error("Test 3 Failed: Alert message does not contain named owner or protective action");
  }

  // Verify HMAC signature is cryptographically valid
  const verifiedSig = telemetryService.generateAlertSignature(alert.message);
  if (alert.signature !== verifiedSig) {
    throw new Error("Test 3 Failed: HMAC alert signature verification failed");
  }

  console.log("✅ Test 3 Passed: regime shift successfully detected. Authenticated alert generated.");

  console.log("\n🎉 All R4 Early-Warning System simulation tests passed successfully!\n");
}

runEarlyWarningTests().catch(err => {
  console.error("❌ Simulation run failed with error:", err);
  process.exit(1);
});

export {};
