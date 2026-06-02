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
import { env } from "../config/env";
import { redis } from "../db/redis";
import { notificationsQueue } from "../jobs/queues";

export class NotificationService {
  /**
   * Helper to clean and mask Kenyan phone numbers, showing only the last 4 digits (e.g. ****7234)
   */
  maskPhone(phone: string): string {
    const cleaned = phone.replace(/\D/g, "");
    if (cleaned.length < 4) {
      return "****";
    }
    return `****${cleaned.substring(cleaned.length - 4)}`;
  }

  /**
   * Core function to send Telegram messages via Bot API with rate limiting and logging
   */
  async sendMessage(
    telegramId: string,
    text: string,
    parseMode: string = "Markdown"
  ): Promise<boolean> {
    const limitKey = `tg_limit:${telegramId}`;
    
    // 1. Rate Limiting Check: max 1 message per user per 60 seconds
    try {
      if (redis.status === "ready") {
        const isLimited = await redis.get(limitKey);
        if (isLimited) {
          console.warn(`[Rate Limit] Skipping Telegram message to user ${telegramId} (last message sent < 60s ago)`);
          return false;
        }
      }
    } catch (redisErr: any) {
      console.warn("Failed to check Redis rate limit key:", redisErr.message);
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const isMock = !token || token.includes("placeholder_bot_token") || process.env.NODE_ENV === "test";
    
    let success = false;
    let errorDetails: string | null = null;

    // 2. Invoke Telegram Bot API (or mock in test/development)
    if (isMock) {
      console.log(`[TELEGRAM MOCK] Sending message to ${telegramId} (${parseMode}):\n${text}`);
      success = true;
    } else {
      try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: Number(telegramId),
            text,
            parse_mode: parseMode
          }),
          signal: AbortSignal.timeout(10000)
        });

        if (response.ok) {
          success = true;
        } else {
          const resBody = await response.json().catch(() => ({}));
          errorDetails = `HTTP ${response.status}: ${JSON.stringify(resBody)}`;
          console.warn(`Telegram API sendMessage rejected: ${errorDetails}`);
        }
      } catch (err: any) {
        errorDetails = err.message || "Network request failed";
        console.error(`Telegram API connection failed:`, err);
      }
    }

    // 3. Set Redis rate limit key on successful send
    if (success) {
      try {
        if (redis.status === "ready") {
          await redis.set(limitKey, "1", "EX", 60);
        }
      } catch (redisErr: any) {
        console.warn("Failed to set Redis rate limit key:", redisErr.message);
      }
    }

    // 4. Log message to audit_log
    let userId: string | null = null;
    try {
      const userRes = await query("SELECT id FROM users WHERE telegram_id = $1", [BigInt(telegramId)]);
      if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
      }
    } catch (dbErr: any) {
      console.warn("Database lookup failed during Telegram audit logging:", dbErr.message);
    }

    try {
      await query(
        `INSERT INTO audit_log (user_id, action, entity_type, metadata)
         VALUES ($1, $2, $3, $4)`,
        [
          userId,
          "send_telegram_notification",
          "notification",
          JSON.stringify({
            telegramId,
            text,
            success,
            error: errorDetails
          })
        ]
      );
    } catch (auditErr: any) {
      console.error("Failed to write Telegram message to audit_log:", auditErr.message);
    }

    return success;
  }

  /**
   * Compatibility wrapper for BullMQ background workers calling this method directly
   */
  async sendTelegramNotification(telegramId: string, message: string): Promise<boolean> {
    return this.sendMessage(telegramId, message);
  }

  // =========================================================================
  // --- Templates Helpers (Bilingual EN/SW) ---------------------------------
  // =========================================================================

  /**
   * T1 - Crop photo verified
   */
  async sendCropPhotoVerifiedNotification(
    userId: string,
    crop: string,
    tokens: number,
    healthScore: number,
    reportLink: string
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const text = user.language === "sw"
      ? `Picha yako ya ${crop} imehakikishwa! Umepata tokens ${tokens}.`
      : `Your ${crop} photo is verified! You earned ${tokens} tokens.\nCrop health: ${healthScore}%. [link to report](${reportLink})`;

    return this.sendMessage(user.telegram_id, text);
  }

  /**
   * T2 - Atmospheric sync verified
   */
  async sendAtmosphericSyncNotification(
    userId: string,
    tokens: number,
    balance: number
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const text = user.language === "sw"
      ? `Usawazishaji umehakikishwa. Token ${tokens} imeongezeka.`
      : `Sync verified. You earned ${tokens} ${tokens === 1 ? "token" : "tokens"}. Balance: ${balance} tokens.`;

    return this.sendMessage(user.telegram_id, text);
  }

  /**
   * T3 - Airtime sent
   */
  async sendAirtimeSentNotification(
    userId: string,
    amount: number,
    phoneNumber: string
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const maskedPhone = this.maskPhone(phoneNumber);

    const text = user.language === "sw"
      ? `KES ${amount} za airtime zimetumwa kwa ${maskedPhone}.`
      : `KES ${amount} airtime sent to ${maskedPhone}. Check your phone!`;

    return this.sendMessage(user.telegram_id, text);
  }

  /**
   * T4 - Voucher generated
   */
  async sendVoucherGeneratedNotification(
    userId: string,
    amount: number,
    dealerName: string,
    expiresAt: Date
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const dateStr = expiresAt.toLocaleDateString("en-KE") || expiresAt.toISOString().substring(0, 10);

    const text = user.language === "sw"
      ? `Vocha yako ya KES ${amount} iko tayari kwa ${dealerName}.`
      : `Your KES ${amount} farm input voucher is ready. Show the QR code at ${dealerName} before ${dateStr}. Open the app to view it.`;

    return this.sendMessage(user.telegram_id, text);
  }

  /**
   * T5 - Dira Circle distribution ready
   */
  async sendCircleDistributionNotification(
    userId: string,
    amount: number,
    coordinatorName: string
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const text = user.language === "sw"
      ? `KES ${amount} iko tayari kwa mkurugenzi wako ${coordinatorName}.`
      : `KES ${amount} is ready for collection from your county coordinator ${coordinatorName}. Distribution is at the next cooperative meeting.`;

    return this.sendMessage(user.telegram_id, text);
  }

  /**
   * T6 - M-Pesa B2C sent
   */
  async sendMpesaB2CSentNotification(
    userId: string,
    amount: number,
    phoneNumber: string,
    receiptCode: string
  ): Promise<boolean> {
    const user = await this.getUserDetails(userId);
    if (!user) return false;

    const maskedPhone = this.maskPhone(phoneNumber);

    const text = user.language === "sw"
      ? `Malipo ya KES ${amount} yametumwa. Nambari ya risiti: ${receiptCode}.`
      : `M-Pesa payment of KES ${amount} sent to ${maskedPhone}.\nReceipt: ${receiptCode}. Thank you!`;

    return this.sendMessage(user.telegram_id, text);
  }

  // =========================================================================
  // --- Reminders & Summaries Generators ------------------------------------
  // =========================================================================

  /**
   * T7 - Daily sync reminders to all active agents (4x daily)
   */
  async sendSyncReminders(): Promise<void> {
    try {
      const res = await query(
        `SELECT telegram_id::text AS telegram_id, language 
         FROM users 
         WHERE role = 'agent' AND is_active = true`
      );

      console.log(`[Scheduled Job] Preparing T7 sync reminders for ${res.rows.length} agents...`);

      for (const agent of res.rows) {
        const text = agent.language === "sw"
          ? "Habari! Ni wakati wa kusawazisha data. Fungua Dira sasa."
          : "Hello! It is time to sync your weather data. Open Dira now.";
        
        await notificationsQueue.add(
          "send-telegram",
          {
            telegramId: agent.telegram_id,
            message: text
          },
          {
            attempts: 3,
            backoff: 5000
          }
        );
      }
    } catch (err: any) {
      console.error("Failed to execute sync reminders cron generator:", err.message);
      throw err;
    }
  }

  /**
   * T8 - Weekly summaries to all active users (Farmers & Agents, every Sunday 7pm EAT)
   */
  async sendWeeklySummaries(): Promise<void> {
    try {
      const res = await query(
        `SELECT id, telegram_id::text AS telegram_id, role, language 
         FROM users 
         WHERE is_active = true AND role IN ('farmer', 'agent')`
      );

      console.log(`[Scheduled Job] Preparing T8 weekly summaries for ${res.rows.length} users...`);

      for (const user of res.rows) {
        if (user.role === "farmer") {
          // A. Farmer stats
          const tokensRes = await query(
            `SELECT COALESCE(SUM(amount), 0)::int AS tokens 
             FROM token_ledger 
             WHERE user_id = $1 AND amount > 0 AND created_at >= CURRENT_DATE - INTERVAL '7 days'`,
            [user.id]
          );
          const submissionsRes = await query(
            `SELECT COUNT(*)::int AS submissions 
             FROM crop_submissions 
             WHERE user_id = $1 AND submitted_at >= CURRENT_DATE - INTERVAL '7 days'`,
            [user.id]
          );
          const healthRes = await query(
            `SELECT 
               AVG(CASE WHEN submitted_at >= CURRENT_DATE - INTERVAL '7 days' THEN ai_health_score END)::float AS avg_this_week,
               AVG(CASE WHEN submitted_at >= CURRENT_DATE - INTERVAL '14 days' AND submitted_at < CURRENT_DATE - INTERVAL '7 days' THEN ai_health_score END)::float AS avg_last_week
             FROM crop_submissions
             WHERE user_id = $1 AND verification_status = 'verified'`,
            [user.id]
          );

          const tokens = tokensRes.rows[0]?.tokens || 0;
          const submissions = submissionsRes.rows[0]?.submissions || 0;
          const thisWeekHealth = healthRes.rows[0]?.avg_this_week;
          const lastWeekHealth = healthRes.rows[0]?.avg_last_week;

          let trendEN = "Stable";
          let trendSW = "Imara";

          if (thisWeekHealth !== null && lastWeekHealth !== null) {
            if (thisWeekHealth > lastWeekHealth) {
              trendEN = "Improving";
              trendSW = "Inaimarika";
            } else if (thisWeekHealth < lastWeekHealth) {
              trendEN = "Declining";
              trendSW = "Inashuka";
            }
          } else if (thisWeekHealth === null) {
            trendEN = "No submissions this week";
            trendSW = "Hakuna picha zilizotumwa wiki hii";
          }

          const message = user.language === "sw"
            ? `Muhtasari wa Wiki: Umepata tokeni ${tokens} kutoka kwa michango ${submissions} wiki hii. Hali ya afya: ${trendSW}.`
            : `Weekly Summary: You earned ${tokens} tokens from ${submissions} submissions this week. Health trend: ${trendEN}.`;

          await notificationsQueue.add("send-telegram", {
            telegramId: user.telegram_id,
            message
          });

        } else if (user.role === "agent") {
          // B. Agent stats
          const syncsRes = await query(
            `SELECT COUNT(*)::int AS syncs
             FROM token_ledger
             WHERE user_id = $1 AND transaction_type = 'atmospheric_sync' AND created_at >= CURRENT_DATE - INTERVAL '7 days'`,
            [user.id]
          );
          const tokensRes = await query(
            `SELECT COALESCE(SUM(amount), 0)::int AS tokens
             FROM token_ledger
             WHERE user_id = $1 AND transaction_type = 'atmospheric_sync' AND amount > 0 AND created_at >= CURRENT_DATE - INTERVAL '7 days'`,
            [user.id]
          );
          const rankRes = await query(
            `WITH agent_syncs AS (
               SELECT 
                 u.id AS user_id,
                 COUNT(CASE WHEN ar.recorded_at >= CURRENT_DATE - INTERVAL '7 days' THEN ar.id END) AS sync_count_this_week,
                 COUNT(CASE WHEN ar.recorded_at >= CURRENT_DATE - INTERVAL '14 days' AND ar.recorded_at < CURRENT_DATE - INTERVAL '7 days' THEN ar.id END) AS sync_count_last_week
               FROM users u
               JOIN agent_profiles ap ON u.id = ap.user_id
               LEFT JOIN atmospheric_readings ar ON u.id = ar.user_id AND ar.verified = TRUE
               WHERE u.county = (SELECT county FROM users WHERE id = $1)
               GROUP BY u.id
             ),
             ranked_this_week AS (
               SELECT user_id, RANK() OVER (ORDER BY sync_count_this_week DESC, user_id) AS rank_this_week
               FROM agent_syncs
             ),
             ranked_last_week AS (
               SELECT user_id, RANK() OVER (ORDER BY sync_count_last_week DESC, user_id) AS rank_last_week
               FROM agent_syncs
             )
             SELECT rtw.rank_this_week::int, rlw.rank_last_week::int
             FROM ranked_this_week rtw
             JOIN ranked_last_week rlw ON rtw.user_id = rlw.user_id
             WHERE rtw.user_id = $1`,
            [user.id]
          );

          const syncs = syncsRes.rows[0]?.syncs || 0;
          const tokens = tokensRes.rows[0]?.tokens || 0;
          const rankThisWeek = rankRes.rows[0]?.rank_this_week;
          const rankLastWeek = rankRes.rows[0]?.rank_last_week;

          let rankChange = "+0";
          if (rankThisWeek !== undefined && rankLastWeek !== undefined) {
            const diff = rankLastWeek - rankThisWeek;
            if (diff > 0) {
              rankChange = `+${diff}`;
            } else if (diff < 0) {
              rankChange = `${diff}`;
            }
          }

          const message = user.language === "sw"
            ? `Muhtasari wa Wiki: Umekamilisha usawazishaji ${syncs}, mabadiliko ya kiwango: ${rankChange}, na umepata tokeni ${tokens}.`
            : `Weekly Summary: You completed ${syncs} syncs, rank change: ${rankChange}, and earned ${tokens} tokens.`;

          await notificationsQueue.add("send-telegram", {
            telegramId: user.telegram_id,
            message
          });
        }
      }
    } catch (err: any) {
      console.error("Failed to execute weekly summaries cron generator:", err.message);
      throw err;
    }
  }

  // =========================================================================
  // --- Internal Helpers ----------------------------------------------------
  // =========================================================================

  private async getUserDetails(userId: string): Promise<{ telegram_id: string; language: string } | null> {
    try {
      const res = await query(
        "SELECT telegram_id::text AS telegram_id, language FROM users WHERE id = $1",
        [userId]
      );
      if (res.rows.length === 0) return null;
      return res.rows[0];
    } catch (err: any) {
      console.warn(`User details lookup failed for ID ${userId}:`, err.message);
      return null;
    }
  }
}

export const notificationService = new NotificationService();
