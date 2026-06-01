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
import path from "path";

export async function processPhotoVerification(job: Job) {
  const { submissionId, userId, farmId, photoUrl, cropType, growthStage, latitude, longitude } = job.data;

  // 1. Proximity check (must be within 500 meters of the farm)
  const distanceRes = await query(
    `SELECT ST_Distance(
      farm_location::geography, 
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
    ) AS distance_meters FROM farms WHERE id = $3`,
    [longitude, latitude, farmId]
  );

  const distanceMeters = Number(distanceRes.rows[0].distance_meters);

  if (distanceMeters > 500) {
    const rejectionMsg = `Crop photo location (${distanceMeters.toFixed(1)}m) is too far from the registered farm location (max 500m limit).`;
    
    await query(
      `UPDATE crop_submissions 
       SET verification_status = 'rejected', 
           rejection_reason = $1,
           ai_report_en = $1,
           ai_report_sw = $2
       WHERE id = $3`,
      [
        rejectionMsg, 
        `Eneo la picha ya zao (${distanceMeters.toFixed(1)}m) lipo mbali sana na eneo la shamba lako lililosajiliwa (kiwango cha juu ni mita 500).`,
        submissionId
      ]
    );
    return { verified: false, reason: "SPOOF_LOCATION_REJECTED" };
  }

  // 2. Run AI photo analysis (greenness and plant species match)
  const filename = photoUrl.substring(photoUrl.lastIndexOf("/") + 1);
  const filePath = path.join(__dirname, "../../public/uploads", filename);

  const aiResult = await aiService.verifyCropPhoto(filePath, cropType);

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
        aiResult.reportEn,
        aiResult.healthScore,
        aiResult.confidence,
        JSON.stringify(aiResult.detectedIssues),
        aiResult.reportEn,
        aiResult.reportSw,
        submissionId
      ]
    );
    return { verified: false, reason: "AI_VERIFICATION_FAILED" };
  }

  // 3. Update to verified
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

  // 4. Award Climate Tokens (15 DIRA)
  const tokensToAward = 15;
  await tokenService.awardTokens(
    userId,
    tokensToAward,
    `Reward for verified crop photo submission of ${cropType} (${growthStage})`,
    "crop_photo",
    submissionId
  );

  return { verified: true, tokensAwarded: tokensToAward };
}
