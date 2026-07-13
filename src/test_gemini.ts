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

import sharp from "sharp";
import { aiService } from "./services/aiService";
import { env } from "./config/env";
import path from "path";
import fs from "fs";

async function testGeminiVerification() {
  console.log("=== STARTING GOOGLE GEMINI CROP VERIFICATION TEST ===");
  console.log(`Using GEMINI_API_KEY: ${env.GEMINI_API_KEY ? "CONFIGURED (starts with " + env.GEMINI_API_KEY.substring(0, 5) + "...)" : "MISSING"}`);

  // Create a textured test image buffer with gradients and random noise to pass solid-color and blur checks
  const width = 300;
  const height = 300;
  const rawBuffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const gradG = Math.floor(100 + (x / width) * 100);
      const gradR = Math.floor(20 + (y / height) * 40);
      const noise = Math.floor(Math.random() * 35);
      rawBuffer[idx] = Math.min(255, gradR + noise);
      rawBuffer[idx + 1] = Math.min(255, gradG + noise);
      rawBuffer[idx + 2] = Math.min(255, 15 + noise);
    }
  }

  const greenBuffer = await sharp(rawBuffer, {
    raw: {
      width,
      height,
      channels: 3
    }
  })
  .jpeg()
  .toBuffer();

  const tempImagePath = path.join(__dirname, "temp_test_crop.jpg");
  fs.writeFileSync(tempImagePath, greenBuffer);

  try {
    console.log(`Running verifyCropPhoto with cropType: Maize on temporary image: ${tempImagePath}...`);
    const result = await aiService.verifyCropPhoto(tempImagePath, "Maize");
    
    console.log("=== VERIFICATION RESULT ===");
    console.log("isVerified:", result.isVerified);
    console.log("confidence:", result.confidence);
    console.log("healthScore:", result.healthScore);
    console.log("identifiedSpecies:", result.identifiedSpecies);
    console.log("detectedIssues:", JSON.stringify(result.detectedIssues, null, 2));
    console.log("reportEn (English):", result.reportEn);
    console.log("reportSw (Swahili):", result.reportSw);

    // Validate expected structure properties
    if (
      typeof result.isVerified !== "boolean" ||
      typeof result.confidence !== "number" ||
      typeof result.healthScore !== "number" ||
      typeof result.identifiedSpecies !== "string" ||
      typeof result.reportEn !== "string" ||
      typeof result.reportSw !== "string" ||
      !result.detectedIssues ||
      typeof result.detectedIssues !== "object"
    ) {
      throw new Error("❌ Validation failed: Result fields are missing or have incorrect types.");
    }

    console.log("✅ Verification result validation passed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  } finally {
    if (fs.existsSync(tempImagePath)) {
      fs.unlinkSync(tempImagePath);
    }
  }
}

testGeminiVerification();
