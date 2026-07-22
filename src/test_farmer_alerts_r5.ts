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

const { pool } = require("./db/pool");
const { alertComposerService } = require("./services/alertComposerService");
const { notificationsQueue } = require("./jobs/queues");

// Mock users database
const mockUsers: Record<string, any> = {
  "user-1-en-enabled": {
    id: "user-1-en-enabled",
    telegram_id: 11111,
    language: "en",
    alerts_enabled: true
  },
  "user-2-sw-enabled": {
    id: "user-2-sw-enabled",
    telegram_id: 22222,
    language: "sw",
    alerts_enabled: true
  },
  "user-3-en-disabled": {
    id: "user-3-en-disabled",
    telegram_id: 33333,
    language: "en",
    alerts_enabled: false
  }
};

const mockAlerts: any[] = [];
let telegramNotifications: any[] = [];

// Override pool.query
(pool as any).query = async (text: string, params?: any[]): Promise<any> => {
  const sql = text.toLowerCase();

  // User fetch
  if (sql.includes("select") && sql.includes("users")) {
    const userId = params ? params[0] : undefined;
    const user = mockUsers[userId || ""];
    return { rows: user ? [user] : [] };
  }

  // Rate limit check
  if (sql.includes("select") && sql.includes("farmer_climate_alerts") && sql.includes("interval '4 hours'")) {
    const userId = params ? params[0] : undefined;
    // Find if there is any 'sent' alert logged for this user
    const hasSent = mockAlerts.some(a => a.userId === userId && a.status === "sent");
    return { rows: hasSent ? [{ created_at: new Date() }] : [] };
  }

  // Insert alert log
  if (sql.includes("insert into") && sql.includes("farmer_climate_alerts")) {
    const [userId, metric, prob, low, high, conf, action, esc, message, status] = params!;
    const newAlert = { id: `alert-${Date.now()}`, userId, metric, prob, low, high, conf, action, esc, message, status, created_at: new Date() };
    mockAlerts.push(newAlert);
    return { rows: [newAlert] };
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
  telegramNotifications.push({ name, data });
  return {} as any;
};

async function runFarmerAlertComposerTests() {
  console.log("🧪 Starting R5 Farmer Climate Alerts Simulation Tests...");

  const optionsRainfallHigh: any = {
    metric: "rainfall",
    unit: "mm",
    probability: 80,
    credibleInterval: [50, 70],
    confidence: "high",
    action: "dig drainage channels",
    escalation: "rainfall probability exceeds 90%"
  };

  const optionsRainfallLow: any = {
    metric: "rainfall",
    unit: "mm",
    probability: 60,
    credibleInterval: [20, 80],
    confidence: "low",
    action: "dig drainage channels",
    escalation: "rainfall probability exceeds 90%"
  };

  // ========================================================
  // TEST 1: Bilingual Alert Message Composition
  // ========================================================
  console.log("\n--- TEST 1: Verifying bilingual text composition ---");

  // English High Confidence
  const enHighMsg = alertComposerService.composeMessage(optionsRainfallHigh, "en");
  console.log(`[EN High Confidence]: ${enHighMsg}`);
  if (!enHighMsg.includes("high-confidence") || !enHighMsg.includes("ACTION:") || !enHighMsg.includes("ESCALATION:")) {
    throw new Error("Test 1 Failed: English high confidence template is incorrect");
  }

  // English Low Confidence
  const enLowMsg = alertComposerService.composeMessage(optionsRainfallLow, "en");
  console.log(`[EN Low Confidence]: ${enLowMsg}`);
  if (!enLowMsg.includes("possible, tentative range") || !enLowMsg.includes("Consider choosing") || !enLowMsg.includes("monitor and alert again")) {
    throw new Error("Test 1 Failed: English low confidence template is incorrect");
  }

  // Swahili High Confidence
  const swHighMsg = alertComposerService.composeMessage(optionsRainfallHigh, "sw");
  console.log(`[SW High Confidence]: ${swHighMsg}`);
  if (!swHighMsg.includes("uhakika mkubwa") || !swHighMsg.includes("HATUA:") || !swHighMsg.includes("MABADILIKO:")) {
    throw new Error("Test 1 Failed: Swahili high confidence template is incorrect");
  }

  // Swahili Low Confidence
  const swLowMsg = alertComposerService.composeMessage(optionsRainfallLow, "sw");
  console.log(`[SW Low Confidence]: ${swLowMsg}`);
  if (!swLowMsg.includes("uwezekano mdogo tu") || !swLowMsg.includes("Fikiria kuanza") || !swLowMsg.includes("Tutafuatilia kwa karibu")) {
    throw new Error("Test 1 Failed: Swahili low confidence template is incorrect");
  }

  console.log("✅ Test 1 Passed: Alert message composition reflects confidence honestly.");

  // ========================================================
  // TEST 2: Successful Alert Dispatch (Opted-in User)
  // ========================================================
  console.log("\n--- TEST 2: Verifying alert dispatch for opted-in user ---");
  telegramNotifications = [];
  mockAlerts.length = 0;

  const res1 = await alertComposerService.sendAlertToUser("user-1-en-enabled", optionsRainfallHigh);
  console.log(`User 1 Dispatch Status: ${res1.status}`);
  console.log(`User 1 Logged Alerts Count: ${mockAlerts.length}`);
  console.log(`Telegram Alerts Sent: ${telegramNotifications.length}`);

  if (res1.status !== "sent" || mockAlerts.length !== 1 || telegramNotifications.length !== 1) {
    throw new Error("Test 2 Failed: Opted-in user did not receive alert");
  }
  if (telegramNotifications[0].data.telegramId !== "11111" || !telegramNotifications[0].data.message.includes("high-confidence")) {
    throw new Error("Test 2 Failed: Delivered message contents are incorrect");
  }
  console.log("✅ Test 2 Passed: Alert dispatched successfully to opted-in user.");

  // ========================================================
  // TEST 3: Opt-Out Preference (Alert Blocked)
  // ========================================================
  console.log("\n--- TEST 3: Verifying opt-out preference blocks alert ---");
  telegramNotifications = [];
  mockAlerts.length = 0;

  const res2 = await alertComposerService.sendAlertToUser("user-3-en-disabled", optionsRainfallHigh);
  console.log(`User 3 Dispatch Status: ${res2.status}`);
  console.log(`User 3 Logged Alerts Count: ${mockAlerts.length}`);
  console.log(`Telegram Alerts Sent: ${telegramNotifications.length}`);

  if (res2.status !== "opted_out" || mockAlerts.length !== 1 || telegramNotifications.length !== 0) {
    throw new Error("Test 3 Failed: Alert sent to opted-out user");
  }
  console.log("✅ Test 3 Passed: Opt-out preference blocked alert delivery.");

  // ========================================================
  // TEST 4: Rate-Limiting (4-hour window)
  // ========================================================
  console.log("\n--- TEST 4: Verifying 4-hour rate limit blocks duplicate alerts ---");
  telegramNotifications = [];
  mockAlerts.length = 0;

  // First send - succeeds
  const res3First = await alertComposerService.sendAlertToUser("user-1-en-enabled", optionsRainfallHigh);
  console.log(`1st Dispatch Status: ${res3First.status}`);

  // Second send - must be rate-limited
  const res3Second = await alertComposerService.sendAlertToUser("user-1-en-enabled", optionsRainfallHigh);
  console.log(`2nd Dispatch Status: ${res3Second.status}`);
  console.log(`Total Logged Alerts Count: ${mockAlerts.length}`);
  console.log(`Total Telegram Alerts Sent: ${telegramNotifications.length}`);

  if (res3Second.status !== "rate_limited" || mockAlerts.length !== 2 || telegramNotifications.length !== 1) {
    throw new Error("Test 4 Failed: Rate-limiter did not block duplicate alert");
  }
  console.log("✅ Test 4 Passed: 4-hour rate limit successfully blocked spam.");

  console.log("\n🎉 All R5 Farmer Climate Alerts simulation tests passed successfully!\n");
}

runFarmerAlertComposerTests().catch(err => {
  console.error("❌ Simulation run failed with error:", err);
  process.exit(1);
});

export {};
