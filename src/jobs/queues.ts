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

import { Queue, QueueOptions } from "bullmq";
import { env } from "../config/env";

// Parse Redis URL safely for BullMQ connection options
const parseRedisUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch (err) {
    return {
      host: "127.0.0.1",
      port: 6379,
    };
  }
};

export const connection = parseRedisUrl(env.REDIS_URL);

const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: "exponential" as const,
    delay: 5000,
  },
};

const queueOptions: QueueOptions = {
  connection,
  defaultJobOptions,
};

// Export four specific BullMQ queues
export const photoVerificationQueue = new Queue("photo-verification", queueOptions);
export const atmosphericVerificationQueue = new Queue("atmospheric-verification", queueOptions);
export const notificationsQueue = new Queue("notifications", queueOptions);
export const hederaAnchorQueue = new Queue("hedera-anchor", queueOptions);
