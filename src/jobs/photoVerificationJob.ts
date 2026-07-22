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

import { Job } from "bullmq";
import { query } from "../db/query";
import { verificationService, getOutcomeAndReason } from "../services/verificationService";
import { tokenService } from "../services/tokenService";
import { reputationService } from "../services/reputationService";
import { notificationsQueue, hederaAnchorQueue } from "./queues";
import path from "path";
import fs from "fs";

export async function processPhotoVerification(job: Job) {
  const { submissionId, userId, farmId, photoUrl, cropType, growthStage, latitude, longitude } = job.data;

  const filename = photoUrl.substring(photoUrl.lastIndexOf("/") + 1);
  const filePath = path.join(__dirname, "../../public/uploads", filename);

  try {
    // Execute the Bayesian Verification pipeline combining all diagnostic signals
    const result = await verificationService.verifyCropSubmission(submissionId, {
      photoPath: filePath,
      cropType,
      latitude,
      longitude,
      userId,
      farmId,
      growthStage
    });

    const aiResult = result.aiResult;

    // Update the crop_submissions table with score and factors
    await query(
      `UPDATE crop_submissions
       SET verification_status = $1,
           ai_health_score = $2,
           ai_confidence = $3,
           ai_detected_issues = $4,
           ai_report_en = $5,
           ai_report_sw = $6,
           rejection_reason = $7,
           verification_score = $8,
           verification_factors = $9,
           perceptual_hash = $10,
           verified_at = CASE WHEN $1 = 'verified' THEN CURRENT_TIMESTAMP ELSE verified_at END,
           needs_recheck = $11
       WHERE id = $12`,
      [
        result.status,
        aiResult.healthScore,
        aiResult.confidence,
        JSON.stringify(aiResult.detectedIssues),
        aiResult.reportEn,
        aiResult.reportSw,
        result.status === "rejected" ? (aiResult.reason || "BAYESIAN_REJECTION") : null,
        result.score,
        JSON.stringify(result.factors),
        result.perceptualHash,
        result.needsRecheck || false,
        submissionId
      ]
    );

    // Write to calibration log and update Farmer reputation if outcome is auto-verified or auto-rejected
    if (result.status === "verified" || result.status === "rejected") {
      try {
        await query(
          `INSERT INTO verification_calibration_logs (submission_id, predicted_probability, eventual_outcome)
           VALUES ($1, $2, $3)`,
          [submissionId, result.score, result.status]
        );
      } catch (logErr: any) {
        console.error("Failed to write to calibration log:", logErr.message);
      }

      try {
        await reputationService.updateReputation(
          userId,
          "crop",
          submissionId,
          result.status === "verified" ? "success" : "failure"
        );
      } catch (repErr: any) {
        console.error("Failed to update reputation for crop submission:", repErr.message);
      }
    }

    if (result.status === "rejected") {
      const userRes = await query("SELECT telegram_id, language FROM users WHERE id = $1", [userId]);
      const farmerTelegramId = userRes.rows[0]?.telegram_id;
      const farmerLang = userRes.rows[0]?.language || "en";

      if (farmerTelegramId) {
        const isSw = farmerLang === "sw";
        const reasonText = aiResult.reason || "BAYESIAN_REJECTION";
        
        const plainReason = getOutcomeAndReason("rejected", result.factors, reasonText, farmerLang).reason;
        
        const rejectMsg = isSw
          ? `Habari! Uwasilishaji wako wa ${cropType} umekataliwa. Sababu: ${plainReason}`
          : `Hello! Your crop submission for ${cropType} was rejected. Reason: ${plainReason}`;

        await notificationsQueue.add("send-telegram", {
          telegramId: String(farmerTelegramId),
          message: rejectMsg
        });
      }

      return { verified: false, reason: aiResult.reason || "BAYESIAN_REJECTION", score: result.score };
    }

    if (result.status === "manual_review") {
      // Send a Telegram alert to farmer notifying them that their submission is under manual review
      const userRes = await query("SELECT telegram_id, language FROM users WHERE id = $1", [userId]);
      const farmerTelegramId = userRes.rows[0]?.telegram_id;
      const farmerLang = userRes.rows[0]?.language || "en";

      if (farmerTelegramId) {
        const isSw = farmerLang === "sw";
        const reviewMsg = isSw
          ? `Mambo! Uwasilishaji wako unafanyiwa ukaguzi wa mwongozo. Tutakuarifu hivi karibuni.`
          : `Hello! Your submission is under manual review. We will notify you once resolved.`;

        await notificationsQueue.add("send-telegram", {
          telegramId: String(farmerTelegramId),
          message: reviewMsg
        });
      }

      return { verified: false, status: "manual_review", score: result.score };
    }

    // Award tokens to user if status is 'verified' and they are eligible for rewards
    const isEligible = await reputationService.checkRewardEligibility(userId);
    const hasGeoAnomaly = aiResult.detectedIssues?.geo_anomaly === true;
    const hasSpeciesMismatch = aiResult.detectedIssues?.species_mismatch === true;
    const isBonus = aiResult.confidence > 0.85 && !hasGeoAnomaly && !hasSpeciesMismatch;
    const tokensToAward = isBonus ? 6 : 5;

    if (isEligible) {
      await tokenService.awardTokens(
        userId,
        tokensToAward,
        `Reward for verified crop photo submission of ${cropType} (${growthStage})${isBonus ? " - High Confidence Bonus" : ""}`,
        "crop_photo",
        submissionId
      );
    } else {
      console.warn(`User ${userId} is flagged/ineligible: Skipping auto-reward credit for crop submission ${submissionId}`);
    }

    // Queue anchoring of SHA-256 hash to Hedera HCS Topic (Score and metadata remains off-chain)
    try {
      await hederaAnchorQueue.add("anchor-submission", { submissionId });
      console.log(`Queued Hedera anchoring job for submission ${submissionId}`);
    } catch (queueErr: any) {
      console.error(`Failed to queue Hedera anchoring job for submission ${submissionId}:`, queueErr.message);
    }

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

    return { verified: true, tokensAwarded: tokensToAward, score: result.score };
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

