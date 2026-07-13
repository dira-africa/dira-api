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
import { env } from "../config/env";

export class HederaMirrorIndexerService {
  private getMirrorNodeHost(): string {
    const network = env.HEDERA_NETWORK ? env.HEDERA_NETWORK.toLowerCase() : "testnet";
    return `${network === "mainnet" ? "mainnet" : "testnet"}.mirrornode.hedera.com`;
  }

  /**
   * Polls the mirror node REST API to reconcile HCS topic messages and HTS token transactions.
   */
  async indexPendingEvents(): Promise<{
    attestationsIndexed: number;
    transactionsIndexed: number;
  }> {
    let attestationsIndexed = 0;
    let transactionsIndexed = 0;

    const network = env.HEDERA_NETWORK || "testnet";
    const topicId = env.DIRA_HCS_TOPIC_ID;
    const tokenId = env.DIRA_HTS_TOKEN_ID;

    // 1. Reconcile HCS Topic Messages
    if (topicId && topicId !== "0.0.12345") {
      try {
        const maxSeqRes = await query(
          "SELECT COALESCE(MAX(sequence_number), 0) AS max_seq FROM hedera_attestations WHERE network = $1",
          [network]
        );
        const maxSeq = Number(maxSeqRes.rows[0].max_seq);

        const host = this.getMirrorNodeHost();
        const url = `https://${host}/api/v1/topics/${topicId}/messages?sequencenumber=gt:${maxSeq}&order=asc&limit=100`;

        console.log(`[MirrorIndexer] Fetching HCS messages since sequence number ${maxSeq} from ${url}...`);
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const messages = data.messages || [];

          for (const msg of messages) {
            try {
              const decoded = Buffer.from(msg.message, "base64").toString("utf-8");
              const payload = JSON.parse(decoded);

              if (payload.type === "crop_submission" && payload.submissionId) {
                const subId = payload.submissionId;
                const sha256 = payload.sha256;
                const consensusTimestamp = new Date(parseFloat(msg.consensus_timestamp) * 1000).toISOString();
                const sequenceNumber = Number(msg.sequence_number);

                // Check if crop submission exists locally
                const subCheck = await query("SELECT id FROM crop_submissions WHERE id = $1", [subId]);
                if (subCheck.rows.length > 0) {
                  // Check if attestation exists
                  const attCheck = await query(
                    "SELECT id FROM hedera_attestations WHERE submission_id = $1 OR (sequence_number = $2 AND network = $3)",
                    [subId, sequenceNumber, network]
                  );

                  if (attCheck.rows.length === 0) {
                    await query(
                      `INSERT INTO hedera_attestations (submission_id, sha256, hcs_topic_id, consensus_timestamp, sequence_number, network)
                       VALUES ($1, $2, $3, $4, $5, $6)`,
                      [subId, sha256, topicId, consensusTimestamp, sequenceNumber, network]
                    );
                    attestationsIndexed++;
                  }
                }
              }
            } catch (err: any) {
              console.warn(`[MirrorIndexer] Failed to process HCS message sequence ${msg.sequence_number}:`, err.message);
            }
          }
        } else {
          console.warn(`[MirrorIndexer] HCS mirror request failed with status: ${res.status}`);
        }
      } catch (err: any) {
        console.error("[MirrorIndexer] Error indexing HCS topic messages:", err);
      }
    }

    // 2. Reconcile HTS Token Transactions
    if (tokenId && tokenId !== "0.0.12345") {
      try {
        const host = this.getMirrorNodeHost();
        const operatorId = env.HEDERA_OPERATOR_ID;
        let url = `https://${host}/api/v1/transactions?limit=100&order=desc`;
        if (operatorId && operatorId !== "your_hedera_operator_account_id" && !operatorId.includes("placeholder")) {
          url = `https://${host}/api/v1/transactions?account.id=${operatorId}&order=desc&limit=100`;
        }

        console.log(`[MirrorIndexer] Fetching HTS transactions from ${url}...`);
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const transactions = data.transactions || [];

          for (const tx of transactions) {
            try {
              if (tx.result !== "SUCCESS") continue;
              if (tx.entity_id !== tokenId) continue;

              const txId = tx.transaction_id;
              const consensusTimestamp = new Date(parseFloat(tx.consensus_timestamp) * 1000).toISOString();
              const normalizedTxId = txId.toLowerCase().replace(/[@.]/g, "-");

              // Reconcile status and txId inside token_transactions and token_ledger
              const dbTxCheck = await query(
                `SELECT id, status, hts_tx_id FROM token_transactions 
                 WHERE LOWER(REPLACE(REPLACE(hts_tx_id, '@', '-'), '.', '-')) = $1`,
                [normalizedTxId]
              );

              if (dbTxCheck.rows.length > 0) {
                const dbRow = dbTxCheck.rows[0];
                if (dbRow.status !== "confirmed" || !dbRow.hts_tx_id) {
                  await query(
                    "UPDATE token_transactions SET status = 'confirmed', hts_tx_id = $1 WHERE id = $2",
                    [txId, dbRow.id]
                  );
                  // Update legacy token_ledger
                  await query(
                    "UPDATE token_ledger SET hts_tx_id = $1 WHERE reference_id = (SELECT reference_id FROM token_transactions WHERE id = $2)",
                    [txId, dbRow.id]
                  );
                  transactionsIndexed++;
                }
              }
            } catch (err: any) {
              console.warn(`[MirrorIndexer] Failed to process HTS transaction ${tx.transaction_id}:`, err.message);
            }
          }
        } else {
          console.warn(`[MirrorIndexer] HTS mirror request failed with status: ${res.status}`);
        }
      } catch (err: any) {
        console.error("[MirrorIndexer] Error indexing HTS token transactions:", err);
      }
    }

    return { attestationsIndexed, transactionsIndexed };
  }

  /**
   * Retrieves aggregated Hedera statistics to power the public dashboard stats page.
   */
  async getDashboardCounters(): Promise<{
    total_attestations: number;
    total_mints: number;
    unique_farmers: number;
    tx_this_month: number;
  }> {
    const attestationsRes = await query("SELECT COUNT(*) AS count FROM hedera_attestations");
    
    const mintsRes = await query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM token_transactions WHERE type = 'earn' AND status = 'confirmed'"
    );

    const farmersRes = await query(
      "SELECT COUNT(DISTINCT user_id) AS count FROM token_transactions WHERE type = 'earn' AND status = 'confirmed'"
    );

    const txThisMonthRes = await query(
      `SELECT (
        (SELECT COUNT(*) FROM hedera_attestations WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)) +
        (SELECT COUNT(*) FROM token_transactions WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE))
      ) AS total`
    );

    return {
      total_attestations: Number(attestationsRes.rows[0]?.count || 0),
      total_mints: Number(mintsRes.rows[0]?.total || 0),
      unique_farmers: Number(farmersRes.rows[0]?.count || 0),
      tx_this_month: Number(txThisMonthRes.rows[0]?.total || 0)
    };
  }
}

export const hederaMirrorIndexerService = new HederaMirrorIndexerService();
