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

import { Worker, Job } from "bullmq";
import { connection, notificationsQueue } from "./queues";
import { query } from "../db/query";
import { processPhotoVerification } from "./photoVerificationJob";
import { processAtmosphericVerification } from "./atmosphericVerificationJob";
import { processNotification } from "./notificationJob";
import { processXionAnchor } from "./xionAnchorJob";

// Helper: Handle job attempt failure (transient error)
async function handleJobAttemptFailed(job: Job, err: Error) {
  try {
    if (job.queueName === "photo-verification" && job.data.submissionId) {
      await query(
        `UPDATE crop_submissions 
         SET verification_status = 'failed', 
             rejection_reason = $1 
         WHERE id = $2`,
        [err.message || "Transient error", job.data.submissionId]
      );
    } else if (job.queueName === "atmospheric-verification" && job.data.readingId) {
      await query(
        `UPDATE token_ledger 
         SET notes = 'failed' 
         WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync'`,
        [job.data.readingId]
      );
    }
  } catch (dbErr) {
    console.error(`Failed to update transient failure status for job ${job.id}:`, dbErr);
  }
}

// Helper: Handle job retries exhausted (permanent error)
async function handleJobRetriesExhausted(job: Job, err: Error) {
  try {
    if (job.queueName === "photo-verification" && job.data.submissionId) {
      await query(
        `UPDATE crop_submissions 
         SET verification_status = 'manual_review', 
             rejection_reason = $1 
         WHERE id = $2`,
        [`Retries exhausted: ${err.message || "Permanent error"}`, job.data.submissionId]
      );
    } else if (job.queueName === "atmospheric-verification" && job.data.readingId) {
      await query(
        `UPDATE token_ledger 
         SET notes = 'manual_review' 
         WHERE reference_id = $1 AND transaction_type = 'atmospheric_sync'`,
        [job.data.readingId]
      );
    }
  } catch (dbErr) {
    console.error(`Failed to update manual_review status for job ${job.id}:`, dbErr);
  }
}

// Helper: Send Telegram notification to admin user
async function sendAdminNotification(job: Job, err: Error) {
  try {
    const adminRes = await query(
      "SELECT telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL LIMIT 1"
    );
    const adminTelegramId = adminRes.rows[0]?.telegram_id;
    if (adminTelegramId) {
      await notificationsQueue.add("send-telegram", {
        telegramId: String(adminTelegramId),
        message: `🚨 ALERT: Job [${job.queueName}] ${job.name} (ID: ${job.id}) has failed after all retries. Reason: ${err.message}. Marked for manual_review.`
      });
      console.log(`Queued admin Telegram notification for failed job ${job.id}`);
    } else {
      console.warn("No admin user with a registered Telegram ID found to notify.");
    }
  } catch (notifyErr) {
    console.error("Failed to send admin notification:", notifyErr);
  }
}

// Worker execution wrapper to handle retries and statuses
function createWorkerProcessor(handler: (job: Job) => Promise<any>) {
  return async (job: Job) => {
    try {
      console.log(`Worker processing job ${job.id} from queue [${job.queueName}]`);
      const result = await handler(job);
      return result;
    } catch (err: any) {
      const maxAttempts = job.opts.attempts || 3;
      const attemptsTried = job.attemptsMade + 1;
      
      console.error(
        `Job ${job.name} (${job.id}) in queue [${job.queueName}] failed (Attempt ${attemptsTried}/${maxAttempts}): ${err.message}`
      );

      if (attemptsTried >= maxAttempts) {
        await handleJobRetriesExhausted(job, err);
        await sendAdminNotification(job, err);
      } else {
        await handleJobAttemptFailed(job, err);
      }

      throw err; // Rethrow so BullMQ schedules retry
    }
  };
}

// Create and export the four workers
export const photoVerificationWorker = new Worker(
  "photo-verification",
  createWorkerProcessor(processPhotoVerification),
  { connection, concurrency: 1 }
);

export const atmosphericVerificationWorker = new Worker(
  "atmospheric-verification",
  createWorkerProcessor(processAtmosphericVerification),
  { connection, concurrency: 1 }
);

export const notificationsWorker = new Worker(
  "notifications",
  createWorkerProcessor(processNotification),
  { connection, concurrency: 1 }
);

export const xionAnchorWorker = new Worker(
  "xion-anchor",
  createWorkerProcessor(processXionAnchor),
  { connection, concurrency: 1 }
);

// Worker events loggers
const workers = [
  photoVerificationWorker,
  atmosphericVerificationWorker,
  notificationsWorker,
  xionAnchorWorker
];

workers.forEach(w => {
  w.on("completed", (job) => {
    console.log(`Worker completed job ${job.id} successfully in queue [${w.name}].`);
  });
  w.on("failed", (job, err) => {
    console.error(`Worker reported permanent failure for job ${job?.id} in queue [${w.name}]: ${err.message}`);
  });
});
