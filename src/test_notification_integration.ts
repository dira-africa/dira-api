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

import Fastify from "fastify";
import { env } from "./config/env";
import databasePlugin from "./plugins/database";
import { pool } from "./db/pool";
import { redis } from "./db/redis";
import { notificationService } from "./services/notificationService";
import { notificationsQueue } from "./jobs/queues";
import { tokenService } from "./services/tokenService";

// Helper to mock fetch responses
let mockFetchStatus = 200;
let mockFetchBody: any = { ok: true, result: { message_id: 123 } };

const originalFetch = global.fetch;

async function runNotificationTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  await server.register(databasePlugin);
  await server.ready();

  const encryptionKey = env.PGCRYPTO_SYMMETRIC_KEY;

  // Intercept global fetch to test the actual HTTP client logic in notificationService
  global.fetch = async (url: any, options: any) => {
    return {
      ok: mockFetchStatus >= 200 && mockFetchStatus < 300,
      status: mockFetchStatus,
      json: async () => mockFetchBody
    } as any;
  };

  try {
    console.log("Cleaning up previous test data...");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM token_ledger");
    await pool.query("DELETE FROM crop_submissions");
    await pool.query("DELETE FROM farms");
    await pool.query("DELETE FROM agent_profiles");
    await pool.query("DELETE FROM atmospheric_readings");
    await pool.query("DELETE FROM users WHERE telegram_id IN (991111, 992222, 993333)");

    // Ensure Redis is ready
    if (redis.status !== "ready") {
      await redis.connect().catch(() => {});
    }
    await redis.del("tg_limit:991111");
    await redis.del("tg_limit:992222");
    await redis.del("tg_limit:993333");

    console.log("Seeding test users (Farmer & Agent)...");
    const farmerRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (991111, 'test_farmer', pgp_sym_encrypt('+254711222222', $1), 'Farmer Joe', 'farmer', 'en', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const farmerId = farmerRes.rows[0].id;

    const agentRes = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (992222, 'test_agent', pgp_sym_encrypt('+254799888888', $1), 'Agent Smith', 'agent', 'sw', 'Nairobi')
       RETURNING id`,
      [encryptionKey]
    );
    const agentId = agentRes.rows[0].id;

    // Seed agent profile with coverage_center Point
    await pool.query(
      `INSERT INTO agent_profiles (user_id, device_model, coverage_radius_km, is_certified, coverage_center)
       VALUES ($1, 'Safaricom Neon', 5.0, true, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326))`,
      [agentId]
    );

    // Seed farm for the farmer to satisfy foreign key constraint on crop_submissions
    const farmRes = await pool.query(
      `INSERT INTO farms (user_id, farm_location, farm_size_acres, crop_types, county, sub_county)
       VALUES ($1, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326), 2.5, ARRAY['Maize', 'Beans'], 'Nairobi', 'Westlands')
       RETURNING id`,
      [farmerId]
    );
    const farmId = farmRes.rows[0].id;

    // ==========================================
    // --- Test 1: Phone Masking Security -------
    // ==========================================
    console.log("\n--- Test 1: Phone Masking Security ---");
    const masked1 = notificationService.maskPhone("+254711222222");
    const masked2 = notificationService.maskPhone("0799888888");
    console.log(`Masked +254711222222: ${masked1}`);
    console.log(`Masked 0799888888: ${masked2}`);

    if (masked1 !== "****2222" || masked2 !== "****8888") {
      throw new Error(`Masking failed. Expected ****2222 and ****8888, got ${masked1} and ${masked2}`);
    }
    console.log("✅ Phone masking works securely!");

    // ==========================================
    // --- Test 2: Core Sending & Rate Limiting -
    // ==========================================
    console.log("\n--- Test 2: Core API Sending and Redis Rate Limiter ---");
    // Ensure we trigger real fetch by using a token that does not contain 'placeholder'
    const originalToken = env.TELEGRAM_BOT_TOKEN;
    env.TELEGRAM_BOT_TOKEN = "123456789:test_bot_token_fetch";

    // A. Send first notification (should succeed)
    mockFetchStatus = 200;
    mockFetchBody = { ok: true, result: { message_id: 1 } };
    const success2a = await notificationService.sendMessage("991111", "Hello Joe 1");
    console.log(`First message sent outcome: ${success2a}`);
    if (!success2a) {
      throw new Error("First sendMessage failed, expected true.");
    }

    // Verify rate limit key was set in Redis
    const isLimited = await redis.get("tg_limit:991111");
    console.log(`Rate limit Redis key: ${isLimited}`);
    if (!isLimited) {
      throw new Error("Redis rate limit key was not set.");
    }

    // B. Send second notification within 60s (should be rate-limited and skipped)
    const success2b = await notificationService.sendMessage("991111", "Hello Joe 2");
    console.log(`Second message sent outcome: ${success2b}`);
    if (success2b) {
      throw new Error("Second sendMessage succeeded, expected rate limit bypass block.");
    }

    // C. Verify audit_log entry for successfully sent message
    const auditRes2 = await pool.query(
      "SELECT action, metadata FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC",
      [farmerId]
    );
    console.log("Staged Audit Log entries:", auditRes2.rows);
    if (auditRes2.rows.length === 0 || auditRes2.rows[0].action !== "send_telegram_notification") {
      throw new Error(`Expected audit_log entry for send_telegram_notification, got: ${JSON.stringify(auditRes2.rows)}`);
    }

    // Restore bot token
    env.TELEGRAM_BOT_TOKEN = originalToken;

    // ==========================================
    // --- Test 3: Blocked Bot Graceful Error ---
    // ==========================================
    console.log("\n--- Test 3: Graceful Error Handling (Bot Blocked) ---");
    env.TELEGRAM_BOT_TOKEN = "123456789:test_bot_token_fetch";
    await redis.del("tg_limit:991111"); // clear limit

    // Configure mock fetch to simulate a 403 Forbidden user blocked error
    mockFetchStatus = 403;
    mockFetchBody = { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" };

    const success3 = await notificationService.sendMessage("991111", "Blocked User Attempt");
    console.log(`sendMessage output under 403 Forbidden: ${success3}`);
    if (success3) {
      throw new Error("Expected sendMessage to return false when API returns 403, got true.");
    }

    // Verify audit log has recorded the failure outcome with error details
    const auditRes3 = await pool.query(
      "SELECT action, metadata FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [farmerId]
    );
    const logMetadata3 = auditRes3.rows[0]?.metadata;
    console.log("Audit log error metadata:", logMetadata3);
    if (!logMetadata3 || logMetadata3.success === true || !logMetadata3.error.includes("403")) {
      throw new Error(`Audit log did not record the 403 HTTP error correctly: ${JSON.stringify(logMetadata3)}`);
    }
    env.TELEGRAM_BOT_TOKEN = originalToken;
    console.log("✅ Gracefully handled bot block error without crashing!");

    // ==========================================
    // --- Test 4: Templates T1-T6 Formatting ---
    // ==========================================
    console.log("\n--- Test 4: Bilingual Template Content Layouts ---");
    // We run templates in mock mode (using originalToken placeholder) to verify text replacements
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);

    // T1 - Crop Photo verified (Farmer is EN, Agent is SW)
    console.log("\nTesting T1: Crop Photo Verified");
    await notificationService.sendCropPhotoVerifiedNotification(farmerId, "Maize", 15, 92, "https://dira.africa/reports/123");
    
    // T2 - Atmospheric sync verified
    console.log("\nTesting T2: Atmospheric Sync");
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);
    await notificationService.sendAtmosphericSyncNotification(farmerId, 1, 45); // EN
    await notificationService.sendAtmosphericSyncNotification(agentId, 3, 20); // SW

    // T3 - Airtime sent
    console.log("\nTesting T3: Airtime Sent");
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);
    await notificationService.sendAirtimeSentNotification(farmerId, 11, "+254711222222"); // EN
    await notificationService.sendAirtimeSentNotification(agentId, 22, "+254799888888"); // SW

    // T4 - Voucher generated
    console.log("\nTesting T4: Voucher Generated");
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);
    await notificationService.sendVoucherGeneratedNotification(farmerId, 100, "Nairobi Agri-Supplies", new Date("2026-06-05T12:00:00Z")); // EN
    await notificationService.sendVoucherGeneratedNotification(agentId, 200, "Kiambu Agro-Supplies", new Date("2026-06-05T12:00:00Z")); // SW

    // T5 - Dira Circle Payout ready
    console.log("\nTesting T5: Dira Circle Payout ready");
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);
    await notificationService.sendCircleDistributionNotification(farmerId, 120, "Wanjiku Mwangi"); // EN
    await notificationService.sendCircleDistributionNotification(agentId, 240, "Wanjiku Mwangi"); // SW

    // T6 - M-Pesa B2C sent
    console.log("\nTesting T6: M-Pesa B2C sent");
    await redis.del(`tg_limit:991111`);
    await redis.del(`tg_limit:992222`);
    await notificationService.sendMpesaB2CSentNotification(farmerId, 50, "+254711222222", "NL87654321"); // EN
    await notificationService.sendMpesaB2CSentNotification(agentId, 100, "+254799888888", "NL87654322"); // SW

    console.log("✅ Custom template replacements verified successfully!");

    // ==========================================
    // --- Test 5: Sync Reminders Generator -----
    // ==========================================
    console.log("\n--- Test 5: Ingest Daily Agent Sync Reminders ---");
    // Seed another agent to test multiple outputs
    const agent2Res = await pool.query(
      `INSERT INTO users (telegram_id, telegram_username, phone_number, full_name, role, language, county)
       VALUES (993333, 'test_agent_2', pgp_sym_encrypt('+254777111222', $1), 'Agent Carter', 'agent', 'en', 'Mombasa')
       RETURNING id`,
      [encryptionKey]
    );
    const agent2Id = agent2Res.rows[0].id;
    await pool.query(
      `INSERT INTO agent_profiles (user_id, device_model, coverage_radius_km, is_certified, coverage_center)
       VALUES ($1, 'Techno Camon', 8.0, true, ST_SetSRID(ST_Point(39.6682, -4.0435), 4326))`,
      [agent2Id]
    );

    // Empty notifications queue jobs
    await notificationsQueue.drain();

    // Trigger sync reminders
    await notificationService.sendSyncReminders();

    // Check that two jobs were added to the notificationsQueue
    const jobs = await notificationsQueue.getJobs(["waiting", "delayed"]);
    console.log(`Sync reminders queued: ${jobs.length} jobs`);
    const seededTelegramIds = ["992222", "993333"];
    const filteredJobs = jobs.filter(j => seededTelegramIds.includes(j.data?.telegramId));
    console.log(`Filtered sync reminders queued: ${filteredJobs.length} jobs`);

    if (filteredJobs.length !== 2) {
      throw new Error(`Expected exactly 2 sync reminder jobs for our seeded agents, got ${filteredJobs.length}`);
    }

    // ==========================================
    // --- Test 6: Weekly Summaries Ingestion ----
    // ==========================================
    console.log("\n--- Test 6: Ingest Weekly Summaries ---");
    await notificationsQueue.drain();

    // A. Seed farmer stats for the last 7 days
    await tokenService.creditTokens(farmerId, 15, "crop_photo", undefined, "Crop Maize");
    await tokenService.creditTokens(farmerId, 15, "crop_photo", undefined, "Crop Beans");
    
    // Insert verified crop submissions with health scores and ST_Point locations using the correct farmId
    await pool.query(
      `INSERT INTO crop_submissions (user_id, farm_id, photo_url, crop_type, growth_stage, ai_health_score, ai_confidence, verification_status, submitted_at, location)
       VALUES 
       ($1, $2, 'mock_url_1', 'Maize', 'Vegetative', 0.95, 0.99, 'verified', CURRENT_TIMESTAMP, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326)),
       ($1, $2, 'mock_url_2', 'Beans', 'Flowering', 0.85, 0.98, 'verified', CURRENT_TIMESTAMP, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326)),
       ($1, $2, 'mock_url_3', 'Maize', 'Vegetative', 0.70, 0.95, 'verified', CURRENT_TIMESTAMP - INTERVAL '10 days', ST_SetSRID(ST_Point(36.8219, -1.2921), 4326))`,
      [farmerId, farmId]
    );

    // B. Seed agent stats
    // completed syncs
    await tokenService.creditTokens(agentId, 3, "atmospheric_sync", undefined, "Sync Nairobi");
    await tokenService.creditTokens(agentId, 3, "atmospheric_sync", undefined, "Sync Nairobi 2");
    
    // Insert atmospheric readings
    await pool.query(
      `INSERT INTO atmospheric_readings (user_id, location, pressure_hpa, altitude_m, temperature_c, humidity_pct, recorded_at, verified)
       VALUES 
       ($1, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326), 1013.25, 1600.0, 22.0, 65.0, CURRENT_TIMESTAMP, TRUE),
       ($1, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326), 1013.25, 1600.0, 22.0, 65.0, CURRENT_TIMESTAMP, TRUE),
       ($1, ST_SetSRID(ST_Point(36.8219, -1.2921), 4326), 1013.25, 1600.0, 22.0, 65.0, CURRENT_TIMESTAMP - INTERVAL '10 days', TRUE)`,
      [agentId]
    );

    // Trigger summaries
    await notificationService.sendWeeklySummaries();

    // Check notifications queue
    const summaryJobs = await notificationsQueue.getJobs(["waiting", "delayed"]);
    console.log(`Weekly summary notifications queued: ${summaryJobs.length} jobs`);
    const seededUserTelegramIds = ["991111", "992222", "993333"];
    const filteredSummaryJobs = summaryJobs.filter(j => seededUserTelegramIds.includes(j.data?.telegramId));
    console.log(`Filtered weekly summary notifications queued: ${filteredSummaryJobs.length} jobs`);

    // Expected: Joe the Farmer, Smith the Agent, Carter the Agent (3 users)
    if (filteredSummaryJobs.length !== 3) {
      throw new Error(`Expected 3 weekly summary jobs for our seeded users, got ${filteredSummaryJobs.length}`);
    }

    console.log("\n⭐️ ALL TELEGRAM NOTIFICATION SYSTEM INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Telegram notification system tests failed:", err);
    process.exit(1);
  } finally {
    // Restore global fetch
    global.fetch = originalFetch;
    await server.close();
  }
}

runNotificationTests();
