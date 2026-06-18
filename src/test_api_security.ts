import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import { pool } from "./db/pool";
import { query } from "./db/query";
import { redis } from "./db/redis";

// Import routes
import publicRoutes from "./routes/public";
import authRoutes from "./routes/auth";
import tokensRoutes from "./routes/tokens";
import adminRoutes from "./routes/admin";
import adminAuthRoutes from "./routes/adminAuth";
import cropSubmissionsRoutes from "./routes/cropSubmissions";
import atmosphericRoutes from "./routes/atmospheric";

async function runTests() {
  console.log("🚀 Starting API Security Test Suite...");

  // Build server with 1MB body limit exactly like server.ts
  const server = Fastify({
    bodyLimit: 1048576, // 1MB
  });

  server.setErrorHandler(errorHandler);

  // 1. Register Helmet
  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://*.r2.cloudflarestorage.com"],
      },
    },
    frameguard: {
      action: "deny",
    },
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  });

  // 2. Register CORS
  await server.register(cors, {
    origin: ["https://app.diraafrica.com", "http://localhost:3000"],
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400,
  });

  // 3. Register global rate limiter (100 req/min/IP)
  await server.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    hook: "preValidation",
    errorResponseBuilder: (request, context) => {
      const error = new Error("Rate limit exceeded. Please try again later. / Umefikia kikomo cha maombi. Tafadhali jaribu tena baadaye.") as any;
      error.statusCode = 429;
      return error;
    },
  });

  // 4. Register JWT plugins
  await server.register(jwt, { secret: env.JWT_SECRET });
  // Register separate admin JWT namespace
  await server.register(fp(async (instance) => {
    await instance.register(jwt, {
      secret: process.env.ADMIN_JWT_SECRET || (env.JWT_SECRET + "_admin_hardened"),
      namespace: "admin",
    });
  }));
  await server.register(authPlugin);
  await server.register(databasePlugin);

  // 5. Register Routes
  await server.register(publicRoutes);
  await server.register(authRoutes, { prefix: "/api/auth" });
  await server.register(tokensRoutes, { prefix: "/api/tokens" });
  await server.register(adminAuthRoutes, { prefix: "/api/admin/auth" });
  await server.register(adminRoutes, { prefix: "/api/admin" });
  await server.register(cropSubmissionsRoutes, { prefix: "/api/crop-submissions" });
  await server.register(atmosphericRoutes, { prefix: "/api/atmospheric" });

  // Expose security.txt
  server.get("/.well-known/security.txt", async (request, reply) => {
    return reply.type("text/plain").send("Contact: security@diraafrica.com\n");
  });

  await server.ready();

  try {
    // ----------------------------------------------------
    // TEST 1: Global Rate Limiting (100 requests in 1 minute)
    // ----------------------------------------------------
    console.log("\n--- TEST 1: Global Rate Limiting ---");
    let rateLimited = false;
    let rateLimitMsg = "";
    let retryAfterHeader = "";

    // Send 101 requests to /health
    for (let i = 1; i <= 101; i++) {
      const res = await server.inject({
        method: "GET",
        url: "/health",
        // Force remoteAddress to be same IP to simulate client
        remoteAddress: "192.168.1.1",
      });

      if (res.statusCode === 429) {
        rateLimited = true;
        const body = JSON.parse(res.payload);
        rateLimitMsg = body.error.message;
        retryAfterHeader = res.headers["retry-after"] as string || res.headers["Retry-After"] as string || "";
        console.log(`Rate limit hit on request #${i} as expected!`);
        break;
      }
    }

    if (!rateLimited) {
      throw new Error("Global Rate Limit failed: expected 429 status code on 101st request but all succeeded.");
    }

    if (!rateLimitMsg.includes("Rate limit exceeded") || !rateLimitMsg.includes("Umefikia kikomo")) {
      throw new Error(`Expected bilingual 429 message, got: "${rateLimitMsg}"`);
    }

    if (!retryAfterHeader) {
      throw new Error("Expected Retry-After header to be present on 429 response.");
    }

    console.log("✅ Global Rate Limit test passed!");
    console.log(`  Message: ${rateLimitMsg}`);
    console.log(`  Retry-After: ${retryAfterHeader}s`);


    // ----------------------------------------------------
    // TEST 2: CORS Verification
    // ----------------------------------------------------
    console.log("\n--- TEST 2: CORS Verification ---");
    
    // a. Allowed Origin Options Request
    const corsAllowedRes = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
      },
    });
    
    if (corsAllowedRes.headers["access-control-allow-origin"] !== "http://localhost:3000") {
      throw new Error(`Expected Access-Control-Allow-Origin to be http://localhost:3000, got ${corsAllowedRes.headers["access-control-allow-origin"]}`);
    }
    if (corsAllowedRes.headers["access-control-allow-credentials"] !== "true") {
      throw new Error("Expected Access-Control-Allow-Credentials to be true");
    }
    if (corsAllowedRes.headers["access-control-max-age"] !== "86400") {
      throw new Error(`Expected Access-Control-Max-Age to be 86400, got ${corsAllowedRes.headers["access-control-max-age"]}`);
    }

    // b. Disallowed Origin Request
    const corsDisallowedRes = await server.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        Origin: "http://evil.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    if (corsDisallowedRes.headers["access-control-allow-origin"] === "http://evil.com" || corsDisallowedRes.headers["access-control-allow-origin"] === "*") {
      throw new Error(`CORS security flaw: Allowed non-whitelisted origin http://evil.com or wildcard. Header: ${corsDisallowedRes.headers["access-control-allow-origin"]}`);
    }

    console.log("✅ CORS test passed!");


    // ----------------------------------------------------
    // TEST 3: Security Headers via @fastify/helmet
    // ----------------------------------------------------
    console.log("\n--- TEST 3: Security Headers Verification ---");
    const headerRes = await server.inject({
      method: "GET",
      url: "/health",
    });

    const csp = headerRes.headers["content-security-policy"] as string;
    const xfo = headerRes.headers["x-frame-options"] as string;
    const xcto = headerRes.headers["x-content-type-options"] as string;
    const rp = headerRes.headers["referrer-policy"] as string;

    if (!csp || !csp.includes("default-src 'self'") || !csp.includes("https://*.r2.cloudflarestorage.com")) {
      throw new Error(`Invalid CSP header: ${csp}`);
    }

    if (xfo !== "DENY") {
      throw new Error(`Expected X-Frame-Options: DENY, got: ${xfo}`);
    }

    if (xcto !== "nosniff") {
      throw new Error(`Expected X-Content-Type-Options: nosniff, got: ${xcto}`);
    }

    if (rp !== "strict-origin-when-cross-origin") {
      throw new Error(`Expected Referrer-Policy: strict-origin-when-cross-origin, got: ${rp}`);
    }

    console.log("✅ Security Headers test passed!");


    // ----------------------------------------------------
    // TEST 4: Request Size Limit (1MB JSON)
    // ----------------------------------------------------
    console.log("\n--- TEST 4: Request Size Limits ---");
    
    // Create large payload slightly larger than 1MB
    const largeStr = "a".repeat(1.1 * 1024 * 1024);
    const oversizedJsonRes = await server.inject({
      method: "POST",
      url: "/api/auth/telegram",
      payload: {
        initData: largeStr
      }
    });

    if (oversizedJsonRes.statusCode !== 413) {
      throw new Error(`Expected 413 Payload Too Large for oversized JSON, got status code: ${oversizedJsonRes.statusCode}`);
    }

    console.log("✅ JSON 1MB limit test passed! (Returned 413)");


    // ----------------------------------------------------
    // TEST 5: File Upload size limit (10MB limit)
    // ----------------------------------------------------
    console.log("\n--- TEST 5: File Upload Limits ---");

    // Put a small file (1KB) and verify it does NOT trigger 413 (might return 500/400 due to test env or succeed, but not 413)
    const smallFile = Buffer.alloc(1024);
    const smallFileRes = await server.inject({
      method: "PUT",
      url: "/api/crop-submissions/upload/test_small.jpg",
      payload: smallFile,
      headers: {
        "content-type": "image/jpeg"
      }
    });

    if (smallFileRes.statusCode === 413) {
      throw new Error("Small file upload unexpectedly triggered 413 Payload Too Large");
    }

    // Put an oversized file (10.1MB) and verify 413
    const largeFile = Buffer.alloc(10.1 * 1024 * 1024);
    const oversizedFileRes = await server.inject({
      method: "PUT",
      url: "/api/crop-submissions/upload/test_large.jpg",
      payload: largeFile,
      headers: {
        "content-type": "image/jpeg"
      }
    });

    if (oversizedFileRes.statusCode !== 413) {
      throw new Error(`Expected 413 Payload Too Large for oversized upload (>10MB), got status code: ${oversizedFileRes.statusCode}`);
    }

    console.log("✅ File Upload 10MB limit test passed! (Returned 413)");


    // ----------------------------------------------------
    // TEST 6: security.txt
    // ----------------------------------------------------
    console.log("\n--- TEST 6: security.txt Verification ---");
    const securityTxtRes = await server.inject({
      method: "GET",
      url: "/.well-known/security.txt",
    });

    if (securityTxtRes.statusCode !== 200) {
      throw new Error(`Expected security.txt to return 200, got ${securityTxtRes.statusCode}`);
    }

    if (!String(securityTxtRes.headers["content-type"]).startsWith("text/plain")) {
      throw new Error(`Expected content-type text/plain, got: ${securityTxtRes.headers["content-type"]}`);
    }

    if (!securityTxtRes.payload.includes("Contact: security@diraafrica.com")) {
      throw new Error(`Expected security.txt contact info, got: ${securityTxtRes.payload}`);
    }

    console.log("✅ security.txt test passed!");


    // ----------------------------------------------------
    // TEST 7: Route-Specific Rate Limits (Tokens Redeem 3/hour/userId Group)
    // ----------------------------------------------------
    console.log("\n--- TEST 7: tokens/redeem Route-Specific Rate Limit ---");
    
    // Generate valid auth token
    const testUserId = "9b6a18cb-7e3e-4fb7-872f-530e2f5b61cc"; // sample uuid
    // Insert temporary user to database for foreign key constraint bypass if needed, or bypass db inside token service
    await pool.query("INSERT INTO users (id, telegram_id, full_name, role, language) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [
      testUserId, 999111, "Test User", "farmer", "en"
    ]);

    const userToken = server.jwt.sign({ id: testUserId, role: "farmer" });

    let tokenLimitHit = false;
    let tokenLimitHeader = "";

    // Call redeem endpoint 4 times from the same user ID to trigger rate limit (max: 3)
    for (let i = 1; i <= 4; i++) {
      const res = await server.inject({
        method: "POST",
        url: "/api/tokens/redeem/airtime",
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
        payload: {
          token_amount: 30,
          phone_number: "0712345678"
        }
      });

      if (res.statusCode === 429) {
        tokenLimitHit = true;
        tokenLimitHeader = res.headers["retry-after"] as string || res.headers["Retry-After"] as string || "";
        console.log(`Redeem limit hit on request #${i} as expected!`);
        break;
      }
    }

    if (!tokenLimitHit) {
      throw new Error("Redemption Rate Limit failed: expected 429 status code on 4th request but all succeeded.");
    }
    
    if (!tokenLimitHeader) {
      throw new Error("Expected Retry-After header on route-level 429");
    }

    console.log("✅ Tokens Redeem Route-Specific Rate Limit test passed!");


    // ----------------------------------------------------
    // TEST 8: /admin/* Scope-Specific Rate Limit (30/min/IP)
    // ----------------------------------------------------
    console.log("\n--- TEST 8: /admin/* Scope-Specific Rate Limit ---");
    
    // Create admin auth token and seed session key in Redis
    const adminId = "9b6a18cb-7e3e-4fb7-872f-530e2f5b61cc";
    const adminToken = server.jwt.admin.sign({ id: adminId, role: "admin" });
    await redis.set(`dira:admin:session:${adminId}`, "active", "EX", 7200);
    
    let adminLimitHit = false;
    // Send 31 requests to an admin endpoint (e.g. /api/admin/mpesa-settings)
    try {
      for (let i = 1; i <= 31; i++) {
        const res = await server.inject({
          method: "GET",
          url: "/api/admin/mpesa-settings",
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
          remoteAddress: "192.168.1.55", // Simulate unique IP
        });

        console.log(`  Request #${i} returned status: ${res.statusCode}`);

        if (res.statusCode === 429) {
          adminLimitHit = true;
          console.log(`  Admin limit hit on request #${i} as expected!`);
          break;
        }
      }
    } finally {
      // Clean up session in Redis
      await redis.del(`dira:admin:session:${adminId}`);
    }

    if (!adminLimitHit) {
      throw new Error("Admin Scope Rate Limit failed: expected 429 status code on 31st request.");
    }

    console.log("✅ Admin Scope Rate Limit test passed!");

    console.log("\n⭐️ ALL API SECURITY TEST CASES PASSED SUCCESSFULLY! ⭐️");
    
    // Explicit exit to shut down database/Redis sockets
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Test Suite Failed:", err);
    process.exit(1);
  } finally {
    await server.close();
    await redis.quit();
  }
}

runTests();
