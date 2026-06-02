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
import jwt from "@fastify/jwt";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import adminAuthRoutes from "./routes/adminAuth";
import adminRoutes from "./routes/admin";
import { pool } from "./db/pool";
import { redis } from "./db/redis";
import { env } from "./config/env";
import bcryptjs from "bcryptjs";
import fp from "fastify-plugin";

async function runTests() {
  const server = Fastify({
    logger: { level: "warn" }
  });

  // Register plugins matching server.ts setup
  await server.register(jwt, { secret: env.JWT_SECRET });
  
  const adminJwtPlugin = (inst: any, opts: any, next: any) => {
    return jwt(inst, opts, next);
  };
  await server.register(fp(adminJwtPlugin), {
    secret: env.JWT_SECRET + "_admin_hardened",
    namespace: "admin"
  });
  await server.register(authPlugin);
  await server.register(databasePlugin);
  await server.register(adminAuthRoutes, { prefix: "/api/admin/auth" });
  await server.register(adminRoutes, { prefix: "/api/admin" });

  await server.ready();

  const testEmail = "test_admin_spec@dira.africa";
  const testPassword = "SuperSecurePassword123!@#";

  try {
    console.log("Cleaning up previous test admin data...");
    await pool.query("DELETE FROM audit_log");
    await pool.query("DELETE FROM users WHERE email = $1", [testEmail]);

    console.log("Seeding test admin user with bcrypt cost factor 12...");
    const pwdHash = await bcryptjs.hash(testPassword, 12);
    await pool.query(
      `INSERT INTO users (email, password_hash, role, full_name, language)
       VALUES ($1, $2, 'admin', 'Test Administrator', 'en')`,
      [testEmail, pwdHash]
    );

    console.log("\n--- TEST 1: POST /api/admin/auth/login - Invalid Email Timing Protection ---");
    const startTime = Date.now();
    const invalidEmailRes = await server.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      payload: { email: "non_existent_admin@dira.africa", password: "someRandomPassword" }
    });
    const duration = Date.now() - startTime;
    console.log("Response Status:", invalidEmailRes.statusCode);
    console.log("Timing Duration (ms):", duration);
    const invalidEmailBody = JSON.parse(invalidEmailRes.payload);
    console.log("Response Body:", invalidEmailBody);

    if (invalidEmailRes.statusCode !== 401 || invalidEmailBody.error.code !== "INVALID_CREDENTIALS") {
      throw new Error("Invalid email test failed.");
    }
    // Bcrypt comparison on cost factor 12 should take a minimum of ~100-300ms
    if (duration < 80) {
      throw new Error(`Timing attack countermeasure failed. Duration was too fast: ${duration}ms`);
    }
    console.log("✅ Test 1 passed (Timing protection active)!");

    console.log("\n--- TEST 2: Wrong Password & Incremental Failure Lockout ---");
    // Attempt 1 to 4: Failures should increment count but not lock
    for (let attempt = 1; attempt <= 4; attempt++) {
      console.log(`Sending failed attempt #${attempt}...`);
      const wrongPwdRes = await server.inject({
        method: "POST",
        url: "/api/admin/auth/login",
        payload: { email: testEmail, password: "WrongPasswordAttempts" }
      });
      if (wrongPwdRes.statusCode !== 401) {
        throw new Error(`Expected 401 on failed attempt #${attempt}, got ${wrongPwdRes.statusCode}`);
      }
    }

    // Verify count in database is 4
    const dbCheck1 = await pool.query("SELECT failed_login_attempts, locked_until FROM users WHERE email = $1", [testEmail]);
    console.log("Current DB attempts count:", dbCheck1.rows[0].failed_login_attempts);
    if (dbCheck1.rows[0].failed_login_attempts !== 4 || dbCheck1.rows[0].locked_until !== null) {
      throw new Error("Database attempts count mismatch after 4 failures.");
    }

    // Attempt 5: Failure should trigger lockout
    console.log("Sending failed attempt #5 (should lock)...");
    const lockRes = await server.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      payload: { email: testEmail, password: "WrongPasswordAttempts" }
    });
    console.log("Attempt #5 Status:", lockRes.statusCode);
    const lockBody = JSON.parse(lockRes.payload);
    console.log("Attempt #5 Response:", lockBody);

    // Verify lockout active in database
    const dbCheck2 = await pool.query("SELECT failed_login_attempts, locked_until FROM users WHERE email = $1", [testEmail]);
    console.log("DB status after 5th attempt: attempts =", dbCheck2.rows[0].failed_login_attempts, ", locked_until =", dbCheck2.rows[0].locked_until);
    if (!dbCheck2.rows[0].locked_until) {
      throw new Error("Account was not locked in database after 5 failed attempts.");
    }

    // Try a login while locked (should fail with account locked error immediately)
    console.log("Attempting login while account is locked...");
    const lockedAttemptRes = await server.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      payload: { email: testEmail, password: testPassword } // Correct password but account is locked
    });
    console.log("Locked Attempt Status:", lockedAttemptRes.statusCode);
    const lockedAttemptBody = JSON.parse(lockedAttemptRes.payload);
    console.log("Locked Attempt Response:", lockedAttemptBody);
    if (lockedAttemptRes.statusCode !== 401 || lockedAttemptBody.error.code !== "ACCOUNT_LOCKED") {
      throw new Error("Lockout failed to block correct credentials.");
    }

    // Verify audit log has the locked attempt logged
    const logsRes = await pool.query("SELECT action FROM audit_log WHERE action = 'admin_login_locked_attempt'");
    console.log("Audit log verify count for locked attempt:", logsRes.rows.length);
    if (logsRes.rows.length === 0) {
      throw new Error("Locked login attempt was not registered in audit_log.");
    }
    console.log("✅ Test 2 passed (Account lockout and lock attempts verified)!");

    console.log("\n--- TEST 3: Account Unlock & Successful Login ---");
    // Manually unlock the account in the database for test progression
    await pool.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE email = $1", [testEmail]);

    // Perform successful login
    const loginRes = await server.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      payload: { email: testEmail, password: testPassword }
    });
    console.log("Success Login Status:", loginRes.statusCode);
    const loginBody = JSON.parse(loginRes.payload);
    if (loginRes.statusCode !== 200 || !loginBody.success || !loginBody.token) {
      throw new Error("Failed to log in with correct credentials.");
    }
    const adminToken = loginBody.token;
    console.log("Returned Admin Token:", adminToken.substring(0, 30) + "...");

    // Decrypt/verify JWT token claims (verify expiration is 2h)
    const decoded: any = server.jwt.admin.verify(adminToken);
    console.log("Decoded Token Payload:", decoded);
    const lifeDurationInSeconds = decoded.exp - decoded.iat;
    console.log("JWT Life duration (seconds):", lifeDurationInSeconds); // Should be exactly 7200s (2h)
    if (lifeDurationInSeconds !== 7200) {
      throw new Error(`Expected JWT life duration to be 7200 seconds (2h), got ${lifeDurationInSeconds}`);
    }

    // Check if Redis session exists
    const redisSession = await redis.get(`dira:admin:session:${decoded.id}`);
    console.log("Redis session status:", redisSession);
    if (redisSession !== "active") {
      throw new Error("Active Redis session key was not registered.");
    }
    console.log("✅ Test 3 passed (Successful login and token expiration claims verified)!");

    console.log("\n--- TEST 4: Access Gated Admin Routes ---");
    // Request without token (should fail with 403)
    const noTokenRes = await server.inject({
      method: "GET",
      url: "/api/admin/stats"
    });
    console.log("No Token Status:", noTokenRes.statusCode);
    if (noTokenRes.statusCode !== 403) {
      throw new Error(`Expected 403 for unauthorized endpoint access, got ${noTokenRes.statusCode}`);
    }

    // Request with regular user token (should fail with 403)
    const regularUserToken = server.jwt.sign({ id: decoded.id, role: "farmer" }, { expiresIn: "7d" });
    const userTokenRes = await server.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { Authorization: `Bearer ${regularUserToken}` }
    });
    console.log("Regular User Token Status:", userTokenRes.statusCode);
    if (userTokenRes.statusCode !== 403) {
      throw new Error(`Expected 403 when using regular user JWT on admin route, got ${userTokenRes.statusCode}`);
    }

    // Request with valid admin token (should succeed with 200)
    const validRes = await server.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log("Valid Admin Token Status:", validRes.statusCode);
    const validBody = JSON.parse(validRes.payload);
    console.log("Response:", validBody);
    if (validRes.statusCode !== 200 || !validBody.success) {
      throw new Error("Admin authentication blocked a valid admin JWT.");
    }

    // Verify audit logging for view stats action
    await new Promise(resolve => setTimeout(resolve, 200));
    const auditStatsRes = await pool.query(
      "SELECT action, user_id FROM audit_log WHERE action = 'view_stats'"
    );
    console.log("Audit records for view_stats:", auditStatsRes.rows);
    if (auditStatsRes.rows.length === 0 || auditStatsRes.rows[0].user_id !== decoded.id) {
      throw new Error("Automatic audit log action hook was not successfully triggered.");
    }
    console.log("✅ Test 4 passed (Gated routes security and automated audit logging verified)!");

    console.log("\n--- TEST 5: Session Inactivity Timeout ---");
    // Simulate inactivity by deleting the Redis session key manually
    console.log("Simulating 2h inactivity timeout (deleting Redis session)...");
    await redis.del(`dira:admin:session:${decoded.id}`);

    // Call gated endpoint again (should reject with 403 due to inactivity)
    const inactiveRes = await server.inject({
      method: "GET",
      url: "/api/admin/stats",
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log("Inactive Session Request Status:", inactiveRes.statusCode);
    const inactiveBody = JSON.parse(inactiveRes.payload);
    console.log("Inactive Session Request Response:", inactiveBody);
    if (inactiveRes.statusCode !== 403 || inactiveBody.error.message.indexOf("expired due to inactivity") === -1) {
      throw new Error("Failed to block request after session inactivity timeout.");
    }
    console.log("✅ Test 5 passed (Session inactivity timeout verified)!");

    console.log("\n⭐️ ALL ADMIN AUTHENTICATION AND ACCESS CONTROL INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Admin authentication test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
    try {
      await redis.quit();
    } catch (e) {
      // Ignore redis quit failure
    }
    process.exit(0);
  }
}

runTests();
