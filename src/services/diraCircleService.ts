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
import { env } from "../config/env";
import { notificationsQueue } from "../jobs/queues";

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

  /**
   * Registers a user circle pool redemption.
   * Deducts tokens immediately and creates a pending circle redemption request.
   */
  async registerCircleRedemption(
    userId: string,
    tokenAmount: number
  ): Promise<{ success: boolean; message: string }> {
    if (tokenAmount < 100) {
      throw new Error("BELOW_MINIMUM_TOKENS");
    }

    // 1. Fetch user county and decrypted phone number
    const userRes = await query(
      `SELECT county, pgp_sym_decrypt(phone_number::bytea, $1) AS phone
       FROM users WHERE id = $2`,
      [env.PGCRYPTO_SYMMETRIC_KEY, userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error("USER_NOT_FOUND");
    }

    const { county: countyId, phone: phoneNumber } = userRes.rows[0];

    if (!countyId) {
      throw new Error("COUNTY_NOT_SPECIFIED");
    }

    // 2. Validate that there is an active circle coordinator for this county
    const coordinatorRes = await query(
      "SELECT id FROM circle_coordinators WHERE county_id = $1 AND active = TRUE",
      [countyId]
    );

    if (coordinatorRes.rows.length === 0) {
      throw new Error("NO_ACTIVE_COORDINATOR");
    }

    // 3. Deduct tokens immediately (checks balance in transaction)
    try {
      await tokenService.deductTokens(userId, tokenAmount, "redeem_circle");
    } catch (err: any) {
      throw new Error("INSUFFICIENT_TOKENS");
    }

    const kesValue = tokenAmount * 0.50;

    // 4. Create redemption_requests record with type 'circle', status 'pending'
    await query(
      `INSERT INTO redemption_requests (user_id, tokens_spent, redemption_type, amount_kes, phone_number, status)
       VALUES ($1, $2, 'circle', $3, pgp_sym_encrypt($4, $5), 'pending')`,
      [userId, tokenAmount, kesValue, phoneNumber, env.PGCRYPTO_SYMMETRIC_KEY]
    );

    return {
      success: true,
      message: `Your KES ${kesValue.toFixed(2)} will be distributed at the next Dira Circle event in your county`
    };
  }

  /**
   * Aggregates pending circle redemptions into a monthly county pool.
   * Lock requests in 'processing' status to prevent race conditions.
   */
  async processMonthlyCountyPool(
    countyId: string,
    periodMonth: Date
  ): Promise<{ coordinatorId: string; totalUsers: number; totalKes: number }> {
    // 1. Get coordinator info
    const coordRes = await query(
      `SELECT cc.id, u.id AS user_id, u.full_name AS coordinator_name, 
              pgp_sym_decrypt(cc.mpesa_number::bytea, $1) AS mpesa_number,
              u.telegram_id AS coordinator_telegram_id
       FROM circle_coordinators cc
       JOIN users u ON cc.agent_id = u.id
       WHERE cc.county_id = $2 AND cc.active = TRUE`,
      [env.PGCRYPTO_SYMMETRIC_KEY, countyId]
    );

    if (coordRes.rows.length === 0) {
      throw new Error("COORDINATOR_NOT_FOUND");
    }

    const { id: coordinatorId, coordinator_name: coordinatorName, mpesa_number: coordinatorMpesa, coordinator_telegram_id: coordinatorTelegramId } = coordRes.rows[0];

    // 2. Aggregate all pending circle redemption requests for the county
    const pendingRequestsRes = await query(
      `SELECT rr.id, rr.amount_kes, rr.tokens_spent, u.full_name, u.telegram_id
       FROM redemption_requests rr
       JOIN users u ON rr.user_id = u.id
       WHERE rr.redemption_type = 'circle'
         AND rr.status = 'pending'
         AND u.county = $1`,
      [countyId]
    );

    const pendingRequests = pendingRequestsRes.rows;
    if (pendingRequests.length === 0) {
      throw new Error("NO_PENDING_REDEMPTIONS");
    }

    const totalUsers = new Set(pendingRequests.map(r => r.telegram_id)).size;
    const totalTokens = pendingRequests.reduce((sum, r) => sum + Number(r.tokens_spent), 0);
    const totalKes = pendingRequests.reduce((sum, r) => sum + Number(r.amount_kes), 0);

    // 3. Set their status to 'processing'
    const requestIds = pendingRequests.map(r => r.id);
    await query(
      `UPDATE redemption_requests 
       SET status = 'processing' 
       WHERE id = ANY($1::uuid[])`,
      [requestIds]
    );

    // 4. Create dira_circle_distributions record with status 'pending'
    const distInsertRes = await query(
      `INSERT INTO dira_circle_distributions (county_id, coordinator_id, period_month, total_users, total_tokens, total_kes_disbursed, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [countyId, coordinatorId, periodMonth, totalUsers, totalTokens, totalKes]
    );

    // 5. Notify admin via Telegram
    try {
      const adminRes = await query(
        "SELECT telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL LIMIT 1"
      );
      const adminTelegramId = adminRes.rows[0]?.telegram_id;
      if (adminTelegramId) {
        const userListStr = pendingRequests
          .map(r => `• ${r.full_name} (KES ${Number(r.amount_kes).toFixed(2)})`)
          .join("\n");

        await notificationsQueue.add("send-telegram", {
          telegramId: String(adminTelegramId),
          message: `📊 DIRA CIRCLE POOL: ${countyId}
Period: ${periodMonth.toISOString().substring(0, 7)}
Coordinator: ${coordinatorName}
M-Pesa Number: ${coordinatorMpesa}
Total KES: KES ${totalKes.toFixed(2)}
Total Users: ${totalUsers}

Users expecting payment:
${userListStr}`
        });
      }
    } catch (err) {
      console.error("Failed to notify admin on monthly pool processing:", err);
    }

    // 6. Notify coordinator via Telegram of incoming transfer
    if (coordinatorTelegramId) {
      try {
        await notificationsQueue.add("send-telegram", {
          telegramId: String(coordinatorTelegramId),
          message: `Hello ${coordinatorName}! An incoming transfer of KES ${totalKes.toFixed(2)} for the monthly Dira Circle community cash pool in ${countyId} county is being processed. Please prepare to distribute the cash locally to the ${totalUsers} expecting users.`
        });
      } catch (err) {
        console.error("Failed to notify coordinator on monthly pool processing:", err);
      }
    }

    return {
      coordinatorId,
      totalUsers,
      totalKes
    };
  }

  /**
   * Confirms coordinator distribution.
   * Updates distribution status to 'completed' and all aggregated redemption requests to 'completed'.
   */
  async confirmDistribution(
    distributionId: string,
    transferReference: string
  ): Promise<boolean> {
    // 1. Fetch distribution record
    const distRes = await query(
      `SELECT d.*, c.county_id, u.full_name AS coordinator_name
       FROM dira_circle_distributions d
       JOIN circle_coordinators c ON d.coordinator_id = c.id
       JOIN users u ON c.agent_id = u.id
       WHERE d.id = $1`,
      [distributionId]
    );

    if (distRes.rows.length === 0) {
      throw new Error("DISTRIBUTION_NOT_FOUND");
    }

    const { county_id: countyId, coordinator_name: coordinatorName } = distRes.rows[0];

    // 2. Mark distribution as 'completed'
    await query(
      `UPDATE dira_circle_distributions
       SET status = 'completed',
           transfer_reference = $1,
           transferred_at = CURRENT_TIMESTAMP,
           distribution_confirmed_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [transferReference, distributionId]
    );

    // 3. Update all included redemption_requests to 'completed'
    // Find all 'circle' requests in status 'processing' for users in that county
    const updateRequestsRes = await query(
      `UPDATE redemption_requests rr
       SET status = 'completed',
           completed_at = CURRENT_TIMESTAMP,
           mpesa_receipt = $1
       FROM users u
       WHERE rr.user_id = u.id
         AND rr.redemption_type = 'circle'
         AND rr.status = 'processing'
         AND u.county = $2
       RETURNING rr.user_id, rr.amount_kes, u.telegram_id, u.full_name`,
      [transferReference, countyId]
    );

    // 4. Notify all users via Telegram that their cash was distributed
    for (const row of updateRequestsRes.rows) {
      if (row.telegram_id) {
        try {
          const userKes = Number(row.amount_kes);
          await notificationsQueue.add("send-telegram", {
            telegramId: String(row.telegram_id),
            message: `Habari! Your cash payout of KES ${userKes.toFixed(2)} has been successfully distributed by coordinator ${coordinatorName} for the Dira Circle pool in ${countyId} county. Reference: ${transferReference}`
          });
        } catch (err) {
          console.error(`Failed to notify user ${row.full_name} of distribution:`, err);
        }
      }
    }

    return true;
  }
}

export const diraCircleService = new DiraCircleService();
