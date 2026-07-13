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

import { TopicCreateTransaction } from "@hashgraph/sdk";
import { hederaService } from "../services/hederaService";
import { env } from "../config/env";

async function main() {
  console.log("Checking HCS topic setup...");
  const existingTopicId = env.DIRA_HCS_TOPIC_ID;

  // Let's verify if DIRA_HCS_TOPIC_ID is a dummy/placeholder like "0.0.12345" or unset
  if (existingTopicId && existingTopicId !== "0.0.12345" && existingTopicId.trim() !== "") {
    console.log(`Topic ID already exists in env: ${existingTopicId}`);
    console.log("Idempotent check passed. Exiting.");
    return;
  }

  let client;
  try {
    client = await hederaService.getClient(false);
    console.log("Creating new HCS topic...");

    const txResponse = await new TopicCreateTransaction()
      .setTopicMemo("Dira Africa climate-data provenance")
      .execute(client);

    const receipt = await txResponse.getReceipt(client);
    const topicId = receipt.topicId?.toString();

    if (!topicId) {
      throw new Error("Receipt did not return a valid Topic ID.");
    }

    console.log(`\n🎉 HCS Topic Created Successfully!`);
    console.log(`--------------------------------------------------`);
    console.log(`Topic ID:     ${topicId}`);
    console.log(`HashScan URL: https://hashscan.io/testnet/topic/${topicId}`);
    console.log(`--------------------------------------------------`);
    console.log(`\n👉 ACTION REQUIRED: Add/update the following in your dira-api/.env file:`);
    console.log(`DIRA_HCS_TOPIC_ID=${topicId}\n`);

  } catch (error: any) {
    const errMsg = error?.message || String(error);
    if (errMsg.includes("INVALID_SIGNATURE")) {
      console.error("\n❌ Hedera Signature Error (INVALID_SIGNATURE)");
      console.error("--------------------------------------------------");
      console.error("The transaction failed because the signature is invalid.");
      console.error("This is usually caused by a key type mismatch (e.g. raw ECDSA key parsed as ED25519).");
      console.error("Please ensure that you set HEDERA_OPERATOR_KEY_TYPE=ECDSA in your .env file.");
      console.error("--------------------------------------------------\n");
    } else {
      console.error("❌ Failed to create HCS topic:", errMsg);
    }
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        client.close();
      } catch (err) {
        // ignore
      }
    }
  }
}

main();
