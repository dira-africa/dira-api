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

import { query } from "../db/query";
import { tokenService } from "./tokenService";

export class DiraCircleService {
  /**
   * Contributes Climate Tokens to a Dira Circle community cash pool
   */
  async contributeToPool(
    userId: string,
    countyId: string,
    tokenAmount: number
  ): Promise<{
    success: boolean;
    kesValue: number;
  }> {
    if (tokenAmount <= 0) {
      throw new Error("Contribution amount must be greater than zero.");
    }

    // 1. Verify that there is an active circle coordinator for this county
    const coordinatorRes = await query(
      "SELECT id FROM circle_coordinators WHERE county_id = $1 AND active = TRUE",
      [countyId]
    );

    if (coordinatorRes.rows.length === 0) {
      throw new Error(`No active Dira Circle coordinator found for county: ${countyId}`);
    }

    const coordinatorId = coordinatorRes.rows[0].id;
    const kesValue = tokenAmount * 1.20; // 1 DIRA = 1.20 KES pool contribution

    // 2. Deduct tokens from user's ledger (automatically validates balance)
    await tokenService.awardTokens(
      userId,
      -tokenAmount,
      `Contributed ${tokenAmount} tokens to ${countyId} Circle community cash pool (KES ${kesValue.toFixed(2)} value)`,
      "redeem_circle"
    );

    // 3. Save to general redemption requests
    const reqRes = await query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status, completed_at)
       VALUES ($1, $2, 'circle', $3, pgp_sym_encrypt('Dira Circle Pool: ' || $4, 'SuperSecureDiraSecretPassphrase'), 'completed', CURRENT_TIMESTAMP)
       RETURNING id`,
      [userId, tokenAmount, kesValue, countyId]
    );
    const requestId = reqRes.rows[0].id;

    // 4. Update or insert the monthly distribution summary for this county
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    // Check if user has contributed to this county circle pool before in the current month
    const userContributionRes = await query(
      `SELECT COUNT(*) AS count FROM redemption_requests
       WHERE user_id = $1 AND redemption_type = 'circle'
         AND initiated_at >= DATE_TRUNC('month', CURRENT_TIMESTAMP)
         AND id != $2`,
      [userId, requestId]
    );
    const hasContributedThisMonth = Number(userContributionRes.rows[0].count) > 0;

    // Query active distribution for current month
    const distRes = await query(
      `SELECT id FROM dira_circle_distributions
       WHERE county_id = $1 AND period_month = DATE_TRUNC('month', CURRENT_TIMESTAMP)`,
      [countyId]
    );

    if (distRes.rows.length > 0) {
      const distId = distRes.rows[0].id;
      // Increment tokens, KES, and optionally users count
      const incrementUserSql = hasContributedThisMonth ? "" : ", total_users = total_users + 1";
      await query(
        `UPDATE dira_circle_distributions 
         SET total_tokens = total_tokens + $1,
             total_kes_disbursed = total_kes_disbursed + $2
             ${incrementUserSql}
         WHERE id = $3`,
        [tokenAmount, kesValue, distId]
      );
    } else {
      // First distribution entry for this month
      await query(
        `INSERT INTO dira_circle_distributions (county_id, coordinator_id, period_month, total_users, total_tokens, total_kes_disbursed, status)
         VALUES ($1, $2, DATE_TRUNC('month', CURRENT_TIMESTAMP), 1, $3, $4, 'pending')`,
        [countyId, coordinatorId, tokenAmount, kesValue]
      );
    }

    return {
      success: true,
      kesValue
    };
  }

  /**
   * Retrieves status details for a county's circle pool
   */
  async getPoolStatus(
    countyId: string
  ): Promise<{
    totalContributed: number;
    membersCount: number;
    coordinatorName?: string;
  }> {
    const distRes = await query(
      `SELECT d.total_tokens, d.total_users, u.full_name AS coordinator_name
       FROM dira_circle_distributions d
       JOIN circle_coordinators c ON d.coordinator_id = c.id
       JOIN users u ON c.agent_id = u.id
       WHERE d.county_id = $1 AND d.period_month = DATE_TRUNC('month', CURRENT_TIMESTAMP)`,
      [countyId]
    );

    if (distRes.rows.length === 0) {
      // Return defaults if no distribution recorded yet
      const coordRes = await query(
        `SELECT u.full_name FROM circle_coordinators c
         JOIN users u ON c.agent_id = u.id
         WHERE c.county_id = $1 AND c.active = TRUE`,
        [countyId]
      );
      return {
        totalContributed: 0,
        membersCount: 0,
        coordinatorName: coordRes.rows[0]?.full_name || undefined
      };
    }

    return {
      totalContributed: Number(distRes.rows[0].total_tokens),
      membersCount: Number(distRes.rows[0].total_users),
      coordinatorName: distRes.rows[0].coordinator_name
    };
  }
}

export const diraCircleService = new DiraCircleService();
