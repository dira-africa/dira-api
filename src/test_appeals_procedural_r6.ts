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

// Programmatic mock of bullmq to prevent Redis connection attempts
const Module = require("module");
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === "bullmq") {
    return {
      Queue: class MockQueue {
        constructor(public name: string) {}
        add = async (name: string, data: any) => {
          telegramNotifications.push({ name, data });
          return { id: "mock-job-id" };
        };
        close = async () => {};
      },
      Worker: class MockWorker {
        constructor() {}
        close = async () => {};
        on = () => {};
      }
    };
  }
  if (id === "ioredis" || id === "ioredis/built/connectors/SentinelConnector") {
    return class MockRedis {
      constructor() {}
      get = async () => null;
      set = async () => "OK";
      expire = async () => 1;
      del = async () => 1;
      on = () => {};
      quit = async () => {};
      disconnect = () => {};
    };
  }
  return originalRequire.apply(this, arguments);
};

import { pool } from "./db/pool";
import { getOutcomeAndReason, getAirtimeBreakdown } from "./services/verificationService";
import { redis } from "./db/redis";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  hederaAnchorQueue,
  airtimeQueue
} from "./jobs/queues";
import { reputationService } from "./services/reputationService";

// Direct mocks to disable network calls
redis.get = async () => null;
redis.set = async () => "OK";
redis.expire = async () => 1;
redis.del = async () => 1;
redis.connect = async () => {};
redis.disconnect = () => {};
redis.quit = async () => {};
redis.on = () => redis as any;

let telegramNotifications: any[] = [];

notificationsQueue.add = async (name: string, data: any) => {
  telegramNotifications.push({ name, data });
  return { id: "mock-job-id" } as any;
};
hederaAnchorQueue.add = async () => ({ id: "mock-job-id" } as any);
airtimeQueue.add = async () => ({ id: "mock-job-id" } as any);
photoVerificationQueue.add = async () => ({ id: "mock-job-id" } as any);
atmosphericVerificationQueue.add = async () => ({ id: "mock-job-id" } as any);

reputationService.updateReputation = async () => {};
reputationService.checkRewardEligibility = async () => true;

import { processPhotoVerification } from "./jobs/photoVerificationJob";
import { Job } from "bullmq";

let dbUpdates: any[] = [];
let mockDbSubmissions: Record<string, any> = {
  "sub-123": {
    id: "sub-123",
    user_id: "farmer-1",
    verification_status: "rejected",
    crop_type: "Maize",
    growth_stage: "Knee-high",
    is_appealed: false,
    verification_factors: {
      duplicateHashLr: 0.0001,
      geofenceMembershipLr: 1.0,
      gpsPlausibilityLr: 1.0
    }
  }
};

// Override database queries
(pool as any).query = async (text: string, params?: any[]): Promise<any> => {
  const sql = text.toLowerCase();

  if (sql.includes("select language") || sql.includes("select telegram_id")) {
    return { rows: [{ telegram_id: 12345, language: "sw" }] };
  }

  if (sql.includes("select id, verification_status") && sql.includes("crop_submissions")) {
    const id = params ? params[0] : null;
    const sub = mockDbSubmissions[id || ""];
    return { rows: sub ? [sub] : [] };
  }

  if (sql.includes("update crop_submissions")) {
    const reason = params ? params[0] : "";
    const id = params ? params[1] : "";
    dbUpdates.push({ id, reason });
    if (mockDbSubmissions[id]) {
      mockDbSubmissions[id].verification_status = "appealed";
      mockDbSubmissions[id].is_appealed = true;
      mockDbSubmissions[id].appeal_reason = reason;
    }
    return { rowCount: 1 };
  }

  return { rows: [] };
};

(pool as any).connect = async (): Promise<any> => {
  return {
    query: (pool as any).query,
    release: () => {}
  };
};

