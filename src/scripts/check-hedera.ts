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

import { AccountBalanceQuery, AccountId } from "@hashgraph/sdk";
import { hederaService } from "../services/hederaService";
import { env } from "../config/env";

async function main() {
  console.log("Starting Hedera connectivity and balance check...");
  let client;
  try {
    // Get client for the network configured in env (defaulting to testnet)
    client = hederaService.getClient(false);

    const operatorId = env.HEDERA_OPERATOR_ID;
    if (!operatorId) {
      throw new Error("HEDERA_OPERATOR_ID is not defined in env.");
    }

    console.log(`Querying balance for operator ID: ${operatorId}...`);
    
    const balance = await new AccountBalanceQuery()
      .setAccountId(AccountId.fromString(operatorId))
      .execute(client);

    console.log(`Balance Query Successful!`);
    console.log(`----------------------------------------`);
    console.log(`Operator ID:  ${operatorId}`);
    console.log(`HBAR Balance: ${balance.hbars.toString()}`);
    console.log(`----------------------------------------`);
  } catch (error: any) {
    console.error("❌ Connectivity check failed:", error?.message || error);
    process.exitCode = 1;
  } finally {
    if (client) {
      try {
        client.close();
      } catch (err) {
        // ignore close error
      }
    }
    console.log("Check complete.");
  }
}

main();
