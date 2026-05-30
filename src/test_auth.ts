import Fastify from "fastify";
import crypto from "crypto";
import { env } from "./config/env";
import authRoutes from "./routes/auth";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import { errorHandler } from "./middleware/errorHandler";

async function runTests() {
  const server = Fastify();
  
  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  
  server.setErrorHandler(errorHandler);
  
  await server.register(authRoutes, { prefix: "/api/auth" });

  await server.ready();

  const botToken = env.TELEGRAM_BOT_TOKEN; // Defaults to "123456789:placeholder_bot_token"
  
  // Helper to generate initData
  function createInitData(authDate: number, userObj: any, manipulate = false): string {
    const params = new URLSearchParams();
    params.set("auth_date", authDate.toString());
    params.set("user", JSON.stringify(userObj));
    params.set("query_id", "AAHk1234");
    
    // Sort parameters alphabetically
    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map((key) => `${key}=${params.get(key)}`).join("\n");
    
    // Generate signature
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    let hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    
    if (manipulate) {
      // Tamper with the hash
      hash = hash.replace(/^[0-9a-f]/, hash[0] === 'a' ? 'b' : 'a');
    }
    
    params.set("hash", hash);
    return params.toString();
  }

  try {
    console.log("Cleaning up users and audit logs...");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM users WHERE telegram_id = 987654321");

    const validUser = { id: 987654321, first_name: "Dev", last_name: "User", username: "dev_user", language_code: "sw" };

    // 1. Test 1: Valid initData → 200 with JWT and isNewUser: true
    console.log("\n--- TEST 1: Valid initData → 200 ---");
    const validInitData = createInitData(Math.floor(Date.now() / 1000), validUser);
    
    const response1 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: validInitData },
    });

    console.log(`Response status: ${response1.statusCode}`);
    const payload1 = JSON.parse(response1.payload);
    console.log("Response body:", payload1);

    if (response1.statusCode !== 200) {
      throw new Error(`Expected 200 OK, got ${response1.statusCode}`);
    }
    if (!payload1.token) {
      throw new Error("Missing JWT token in response");
    }
    if (payload1.user.isNewUser !== true) {
      throw new Error("Expected isNewUser to be true");
    }
    console.log("✅ Test 1 passed!");

    // 2. JWT Decoding Verification
    console.log("\n--- Verification: JWT Decoding ---");
    const decoded = server.jwt.verify(payload1.token) as any;
    console.log("Decoded JWT payload:", decoded);
    if (!decoded.id || decoded.role !== "farmer") {
      throw new Error("JWT payload is incorrect or missing properties");
    }
    console.log("✅ JWT verification passed!");

    // 3. Test 2: Tampered hash (change one character) → 401 INVALID_TELEGRAM_AUTH
    console.log("\n--- TEST 2: Tampered hash → 401 INVALID_TELEGRAM_AUTH ---");
    const tamperedInitData = createInitData(Math.floor(Date.now() / 1000), validUser, true);
    const response2 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: tamperedInitData },
    });

    console.log(`Response status: ${response2.statusCode}`);
    const payload2 = JSON.parse(response2.payload);
    console.log("Response body:", payload2);

    if (response2.statusCode !== 401) {
      throw new Error(`Expected 401, got ${response2.statusCode}`);
    }
    if (payload2.error.code !== "INVALID_TELEGRAM_AUTH") {
      throw new Error(`Expected code to be INVALID_TELEGRAM_AUTH, got ${payload2.error.code}`);
    }
    console.log("✅ Test 2 passed!");

    // 4. Test 3: Valid initData but auth_date = 6 minutes ago → 401 STALE_TOKEN
    console.log("\n--- TEST 3: Stale auth_date (6 mins old) → 401 STALE_TOKEN ---");
    const staleTime = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
    const staleInitData = createInitData(staleTime, validUser);
    const response3 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: staleInitData },
    });

    console.log(`Response status: ${response3.statusCode}`);
    const payload3 = JSON.parse(response3.payload);
    console.log("Response body:", payload3);

    if (response3.statusCode !== 401) {
      throw new Error(`Expected 401, got ${response3.statusCode}`);
    }
    if (payload3.error.code !== "STALE_TOKEN") {
      throw new Error(`Expected code to be STALE_TOKEN, got ${payload3.error.code}`);
    }
    console.log("✅ Test 3 passed!");

    // 5. Test 4: 11 requests in 1 minute to /auth/telegram from same IP → 429
    console.log("\n--- TEST 4: Rate limit testing (11 requests in 1 minute) ---");
    
    // We already made 3 requests so far in the script from the same IP (default 127.0.0.1 for inject).
    // Let's reset the audit log and rate limit store to keep it clean, OR just make 11 rapid requests right now.
    // Clean up audit logs first so we can count them exactly for Test 5.
    await pool.query("DELETE FROM audit_log");
    
    // Note: server.inject uses ip '127.0.0.1' by default. We make 11 requests in a loop.
    let rateLimitedResponse = null;
    let rateLimitTriggered = false;

    console.log("Sending 11 rapid requests...");
    for (let i = 1; i <= 11; i++) {
      const initDataLoop = createInitData(Math.floor(Date.now() / 1000), validUser);
      const res = await server.inject({
        method: "POST",
        url: "/api/auth/telegram",
        payload: { initData: initDataLoop },
      });
      
      console.log(`  Request #${i} status: ${res.statusCode}`);
      if (res.statusCode === 429) {
        rateLimitTriggered = true;
        rateLimitedResponse = JSON.parse(res.payload);
      }
    }

    if (!rateLimitTriggered) {
      throw new Error("Expected at least one request to be rate-limited with 429, but all succeeded!");
    }
    
    console.log("Rate limited response body:", rateLimitedResponse);
    if (rateLimitedResponse.error.code !== "TOO_MANY_REQUESTS") {
      throw new Error(`Expected error code TOO_MANY_REQUESTS, got ${rateLimitedResponse.error.code}`);
    }
    console.log("✅ Test 4 passed!");

    // 6. Test 5: All 11 attempts visible in audit_log with correct IP addresses
    console.log("\n--- TEST 5: Verify all 11 attempts logged in audit_log ---");
    
    // Wait 500ms for asynchronous fire-and-forget DB logs from rate limiter error handler to complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { rows: auditLogs } = await pool.query(
      "SELECT action, ip_address, metadata FROM audit_log ORDER BY created_at ASC"
    );
    console.log(`Audit log count: ${auditLogs.length}`);
    console.log(JSON.stringify(auditLogs, null, 2));

    if (auditLogs.length !== 11) {
      throw new Error(`Expected exactly 11 audit log entries, got ${auditLogs.length}`);
    }

    // Verify all logged entries have correct IP address
    for (const log of auditLogs) {
      if (log.ip_address !== "127.0.0.1") {
        throw new Error(`Expected IP address 127.0.0.1, got ${log.ip_address}`);
      }
    }

    const successLogs = auditLogs.filter(l => l.action === "auth_telegram_success");
    const failureLogs = auditLogs.filter(l => l.action === "auth_telegram_failure");

    // Since we cleared logs before the 11-request loop, we expect exactly 7 successes and 4 failures (due to rate limit)
    if (successLogs.length !== 7 || failureLogs.length !== 4) {
      throw new Error(
        `Expected 7 successes and 4 failures (rate limit) in audit log, got ${successLogs.length} successes and ${failureLogs.length} failures`
      );
    }
    
    for (const log of failureLogs) {
      if (log.metadata.reason !== "rate_limited") {
        throw new Error(`Expected failure reason to be rate_limited, got ${log.metadata.reason}`);
      }
    }

    console.log("✅ Test 5 passed!");

    console.log("\n⭐️ ALL AUTHENTICATION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Authentication test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