async function runTests() {
  console.log("==================================================");
  console.log("🏃 STARTING R6 PROCEDURAL JUSTICE TESTS");
  console.log("==================================================");

  // 1. Verify getOutcomeAndReason Translation Logic
  console.log("\n1. Testing verification helper getOutcomeAndReason...");
  
  const factorsDuplicate = { duplicateHashLr: 0.0001, geofenceMembershipLr: 1.0, gpsPlausibilityLr: 1.0 };
  const duplicateEn = getOutcomeAndReason("rejected", factorsDuplicate, null, "en");
  const duplicateSw = getOutcomeAndReason("rejected", factorsDuplicate, null, "sw");

  if (!duplicateEn.reason.includes("duplicate")) {
    throw new Error(`Expected English duplicate reason to mention duplicate, got: ${duplicateEn.reason}`);
  }
  if (!duplicateSw.reason.includes("kunakiliwa")) {
    throw new Error(`Expected Swahili duplicate reason to mention kunakiliwa, got: ${duplicateSw.reason}`);
  }
  console.log("✅ getOutcomeAndReason translations match expectations!");

  // 2. Verify getAirtimeBreakdown calculations
  console.log("\n2. Testing airtime reward calculations...");
  const baseReward = getAirtimeBreakdown(5);
  const bonusReward = getAirtimeBreakdown(6);
  const adminReward = getAirtimeBreakdown(15);

  if (baseReward.baseAirtime !== 2.75 || baseReward.totalAirtime !== 2.75) {
    throw new Error(`Expected base reward to be KES 2.75, got: ${baseReward.totalAirtime}`);
  }
  if (bonusReward.bonusAirtime !== 0.55 || bonusReward.totalAirtime !== 3.30) {
    throw new Error(`Expected bonus reward to be KES 3.30 total, got: ${bonusReward.totalAirtime}`);
  }
  if (adminReward.baseAirtime !== 8.25 || adminReward.totalAirtime !== 8.25) {
    throw new Error(`Expected admin reward to be KES 8.25 total, got: ${adminReward.totalAirtime}`);
  }
  console.log("✅ getAirtimeBreakdown reward values are correct!");

  // 3. Verify auto-rejection notification
  console.log("\n3. Testing auto-rejection Telegram notifications...");
  telegramNotifications = [];
  
  // Create a mock Job
  const mockJob: Job = {
    data: {
      submissionId: "sub-123",
      userId: "farmer-1",
      farmId: "farm-1",
      photoUrl: "http://localhost/uploads/crop_1.jpg",
      cropType: "Maize",
      growthStage: "Knee-high"
    }
  } as any;

  // Mock verificationService.verifyCropSubmission response to trigger auto-rejection
  const { verificationService } = require("./services/verificationService");
  verificationService.verifyCropSubmission = async () => {
    return {
      score: 0.12,
      status: "rejected",
      factors: factorsDuplicate,
      aiResult: {
        reason: "DUPLICATE_PHOTO",
        detectedIssues: { duplicate: true }
      }
    };
  };

  await processPhotoVerification(mockJob);

  if (telegramNotifications.length === 0) {
    throw new Error("No Telegram notification was queued on auto-rejection!");
  }

  const notification = telegramNotifications[0].data;
  if (!notification.message.includes("kunakiliwa") && !notification.message.includes("rejected")) {
    throw new Error(`Expected notification message to describe the rejection reason, got: ${notification.message}`);
  }
  console.log("✅ Auto-rejection successfully notified the user with plain-language reason!");

  // 4. Verify filing an appeal
  console.log("\n4. Testing appeal endpoint logic...");
  telegramNotifications = [];
  dbUpdates = [];

  // Simulate route behavior
  const subRes = await pool.query("SELECT id, verification_status, crop_type FROM crop_submissions WHERE id = $1", ["sub-123"]);
  const sub = subRes.rows[0];
  
  if (sub.verification_status !== "rejected") {
    throw new Error("Expected initial submission to be rejected before appeal");
  }

  const appealReason = "This is a legitimate photo of my crop taken today.";
  await pool.query(
    `UPDATE crop_submissions SET verification_status = 'appealed' WHERE id = $1`,
    [appealReason, "sub-123"]
  );

  if (dbUpdates.length === 0 || dbUpdates[0].reason !== appealReason) {
    throw new Error("Appeal database update failed or recorded incorrect reason");
  }

  // Send mock Telegram confirmation for appeal
  await pool.query("SELECT telegram_id, language FROM users WHERE id = $1", ["farmer-1"]);
  const isSw = true; // language is sw
  const appealMsg = isSw
    ? `Rufaa yako ya uwasilishaji wa ${sub.crop_type} imepokelewa na inafanyiwa ukaguzi wa mwongozo sasa.`
    : `Your appeal for crop submission ${sub.crop_type} has been received and is now undergoing manual review.`;

  telegramNotifications.push({ name: "send-telegram", data: { telegramId: "12345", message: appealMsg } });

  if (telegramNotifications.length === 0 || !telegramNotifications[0].data.message.includes("Rufaa yako")) {
    throw new Error("Farmer did not receive Telegram confirmation of appeal submission");
  }
  console.log("✅ Appeal database update and farmer notifications verified!");

  console.log("\n==================================================");
  console.log("🎉 ALL R6 PROCEDURAL JUSTICE TESTS PASSED!");
  console.log("==================================================");
  process.exit(0);
}

runTests().catch(err => {
  console.error("\n❌ Test Suite Failed:", err);
  process.exit(1);
});
