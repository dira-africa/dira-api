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

import { query } from "../db/query";
import fs from "fs";
import path from "path";

export class DpaService {
  /**
   * Scans and processes all accounts scheduled for deletion that requested deletion more than 30 days ago.
   */
  async anonymizePendingAccounts(): Promise<{ processedCount: number }> {
    const res = await query(
      `SELECT id FROM users 
       WHERE delete_requested_at IS NOT NULL 
         AND delete_requested_at <= NOW() - INTERVAL '30 days'
         AND is_active = TRUE`
    );

    const userIds = res.rows.map((r) => r.id);
    for (const userId of userIds) {
      await this.anonymizeUser(userId);
    }

    return { processedCount: userIds.length };
  }

  /**
   * Deletes a user's farm, crop submissions, crop photo files on disk, and anonymises the user profile.
   */
  async anonymizeUser(userId: string): Promise<void> {
    // 1. Fetch and delete crop photos from storage
    const cropsRes = await query(
      "SELECT photo_url FROM crop_submissions WHERE user_id = $1",
      [userId]
    );

    // In local dev emulator environment, crop photos are written locally to public/uploads
    const uploadsDir = path.join(__dirname, "../../public/uploads");

    for (const row of cropsRes.rows) {
      const photoUrl = row.photo_url;
      if (photoUrl) {
        try {
          const filename = path.basename(photoUrl);
          const filePath = path.join(uploadsDir, filename);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          console.error(`Failed to delete crop photo file on disk: ${photoUrl}`, err);
        }
      }
    }

    // 2. Delete crop submissions database records
    await query("DELETE FROM crop_submissions WHERE user_id = $1", [userId]);

    // 3. Delete farm records
    await query("DELETE FROM farms WHERE user_id = $1", [userId]);

    // 4. Anonymise user records
    // Retain user id for foreign key constraints on token_ledger and atmospheric_readings.
    // Replace name, nullify PII, set active to false.
    await query(
      `UPDATE users
       SET full_name = 'Deleted User [' || id || ']',
           phone_number = NULL,
           telegram_id = NULL,
           telegram_username = NULL,
           county = NULL,
           is_active = FALSE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );

    console.log(`Successfully anonymized user record: ${userId}`);
  }
}

export const dpaService = new DpaService();
