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

import { Job } from "bullmq";
import { query } from "../db/query";
import { aiService } from "../services/aiService";
import { tokenService } from "../services/tokenService";
import { notificationsQueue } from "./queues";
import path from "path";
import fs from "fs";

export async function processPhotoVerification(job: Job) {
  const { submissionId, userId, farmId, photoUrl, cropType, growthStage, latitude, longitude } = job.data;

  const filename = photoUrl.substring(photoUrl.lastIndexOf("/") + 1);
  const filePath = path.join(__dirname, "../../public/uploads", filename);

  try {
    // Call AI photo verification service, passing farmId and GPS coordinates
    const aiResult = await aiService.verifyCropPhoto(filePath, cropType, farmId, latitude, longitude);

    if (!aiResult.isVerified) {
      await query(
        `UPDATE crop_submissions
         SET verification_status = 'rejected',
             rejection_reason = $1,
             ai_health_score = $2,
             ai_confidence = $3,
             ai_detected_issues = $4,
             ai_report_en = $5,
             ai_report_sw = $6
         WHERE id = $7`,
        [
          aiResult.reason || aiResult.reportEn,
          aiResult.healthScore,
          aiResult.confidence,
          JSON.stringify(aiResult.detectedIssues),
          aiResult.reportEn,
          aiResult.reportSw,
          submissionId
        ]
      );
      return { verified: false, reason: aiResult.reason || "AI_VERIFICATION_FAILED" };
    }

    // Update submission record to verified
    await query(
      `UPDATE crop_submissions
       SET verification_status = 'verified',
           ai_health_score = $1,
           ai_confidence = $2,
           ai_detected_issues = $3,
           ai_report_en = $4,
           ai_report_sw = $5,
           verified_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [
        aiResult.healthScore,
        aiResult.confidence,
        JSON.stringify(aiResult.detectedIssues),
        aiResult.reportEn,
        aiResult.reportSw,
        submissionId
      ]
    );

    // Calculate token awards: 5 standard, 1 bonus if all checks pass and confidence > 0.85
    const hasGeoAnomaly = aiResult.detectedIssues?.geo_anomaly === true;
    const hasSpeciesMismatch = aiResult.detectedIssues?.species_mismatch === true;
    const isBonus = aiResult.confidence > 0.85 && !hasGeoAnomaly && !hasSpeciesMismatch;
    const tokensToAward = isBonus ? 6 : 5;

    await tokenService.awardTokens(
      userId,
      tokensToAward,
      `Reward for verified crop photo submission of ${cropType} (${growthStage})${isBonus ? " - High Confidence Bonus" : ""}`,
      "crop_photo",
      submissionId
    );

    // Fetch user details for Telegram notification
    const userRes = await query("SELECT telegram_id, language FROM users WHERE id = $1", [userId]);
    const farmerTelegramId = userRes.rows[0]?.telegram_id;
    const farmerLang = userRes.rows[0]?.language || "en";

    if (farmerTelegramId) {
      const isSw = farmerLang === "sw";
      const header = isSw 
        ? `Habari! Afya ya zao lako imehakikiwa. Umepokea tokeni ${tokensToAward}!` 
        : `Hello! Your crop health has been verified. You earned ${tokensToAward} tokens!`;
      
      const reportMsg = isSw ? aiResult.reportSw : aiResult.reportEn;

      await notificationsQueue.add("send-telegram", {
        telegramId: String(farmerTelegramId),
        message: `${header}\n\n${reportMsg}`
      });
    }

    return { verified: true, tokensAwarded: tokensToAward };
  } finally {
    // Clean up: delete original photo file from server to prevent disk bloat
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Successfully deleted processed photo file: ${filePath}`);
      } catch (err: any) {
        console.error(`Failed to delete processed photo file ${filePath}:`, err.message);
      }
    }
  }
}
