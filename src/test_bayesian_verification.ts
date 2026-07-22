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

import { pool } from "./db/pool";
import { query } from "./db/query";
import { verificationService, VERIFICATION_CONFIG } from "./services/verificationService";
import { aiService } from "./services/aiService";
import sharp from "sharp";
import fs from "fs";
import path from "path";

// Mock Database Queries
let mockSubmissionsCount = 0;
let mockVerifiedCount = 0;
let mockDuplicateHashes: string[] = [];
let mockInGeofence = true;

// Mock Agent Reputation variables
let mockAlpha = 2.0;
let mockBeta = 2.0;
let mockTrustScore = 0.50;
let mockTrustTier = "new";

// Override database queries for test containment
(pool as any).query = async (text: string, params?: any[]): Promise<any> => {
  const sql = text.toLowerCase();
  
  if (sql.includes("select") && sql.includes("agent_reputations")) {
    return { rows: [{ user_id: params?.[0], alpha: mockAlpha, beta: mockBeta, trust_score: mockTrustScore, trust_tier: mockTrustTier }] };
  }

  if (sql.includes("count(*)") && sql.includes("crop_submissions")) {
    return { rows: [{ total: mockSubmissionsCount, verified: mockVerifiedCount }] };
  }
  
  if (sql.includes("perceptual_hash") && sql.includes("crop_submissions")) {
    return { rows: mockDuplicateHashes.map(h => ({ perceptual_hash: h })) };
  }
  
  if (sql.includes("st_dwithin") && sql.includes("farms")) {
    return { rows: [{ within_geofence: mockInGeofence }] };
  }

  if (sql.includes("insert into") || sql.includes("update crop_submissions") || sql.includes("insert into agent_reputations")) {
    return { rows: [{ id: "mock-id" }] };
  }

  return { rows: [] };
};

(pool as any).connect = async (): Promise<any> => {
  return {
    query: pool.query,
    release: () => {}
  };
};

// Create test image files using Sharp
const tempImagesDir = path.join(__dirname, "../public/uploads");
if (!fs.existsSync(tempImagesDir)) {
  fs.mkdirSync(tempImagesDir, { recursive: true });
}
const testImagePath = path.join(tempImagesDir, "test_verification.jpg");

async function generateTestImage() {
  await sharp({
    create: {
      width: 300,
      height: 300,
      channels: 3,
      background: { r: 50, g: 150, b: 50 } // Mostly Green
    }
  })
  .jpeg()
  .toFile(testImagePath);
}

