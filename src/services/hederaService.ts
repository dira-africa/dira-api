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

import { Client, AccountId, PrivateKey } from "@hashgraph/sdk";
import { env } from "../config/env";

export class HederaService {
  /**
   * Builds and returns a configured Hedera client instance.
   * Enforces that requests to use the mainnet are rejected unless allowMainnet is explicitly true.
   */
  getClient(allowMainnet: boolean = false): Client {
    const network = env.HEDERA_NETWORK ? env.HEDERA_NETWORK.toLowerCase() : "testnet";

    if (network === "mainnet" && !allowMainnet) {
      throw new Error("Mainnet access is disabled. Set allowMainnet=true to allow mainnet access.");
    }

    let client: Client;
    if (network === "mainnet") {
      client = Client.forMainnet();
    } else if (network === "previewnet") {
      client = Client.forPreviewnet();
    } else {
      client = Client.forTestnet();
    }

    const operatorId = env.HEDERA_OPERATOR_ID;
    const operatorKey = env.HEDERA_OPERATOR_KEY;

    if (!operatorId || !operatorKey) {
      throw new Error("Missing required Hedera operator credentials (HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY).");
    }

    try {
      client.setOperator(
        AccountId.fromString(operatorId),
        PrivateKey.fromString(operatorKey)
      );
    } catch (error: any) {
      throw new Error(`Failed to configure Hedera client operator: ${error?.message || error}`);
    }

    console.log(`Hedera client initialized for network: ${network} with operator ID: ${operatorId}`);
    return client;
  }
}

export const hederaService = new HederaService();
