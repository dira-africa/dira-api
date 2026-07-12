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

/**
 * Milestone 1 Evidence Script
 *
 * Standalone script — does NOT require PostgreSQL or Redis.
 * Connects directly to Hedera testnet and:
 *   1. Submits a real HCS message (crop-attestation SHA-256 hash)
 *   2. Mints 5 DIRA Climate Tokens on HTS (simulating a farmer reward)
 *
 * Run:  node ./node_modules/tsx/dist/cli.mjs src/scripts/milestone1-evidence.ts
 *
 * Output: HashScan links ready for MILESTONE-1.md
 */

import dotenv from "dotenv";
dotenv.config();

import {
  Client,
  AccountId,
  PrivateKey,
  TopicMessageSubmitTransaction,
  TokenMintTransaction,
} from "@hashgraph/sdk";
import { createHash } from "crypto";

// ── helpers ──────────────────────────────────────────────────────────────────

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function buildClient(): Client {
  const operatorId  = getEnv("HEDERA_OPERATOR_ID");
  const rawKey      = getEnv("HEDERA_OPERATOR_KEY");
  const keyType     = process.env.HEDERA_OPERATOR_KEY_TYPE || "ECDSA";
  const cleanKey    = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;

  const privateKey =
    keyType === "ECDSA"
      ? PrivateKey.fromStringECDSA(cleanKey)
      : PrivateKey.fromStringED25519(cleanKey);

  const client = Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), privateKey);
  return client;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("   Dira Africa — Milestone 1 Evidence Run (Hedera Testnet)");
  console.log("══════════════════════════════════════════════════════════════\n");

  const topicId   = getEnv("DIRA_HCS_TOPIC_ID");
  const tokenId   = getEnv("DIRA_HTS_TOKEN_ID");
  const operatorId = getEnv("HEDERA_OPERATOR_ID");

  console.log(`Operator:         ${operatorId}`);
  console.log(`HCS Topic:        ${topicId}  → https://hashscan.io/testnet/topic/${topicId}`);
  console.log(`HTS Token:        ${tokenId}  → https://hashscan.io/testnet/token/${tokenId}`);
  console.log("");

  const client = buildClient();

  // ── 1. Simulate a crop-submission payload and hash it ─────────────────────
  const submissionId = "00000000-0001-0001-0001-000000000001"; // deterministic fixture
  const payload = {
    id:              submissionId,
    userId:          "farmer-00001",
    farmId:          "farm-00001",
    cropType:        "maize",
    growthStage:     "vegetative",
    aiHealthScore:   0.87,
    aiConfidence:    0.91,
    aiDetectedIssues: {},
    latitude:        -1.2921,
    longitude:       36.8219,
    submittedAt:     "2026-07-12T20:00:00.000Z",
  };

  const canonicalPayload = JSON.stringify(payload, Object.keys(payload).sort());
  const sha256 = createHash("sha256").update(canonicalPayload).digest("hex");

  console.log("── Step 1: Submitting crop-attestation hash to HCS ──────────");
  console.log(`Submission ID:    ${submissionId}`);
  console.log(`SHA-256 hash:     ${sha256}`);
  console.log("");

  const hcsMessage = JSON.stringify({
    type:         "crop_submission",
    submissionId,
    sha256,
    milestone:    "M1-evidence",
  });

  let hcsTxId: string;
  let hcsSeqNum: number;
  let hcsConsensusTs: string;

  try {
    const hcsTx = new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(hcsMessage);

    const hcsResponse  = await hcsTx.execute(client);
    const hcsRecord    = await hcsResponse.getRecord(client);
    const hcsReceipt   = hcsRecord.receipt;

    hcsTxId       = hcsResponse.transactionId.toString();
    hcsSeqNum     = hcsReceipt.topicSequenceNumber
                      ? hcsReceipt.topicSequenceNumber.toNumber()
                      : 0;
    hcsConsensusTs = hcsRecord.consensusTimestamp
                      ? hcsRecord.consensusTimestamp.toDate().toISOString()
                      : new Date().toISOString();

    console.log("✅  HCS message submitted successfully!");
    console.log(`   Tx ID:               ${hcsTxId}`);
    console.log(`   Sequence number:     ${hcsSeqNum}`);
    console.log(`   Consensus timestamp: ${hcsConsensusTs}`);
    // Build a deep-link to the exact message on HashScan
    const hcsLink = `https://hashscan.io/testnet/topic/${topicId}`;
    console.log(`   HashScan topic:      ${hcsLink}`);
    console.log("");
  } catch (err: any) {
    console.error("❌  HCS submission failed:", err.message);
    client.close();
    process.exitCode = 1;
    return;
  }

  // ── 2. Mint 5 DIRA tokens on HTS (simulate 5-token crop-photo reward) ─────
  console.log("── Step 2: Minting 5 DIRA tokens on HTS ────────────────────");
  console.log("   (5 tokens × 100 units/token = 500 units, 2 decimal places)");
  console.log("");

  let htsTxId: string;

  try {
    const mintTx = new TokenMintTransaction()
      .setTokenId(tokenId)
      .setAmount(500); // 5.00 DIRA (2 decimals)

    const mintResponse = await mintTx.execute(client);
    await mintResponse.getReceipt(client);
    htsTxId = mintResponse.transactionId.toString();

    console.log("✅  HTS mint successful!");
    console.log(`   Tx ID:               ${htsTxId}`);
    const htsLink = `https://hashscan.io/testnet/token/${tokenId}`;
    console.log(`   HashScan token:      ${htsLink}`);
    console.log("");
  } catch (err: any) {
    console.error("❌  HTS mint failed:", err.message);
    client.close();
    process.exitCode = 1;
    return;
  }

  client.close();

  // ── Summary for MILESTONE-1.md ────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════");
  console.log("   EVIDENCE SUMMARY  — paste into MILESTONE-1.md");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`HCS_TOPIC_ID       = ${topicId}`);
  console.log(`HTS_TOKEN_ID       = ${tokenId}`);
  console.log(`HCS_TX_ID          = ${hcsTxId}`);
  console.log(`HCS_SEQUENCE_NUM   = ${hcsSeqNum}`);
  console.log(`HCS_CONSENSUS_TS   = ${hcsConsensusTs}`);
  console.log(`PAYLOAD_SHA256     = ${sha256}`);
  console.log(`HTS_MINT_TX_ID     = ${htsTxId}`);
  console.log("");
  console.log(`HashScan HCS topic:  https://hashscan.io/testnet/topic/${topicId}`);
  console.log(`HashScan HTS token:  https://hashscan.io/testnet/token/${tokenId}`);
  console.log("");
  console.log("Open the HashScan links above to verify on-chain evidence.");
  console.log("══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
