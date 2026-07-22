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

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { Queue } from "bullmq";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  hederaAnchorQueue,
  airtimeQueue
} from "../jobs/queues";
import {
  photoVerificationWorker,
  atmosphericVerificationWorker,
  notificationsWorker,
  hederaAnchorWorker,
  airtimeWorker
} from "../jobs/workers";

declare module "fastify" {
  interface FastifyInstance {
    photoVerificationQueue: Queue;
    atmosphericVerificationQueue: Queue;
    notificationsQueue: Queue;
    hederaAnchorQueue: Queue;
    airtimeQueue: Queue;
    // Keep compatibility helper jobsQueue targeting the photoVerificationQueue
    jobsQueue: Queue;
  }
}

const jobsPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Decorate fastify with the four specific queues
  fastify.decorate("photoVerificationQueue", photoVerificationQueue);
  fastify.decorate("atmosphericVerificationQueue", atmosphericVerificationQueue);
  fastify.decorate("notificationsQueue", notificationsQueue);
  fastify.decorate("hederaAnchorQueue", hederaAnchorQueue);
  fastify.decorate("airtimeQueue", airtimeQueue);
  
  // Keep compatibility decorator
  fastify.decorate("jobsQueue", photoVerificationQueue);

  fastify.log.info("BullMQ background job queues and workers initialized.");

  // Setup repeatable schedules on respective queues
  try {
    // A. Weekly Hedera Anchoring repeatable job (runs daily at midnight to find completed weeks)
    const hederaRepeatable = await hederaAnchorQueue.getRepeatableJobs();
    for (const rJob of hederaRepeatable) {
      if (rJob.name === "hedera-weekly-anchoring") {
        await hederaAnchorQueue.removeRepeatableByKey(rJob.key);
      }
    }
    await hederaAnchorQueue.add(
      "hedera-weekly-anchoring",
      {},
      {
        repeat: {
          pattern: "0 0 * * *", // Daily at midnight
        },
        jobId: "hedera-weekly-anchoring-job"
      }
    );

    // E. Hedera Mirror Node indexing repeatable job (runs every 5 minutes)
    for (const rJob of hederaRepeatable) {
      if (rJob.name === "hedera-mirror-indexing") {
        await hederaAnchorQueue.removeRepeatableByKey(rJob.key);
      }
    }
    await hederaAnchorQueue.add(
      "hedera-mirror-indexing",
      {},
      {
        repeat: {
          pattern: "*/5 * * * *", // Every 5 minutes
        },
        jobId: "hedera-mirror-indexing-job"
      }
    );

    // Nightly DPA Compliance cleanup job (runs daily at 2am EAT)
    for (const rJob of hederaRepeatable) {
      if (rJob.name === "nightly-dpa-cleanup") {
        await hederaAnchorQueue.removeRepeatableByKey(rJob.key);
      }
    }
    await hederaAnchorQueue.add(
      "nightly-dpa-cleanup",
      {},
      {
        repeat: {
          pattern: "0 2 * * *", // Daily at 2am EAT
          tz: "Africa/Nairobi"
        },
        jobId: "nightly-dpa-cleanup-job"
      }
    );

    // B. Passive agent sync polling repeatable job (runs every 6 hours)
    const atmosphericRepeatable = await atmosphericVerificationQueue.getRepeatableJobs();
    for (const rJob of atmosphericRepeatable) {
      await atmosphericVerificationQueue.removeRepeatableByKey(rJob.key);
    }
    await atmosphericVerificationQueue.add(
      "passive-agent-sync-polling",
      {},
      {
        repeat: {
          pattern: "0 */6 * * *", // Every 6 hours
        },
        jobId: "passive-agent-sync-polling-job"
      }
    );

    // C. Sync reminders repeatable job (runs 4x daily: 7am, 12pm, 5pm, 9pm EAT)
    const remindersRepeatable = await notificationsQueue.getRepeatableJobs();
    for (const rJob of remindersRepeatable) {
      if (rJob.name === "sync-reminders") {
        await notificationsQueue.removeRepeatableByKey(rJob.key);
      }
    }
    await notificationsQueue.add(
      "sync-reminders",
      {},
      {
        repeat: {
          pattern: "0 7,12,17,21 * * *", // 7am, 12pm, 5pm, 9pm EAT
          tz: "Africa/Nairobi"
        },
        jobId: "sync-reminders-job"
      }
    );

    // D. Weekly summaries repeatable job (runs every Sunday at 7pm EAT)
    const summariesRepeatable = await notificationsQueue.getRepeatableJobs();
    for (const rJob of summariesRepeatable) {
      if (rJob.name === "weekly-summaries") {
        await notificationsQueue.removeRepeatableByKey(rJob.key);
      }
    }
    await notificationsQueue.add(
      "weekly-summaries",
      {},
      {
        repeat: {
          pattern: "0 19 * * 0", // Sunday at 7pm EAT
          tz: "Africa/Nairobi"
        },
        jobId: "weekly-summaries-job"
      }
    );

    fastify.log.info("Repeatable job schedules registered successfully.");
  } catch (err: any) {
    fastify.log.error(`Failed to register job schedules: ${err.message}`);
  }

  // Graceful shutdown hooks
  fastify.addHook("onClose", async (instance) => {
    instance.log.info("Shutting down BullMQ queues and workers...");
    
    // Close workers
    await photoVerificationWorker.close();
    await atmosphericVerificationWorker.close();
    await notificationsWorker.close();
    await hederaAnchorWorker.close();
    await airtimeWorker.close();

    // Close queues
    await photoVerificationQueue.close();
    await atmosphericVerificationQueue.close();
    await notificationsQueue.close();
    await hederaAnchorQueue.close();
    await airtimeQueue.close();

    instance.log.info("BullMQ shut down successfully.");
  });
};

export default fp(jobsPlugin);
