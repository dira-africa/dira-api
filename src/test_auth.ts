import Fastify from "fastify";
import crypto from "crypto";
import { env } from "./config/env";
import authRoutes from "./routes/auth";
import jwt from "@fastify/jwt";
import { pool } from "./db/pool";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";

async function runTests() {
  const server = Fastify();
  
  // Register dependencies
  await server.register(jwt, { secret: env.JWT_SECRET });
  await server.register(authPlugin);
  await server.register(databasePlugin);
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

    // 1. Test Valid authentication
    console.log("\n--- TEST 1: Valid Auth ---");
    const validUser = { id: 987654321, first_name: "Dev", last_name: "User", username: "dev_user", language_code: "sw" };
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
    console.log("✅ Valid auth test passed!");

    // 2. Test Decoded JWT
    console.log("\n--- TEST 2: JWT Decoding ---");
    const decoded = server.jwt.verify(payload1.token) as any;
    console.log("Decoded JWT payload:", decoded);
    if (!decoded.id || decoded.role !== "farmer") {
      throw new Error("JWT payload is incorrect or missing properties");
    }
    console.log("✅ JWT decoding test passed!");

    // 3. Test Manipulated initData (Signature check)
    console.log("\n--- TEST 3: Manipulated Auth ---");
    const tamperedInitData = createInitData(Math.floor(Date.now() / 1000), validUser, true);
    const response2 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: tamperedInitData },
    });

    console.log(`Response status: ${response2.statusCode}`);
    console.log("Response body:", response2.payload);

    if (response2.statusCode !== 401) {
      throw new Error(`Expected 401 Unauthorized, got ${response2.statusCode}`);
    }
    console.log("✅ Manipulated auth test passed!");

    // 4. Test Stale initData (auth_date older than 5 mins)
    console.log("\n--- TEST 4: Stale Auth (auth_date > 5 mins old) ---");
    const staleTime = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
    const staleInitData = createInitData(staleTime, validUser);
    const response3 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: staleInitData },
    });

    console.log(`Response status: ${response3.statusCode}`);
    console.log("Response body:", response3.payload);

    if (response3.statusCode !== 401) {
      throw new Error(`Expected 401 Unauthorized (Stale), got ${response3.statusCode}`);
    }
    console.log("✅ Stale auth test passed!");

    // 5. Test Existing User (Upsert check)
    console.log("\n--- TEST 5: Existing User Logins ---");
    const response4 = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: { initData: validInitData }, // Resending same valid token
    });

    console.log(`Response status: ${response4.statusCode}`);
    const payload4 = JSON.parse(response4.payload);
    console.log("Response body isNewUser:", payload4.user.isNewUser);

    if (payload4.user.isNewUser !== false) {
      throw new Error("Expected isNewUser to be false on second login");
    }
    console.log("✅ Existing user login test passed!");

    // 6. Test Audit Log Verification
    console.log("\n--- TEST 6: Audit Log Verification ---");
    const { rows: auditLogs } = await pool.query(
      "SELECT action, ip_address, metadata FROM audit_log ORDER BY created_at ASC"
    );
    console.log("Audit log entries recorded:");
    console.log(JSON.stringify(auditLogs, null, 2));

    // Validating count of logins logged in DB: 2 success and 3 failures (including missing_initData)
    // Actually:
    // 1. Valid auth (Success 1)
    // 2. Manipulated auth (Failure 1)
    // 3. Stale auth (Failure 2)
    // 4. Existing user auth (Success 2)
    if (auditLogs.length < 4) {
      throw new Error(`Expected at least 4 audit log entries, got ${auditLogs.length}`);
    }
    
    const successEvents = auditLogs.filter(log => log.action === 'auth_telegram_success');
    const failureEvents = auditLogs.filter(log => log.action === 'auth_telegram_failure');
    
    if (successEvents.length !== 2 || failureEvents.length !== 2) {
      throw new Error(`Expected 2 successes and 2 failures in audit log, got ${successEvents.length} successes and ${failureEvents.length} failures`);
    }
    console.log("✅ Audit log test passed!");

    console.log("\n⭐️ ALL AUTHENTICATION INTEGRATION TESTS PASSED SUCCESSFULLY! ⭐️");
  } catch (err) {
    console.error("❌ Authentication test suite failed:", err);
    process.exit(1);
  } finally {
    await server.close();
  }
}

runTests();
