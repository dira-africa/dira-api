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

import { airtimeService } from "../services/airtimeService";
import { Job } from "bullmq";

export async function processAirtimeRedemption(job: Job) {
  const { redemptionId, userId, phoneNumber, tokenAmount } = job.data;
  console.log(`Starting background airtime disbursement job: ${redemptionId} for user ${userId}...`);
  const result = await airtimeService.processQueuedAirtime(redemptionId, userId, phoneNumber, tokenAmount);
  console.log(`Completed background airtime disbursement job: ${redemptionId}:`, result);
  return result;
}
