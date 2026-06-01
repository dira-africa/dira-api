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

import { FastifyInstance, FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { Queue } from "bullmq";
import {
  photoVerificationQueue,
  atmosphericVerificationQueue,
  notificationsQueue,
  midnightAnchorQueue
} from "../jobs/queues";
import {
  photoVerificationWorker,
  atmosphericVerificationWorker,
  notificationsWorker,
  midnightAnchorWorker
} from "../jobs/workers";

declare module "fastify" {
  interface FastifyInstance {
    photoVerificationQueue: Queue;
    atmosphericVerificationQueue: Queue;
    notificationsQueue: Queue;
    midnightAnchorQueue: Queue;
    // Keep compatibility helper jobsQueue targeting the photoVerificationQueue
    jobsQueue: Queue;
  }
}

const jobsPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Decorate fastify with the four specific queues
  fastify.decorate("photoVerificationQueue", photoVerificationQueue);
  fastify.decorate("atmosphericVerificationQueue", atmosphericVerificationQueue);
  fastify.decorate("notificationsQueue", notificationsQueue);
  fastify.decorate("midnightAnchorQueue", midnightAnchorQueue);
  
  // Keep compatibility decorator
  fastify.decorate("jobsQueue", photoVerificationQueue);

  fastify.log.info("BullMQ background job queues and workers initialized.");

  // Setup repeatable schedules on respective queues
  try {
    // A. Weekly Midnight Anchoring repeatable job (runs daily at midnight to find completed weeks)
    const midnightRepeatable = await midnightAnchorQueue.getRepeatableJobs();
    for (const rJob of midnightRepeatable) {
      await midnightAnchorQueue.removeRepeatableByKey(rJob.key);
    }
    await midnightAnchorQueue.add(
      "midnight-weekly-anchoring",
      {},
      {
        repeat: {
          pattern: "0 0 * * *", // Daily at midnight
        },
        jobId: "midnight-weekly-anchoring-job"
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
    await midnightAnchorWorker.close();

    // Close queues
    await photoVerificationQueue.close();
    await atmosphericVerificationQueue.close();
    await notificationsQueue.close();
    await midnightAnchorQueue.close();

    instance.log.info("BullMQ shut down successfully.");
  });
};

export default fp(jobsPlugin);
