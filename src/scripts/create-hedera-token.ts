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

import { TokenCreateTransaction, TokenType, TokenSupplyType, PrivateKey } from "@hashgraph/sdk";
import { hederaService } from "../services/hederaService";
import { env } from "../config/env";
import { query } from "../db/query";

async function main() {
  console.log("Checking HTS token setup...");
  const existingTokenId = env.DIRA_HTS_TOKEN_ID;

  if (existingTokenId && existingTokenId !== "0.0.67890" && existingTokenId.trim() !== "") {
    console.log(`Token ID already exists in env: ${existingTokenId}`);
    console.log("Idempotent check passed. Exiting.");
    return;
  }

  let client;
  try {
    client = await hederaService.getClient(false);
    console.log("Creating new HTS Climate Token...");

    const operatorKey = await hederaService.getOperatorKey();
    const operatorId = env.HEDERA_OPERATOR_ID;
    if (!operatorId) {
      throw new Error("HEDERA_OPERATOR_ID is not defined in env.");
    }
    const network = env.HEDERA_NETWORK || "testnet";

    const transaction = new TokenCreateTransaction()
      .setTokenName("Dira Climate Token")
      .setTokenSymbol("DIRA")
      .setDecimals(2)
      .setInitialSupply(0)
      .setTreasuryAccountId(operatorId)
      .setSupplyKey(operatorKey)
      .setTokenType(TokenType.FungibleCommon)
      .setSupplyType(TokenSupplyType.Infinite);

    const txResponse = await transaction.execute(client);
    const receipt = await txResponse.getReceipt(client);
    const tokenId = receipt.tokenId?.toString();

    if (!tokenId) {
      throw new Error("Receipt did not return a valid Token ID.");
    }

    console.log(`\n🎉 HTS Token Created Successfully!`);
    console.log(`--------------------------------------------------`);
    console.log(`Token ID:     ${tokenId}`);
    console.log(`HashScan URL: https://hashscan.io/testnet/token/${tokenId}`);
    console.log(`--------------------------------------------------`);

    console.log("Saving token configuration to database...");
    try {
      await query(
        "INSERT INTO hts_token_config (token_id, network, treasury_account) VALUES ($1, $2, $3)",
        [tokenId, network, operatorId]
      );
      console.log("Successfully recorded token configuration in database table 'hts_token_config'.");
    } catch (dbError: any) {
      console.warn(`\n⚠️ Warning: Could not write token to database. (Database might be offline: ${dbError?.message || dbError})`);
      console.warn(`Please ensure migration 018 has run and insert manually when the database is online:`);
      console.warn(`INSERT INTO hts_token_config (token_id, network, treasury_account) VALUES ('${tokenId}', '${network}', '${operatorId}');\n`);
    }

    console.log(`\n👉 ACTION REQUIRED: Add/update the following in your dira-api/.env file:`);
    console.log(`DIRA_HTS_TOKEN_ID=${tokenId}\n`);

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
      console.error("❌ Failed to create HTS token:", errMsg);
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
