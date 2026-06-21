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

import { zkVerifySession, Library, CurveType } from "zkverifyjs";
import { query } from "../db/query";

const db = { query };

/**
 * Weekly batch proof to zkVerify.
 * Submits Groth16 proof to zkVerify session, waits for receipt aggregation, and inserts root.
 */
export async function anchorWeeklyBatch(
  proof: any,
  publicSignals: any,
  vk: any
): Promise<any> {
  const session = await zkVerifySession
    .start()
    .zkVerify()
    .withAccount(process.env.ZKVERIFY_SEED_PHRASE!);

  const domainId = Number(process.env.ZKVERIFY_DOMAIN_ID);

  const { events, transactionResult } = await session.verify()
    .groth16({ library: Library.snarkjs, curve: CurveType.bn128 })
    .execute({ proofData: { vk, proof, publicSignals }, domainId });

  const txInfo = await transactionResult; // statement + aggregationId

  // Wait for the published aggregation receipt (Merkle root)
  const receipt = await session.waitForAggregationReceipt(
    domainId, txInfo.aggregationId!
  );

  const merkleRoot = (receipt as any).root || receipt.receipt;

  // Persist the root + statement path for on-chain attestation
  await db.query(
    `INSERT INTO zkverify_anchors
       (domain_id, aggregation_id, merkle_root, statement, anchored_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [domainId, txInfo.aggregationId!, merkleRoot, txInfo.statement]
  );

  await session.close();
  return receipt;
}
