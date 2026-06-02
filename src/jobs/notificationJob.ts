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
import { notificationService } from "../services/notificationService";

export async function processNotification(job: Job) {
  if (job.name === "sync-reminders") {
    await notificationService.sendSyncReminders();
    return { success: true };
  }

  if (job.name === "weekly-summaries") {
    await notificationService.sendWeeklySummaries();
    return { success: true };
  }

  const { telegramId, message } = job.data || {};
  if (!telegramId || !message) {
    throw new Error("Missing telegramId or message in notification job data");
  }
  const result = await notificationService.sendTelegramNotification(telegramId, message);
  return { success: result };
}