async function runTests() {
  console.log("Generating mock crop image...");
  await generateTestImage();

  console.log("\n🧪 Running Bayesian Verification Engine (R1) Unit Tests...\n");

  // ==========================================
  // TEST 1: Genuine crop photo submission
  // ==========================================
  console.log("--- TEST 1: Genuine Crop Photo ---");
  mockSubmissionsCount = 10;
  mockVerifiedCount = 9; // High reputation prior
  mockAlpha = 9.0;
  mockBeta = 1.0;
  mockTrustScore = 0.8333;
  mockTrustTier = "trusted";
  mockDuplicateHashes = [];
  mockInGeofence = true;

  // Mock Gemini Response to match target crop type
  const mockAiVerify = aiService.verifyCropPhoto;
  aiService.verifyCropPhoto = async () => ({
    isVerified: true,
    confidence: 0.95,
    healthScore: 0.90,
    detectedIssues: {},
    reportEn: "Healthy maize crop.",
    reportSw: "Zao la mahindi lenye afya.",
    identifiedSpecies: "Zea mays"
  });

  let result = await verificationService.verifyCropSubmission("test-sub-1", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);
  console.log("Factors:", JSON.stringify(result.factors, null, 2));

  if (result.status !== "verified") {
    throw new Error(`Test 1 Failed: Expected status 'verified', got '${result.status}'`);
  }
  if (result.score < 0.70) { // acceptance threshold for trusted agent is 0.70
    throw new Error(`Test 1 Failed: Expected score >= 0.70, got ${result.score}`);
  }
  console.log("✅ Test 1 Passed.");

  // ==========================================
  // TEST 2: Wrong-Crop Fraud (PlantNet Mismatch)
  // ==========================================
  console.log("\n--- TEST 2: Wrong-Crop Fraud (PlantNet Mismatch) ---");
  // AI identifies weeds / different species mismatching "Maize"
  mockSubmissionsCount = 3;
  mockVerifiedCount = 2; // neutral reputation prior
  mockAlpha = 3.0;
  mockBeta = 2.0;
  mockTrustScore = 0.60;
  mockTrustTier = "new";

  aiService.verifyCropPhoto = async () => ({
    isVerified: true,
    confidence: 0.92,
    healthScore: 0.85,
    detectedIssues: {},
    reportEn: "Healthy plants.",
    reportSw: "Mimea yenye afya.",
    identifiedSpecies: "Rosa rubiginosa" // Wild Rose instead of Maize
  });

  result = await verificationService.verifyCropSubmission("test-sub-2", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);

  if (result.status !== "manual_review") {
    throw new Error(`Test 2 Failed: Expected status 'manual_review' due to wrong crop mismatch, got '${result.status}'`);
  }
  console.log("✅ Test 2 Passed.");

  // ==========================================
  // TEST 3: Duplicate / Replay Fraud (Perceptual Hash match)
  // ==========================================
  console.log("\n--- TEST 3: Duplicate / Replay Photo Fraud ---");
  mockAlpha = 9.0;
  mockBeta = 1.0;
  mockTrustScore = 0.8333;
  mockTrustTier = "trusted";
  // Mock current image hash matching an existing hash in the database
  const targetHash = await verificationService.verifyCropSubmission("test-sub-3-prep", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  mockDuplicateHashes = [targetHash.perceptualHash]; // duplicate match!

  aiService.verifyCropPhoto = async () => ({
    isVerified: true,
    confidence: 0.95,
    healthScore: 0.90,
    detectedIssues: {},
    reportEn: "Healthy maize.",
    reportSw: "Mahindi yenye afya.",
    identifiedSpecies: "Zea mays"
  });

  result = await verificationService.verifyCropSubmission("test-sub-3", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);

  if (result.status !== "rejected") {
    throw new Error(`Test 3 Failed: Expected duplicate image submission to be 'rejected', got '${result.status}'`);
  }
  if (result.score >= VERIFICATION_CONFIG.thresholdReject) {
    throw new Error(`Test 3 Failed: Expected score < 0.35, got ${result.score}`);
  }
  console.log("✅ Test 3 Passed.");

  // ==========================================
  // TEST 4: Out-of-Region / Geofence Mismatch
  // ==========================================
  console.log("\n--- TEST 4: Out-of-Region Coordinates Fraud ---");
  mockAlpha = 3.0;
  mockBeta = 2.0;
  mockTrustScore = 0.60;
  mockTrustTier = "new";
  mockDuplicateHashes = [];
  mockInGeofence = false; // Mismatch geofence

  result = await verificationService.verifyCropSubmission("test-sub-4", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -4.0321, // far outside Nairobi
    longitude: 39.6682,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);

  // Borderline location failure routes to review rather than auto-reject if others pass
  if (result.status !== "manual_review") {
    throw new Error(`Test 4 Failed: Expected geofence mismatch to route to 'manual_review', got '${result.status}'`);
  }
  console.log("✅ Test 4 Passed.");

  // ==========================================
  // TEST 5: Single-Signal Noise / Mismatch (Weather Anomaly)
  // ==========================================
  console.log("\n--- TEST 5: Noise Tolerance (Weather Mismatch) ---");
  mockAlpha = 9.0;
  mockBeta = 1.0;
  mockTrustScore = 0.8333;
  mockTrustTier = "trusted";
  mockInGeofence = true;
  
  // Mock fetch to simulate extreme temperature anomaly (-15°C) to check noise tolerance
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      hourly: {
        temperature_2m: Array(24).fill(-15.0) // Extreme anomaly
      }
    })
  }) as any;

  result = await verificationService.verifyCropSubmission("test-sub-5", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  // Restore fetch
  global.fetch = originalFetch;

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);

  // Since reputation, geofence, duplicate, EXIF, and Gemini are 100% correct,
  // weather anomaly (which could be weather station sensor glitch) must not trigger auto-rejection.
  if (result.status !== "verified") {
    throw new Error(`Test 5 Failed: Mismatching weather should not overturn an otherwise genuine check, expected 'verified' status, got '${result.status}'`);
  }
  console.log("✅ Test 5 Passed.");

  // ==========================================
  // TEST 6: Fail Closed on Missing/Failed Evidence
  // ==========================================
  console.log("\n--- TEST 6: Fail Closed on Missing Evidence ---");
  mockSubmissionsCount = 0; // zero prior
  mockVerifiedCount = 0;
  mockAlpha = 2.0;
  mockBeta = 2.0;
  mockTrustScore = 0.50;
  mockTrustTier = "new";
  mockInGeofence = false;

  // Gemini API failure/error
  aiService.verifyCropPhoto = async () => ({
    isVerified: false,
    confidence: 0,
    healthScore: 0,
    detectedIssues: { api_failure: true },
    reportEn: "API error.",
    reportSw: "Hitilafu.",
    identifiedSpecies: "None",
    reason: "GEMINI_API_FAILURE"
  });

  result = await verificationService.verifyCropSubmission("test-sub-6", {
    photoPath: testImagePath,
    cropType: "Maize",
    latitude: -1.2921,
    longitude: 36.8219,
    userId: "test-user-id",
    farmId: "test-farm-id",
    growthStage: "Vegetative"
  });

  console.log(`Posterior Probability: ${result.score}`);
  console.log(`Verification Status: ${result.status}`);

  if (result.status !== "rejected") {
    throw new Error(`Test 6 Failed: Fail closed was expected to return 'rejected', got '${result.status}'`);
  }
  console.log("✅ Test 6 Passed.");

  // Restore original services
  aiService.verifyCropPhoto = mockAiVerify;

  // Clean up test files
  if (fs.existsSync(testImagePath)) {
    fs.unlinkSync(testImagePath);
  }

  console.log("\n🎉 All Bayesian Verification Engine tests executed and passed successfully!\n");
}

runTests().catch(err => {
  console.error("❌ Test run failed with error:", err);
  process.exit(1);
});
