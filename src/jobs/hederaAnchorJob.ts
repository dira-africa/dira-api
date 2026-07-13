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

import { hederaAnchorService } from "../services/hederaAnchorService";
import { hederaMirrorIndexerService } from "../services/hederaMirrorIndexerService";
import { Job } from "bullmq";

export async function processHederaAnchor(job: Job) {
  if (job.name === "hedera-mirror-indexing") {
    console.log("Starting Hedera Mirror Node indexing/reconciliation job...");
    const result = await hederaMirrorIndexerService.indexPendingEvents();
    console.log("Completed Hedera Mirror Node indexing:", result);
    return result;
  }

  if (job.name === "anchor-submission") {
    const { submissionId } = job.data;
    console.log(`Starting Hedera anchoring for submission: ${submissionId}...`);
    const result = await hederaAnchorService.anchor(submissionId);
    console.log(`Completed Hedera anchoring for submission: ${submissionId}:`, result);
    return result;
  }

  console.log("Starting Hedera historical/catchup anchoring job...");
  const result = await hederaAnchorService.anchorAllCompletedWeeks();
  console.log("Completed Hedera weekly anchoring:", result);
  return result;
}
