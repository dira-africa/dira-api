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
import { notificationsQueue } from "../jobs/queues";

export interface AlertOptions {
  metric: string;            // e.g. "rainfall", "temperature", "wind"
  unit: string;              // e.g. "mm", "°C", "km/h"
  probability: number;       // e.g. 75
  credibleInterval: [number, number]; // [low, high] e.g. [60, 80]
  confidence: "high" | "low";
  action: string;            // clear protective action e.g. "dig drainage channels"
  escalation: string;        // escalation trigger explanation e.g. "rainfall exceeds 100mm"
}

const METRIC_TRANSLATIONS: Record<string, string> = {
  rainfall: "mvua",
  temperature: "joto",
  wind: "upepo",
  storm: "dhoruba",
  flood: "mafuriko",
  humidity: "unyevunyevu"
};

const ACTION_TRANSLATIONS: Record<string, string> = {
  "dig drainage channels": "kuchimba mifereji ya kupitisha maji",
  "mulch soil to retain moisture": "kuweka matandazo ili kuhifadhi unyevu",
  "harvest early": "kuvuna mapema",
  "delay planting": "kuchelewesha kupanda",
  "cover nursery beds": "kufunika vitalu vya miche",
  "apply fertilizer": "kuweka mbolea",
  "water the crops": "kumwagilia mimea maji"
};

const ESCALATION_TRANSLATIONS: Record<string, string> = {
  "rainfall probability exceeds 90%": "uwezekano wa mvua ukizidi 90%",
  "wind speeds exceed 50km/h": "kasi ya upepo ikizidi 50km/h",
  "wind speeds top 60km/h": "kasi ya upepo ikizidi 60km/h",
  "temperature rises above 35c": "joto likipanda zaidi ya nyuzi joto 35",
  "the forecast strengthens": "utabiri unapoimarika",
  "rainfall exceeds 100mm": "mvua ikizidi 100mm"
};

function translate(text: string, dict: Record<string, string>): string {
  const normalized = text.trim().toLowerCase();
  return dict[normalized] || text;
}

export class AlertComposerService {
  /**
   * Translates a Bayesian estimation into a three-part message reflecting the confidence level.
   */
  composeMessage(options: AlertOptions, lang: "en" | "sw"): string {
    const { metric, unit, probability, credibleInterval, confidence, action, escalation } = options;
    const [low, high] = credibleInterval;

    if (lang === "en") {
      if (confidence === "high") {
        // High-confidence English: firm, direct phrasing
        return `Dira Climate Alert: Weather models show a high-confidence range of ${low}–${high} ${unit} for ${metric} with a ${probability}% probability. ACTION: You should ${action} immediately. ESCALATION: We will alert again if ${escalation}.`;
      } else {
        // Low-confidence English: tentative, cautious phrasing
        return `Dira Climate Alert: Weather models suggest a possible, tentative range of ${low}–${high} ${unit} for ${metric} (low confidence, ${probability}% probability). ACTION: Consider choosing to ${action} as a precaution. ESCALATION: We will monitor and alert again if the forecast becomes more certain.`;
      }
    } else {
      // Swahili translations
      const tMetric = translate(metric, METRIC_TRANSLATIONS);
      const tAction = translate(action, ACTION_TRANSLATIONS);
      const tEscalation = translate(escalation, ESCALATION_TRANSLATIONS);

      if (confidence === "high") {
        // High-confidence Swahili: firm, direct phrasing
        return `Tahadhari ya Dira: Mifano ya hewa inaonyesha uhakika mkubwa wa kiwango cha ${low}–${high} ${unit} za ${tMetric} kwa uwezekano wa ${probability}%. HATUA: Unapaswa ${tAction} mara moja. MABADILIKO: Tutatoa tahadhari tena ikiwa ${tEscalation}.`;
      } else {
        // Low-confidence Swahili: tentative, cautious phrasing
        return `Tahadhari ya Dira: Mifano ya hewa inaashiria uwezekano mdogo tu wa kiwango cha ${low}–${high} ${unit} za ${tMetric} (uhakika mdogo, uwezekano wa ${probability}%). HATUA: Fikiria kuanza ${tAction} kama tahadhari. MABADILIKO: Tutafuatilia kwa karibu na kutoa tahadhari tena ikiwa utabiri utakuwa na uhakika zaidi.`;
      }
    }
  }

  /**
   * Composes, rate-limits, and schedules a climate alert for a specific farmer.
   */
  async sendAlertToUser(userId: string, options: AlertOptions): Promise<{ success: boolean; status: string; message: string }> {
    // 1. Fetch user alert preference and language
    const userRes = await query("SELECT telegram_id, language, alerts_enabled FROM users WHERE id = $1", [userId]);
    if (userRes.rows.length === 0) {
      throw new Error(`User with ID ${userId} not found`);
    }

    const { telegram_id: telegramId, language: userLang, alerts_enabled: alertsEnabled } = userRes.rows[0];
    const lang: "en" | "sw" = userLang === "en" ? "en" : "sw"; // default to sw

    // Compile message
    const message = this.composeMessage(options, lang);

    // 2. Handle user opt-out
    if (!alertsEnabled) {
      await query(
        `INSERT INTO farmer_climate_alerts (user_id, metric, probability_estimate, credible_interval_low, credible_interval_high, confidence_level, protective_action, escalation_trigger, message, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
        [userId, options.metric, options.probability, options.credibleInterval[0], options.credibleInterval[1], options.confidence, options.action, options.escalation, message, "opted_out"]
      );
      return { success: false, status: "opted_out", message };
    }

    // 3. Handle rate-limiting (maximum 1 alert per 4 hours)
    const rateLimitRes = await query(
      `SELECT created_at FROM farmer_climate_alerts 
       WHERE user_id = $1 AND status = 'sent' AND created_at >= NOW() - INTERVAL '4 hours' 
       LIMIT 1`,
      [userId]
    );
    if (rateLimitRes.rows.length > 0) {
      await query(
        `INSERT INTO farmer_climate_alerts (user_id, metric, probability_estimate, credible_interval_low, credible_interval_high, confidence_level, protective_action, escalation_trigger, message, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
        [userId, options.metric, options.probability, options.credibleInterval[0], options.credibleInterval[1], options.confidence, options.action, options.escalation, message, "rate_limited"]
      );
      return { success: false, status: "rate_limited", message };
    }

    // 4. Send Telegram if telegramId exists
    let status = "sent";
    if (telegramId) {
      await notificationsQueue.add("send-telegram", {
        telegramId: String(telegramId),
        message
      });
    } else {
      status = "no_telegram";
    }

    // Log the successful sent status
    await query(
      `INSERT INTO farmer_climate_alerts (user_id, metric, probability_estimate, credible_interval_low, credible_interval_high, confidence_level, protective_action, escalation_trigger, message, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [userId, options.metric, options.probability, options.credibleInterval[0], options.credibleInterval[1], options.confidence, options.action, options.escalation, message, status, new Date()]
    );

    return { success: true, status, message };
  }

  /**
   * Dispatches alerts to all active/opted-in farmers in a specific county.
   */
  async sendAlertToCounty(county: string, options: AlertOptions): Promise<{ total: number; sent: number }> {
    const farmersRes = await query("SELECT id FROM users WHERE role = 'farmer' AND county = $1 AND is_active = TRUE", [county]);
    let sentCount = 0;
    for (const row of farmersRes.rows) {
      const res = await this.sendAlertToUser(row.id, options);
      if (res.success) {
        sentCount++;
      }
    }
    return { total: farmersRes.rows.length, sent: sentCount };
  }
}

export const alertComposerService = new AlertComposerService();
