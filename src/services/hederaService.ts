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
import https from "https";

export class HederaService {
  /**
   * Builds and returns a configured Hedera client instance.
   * Enforces that requests to use the mainnet are rejected unless allowMainnet is explicitly true.
   */
  async getClient(allowMainnet: boolean = false): Promise<Client> {
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
      const parsedKey = await this.parsePrivateKey(operatorId, operatorKey, network);
      client.setOperator(
        AccountId.fromString(operatorId),
        parsedKey
      );
    } catch (error: any) {
      throw new Error(`Failed to configure Hedera client operator: ${error?.message || error}`);
    }

    console.log(`Hedera client initialized for network: ${network} with operator ID: ${operatorId}`);
    return client;
  }

  /**
   * Helper to retrieve the parsed private key of the operator.
   */
  async getOperatorKey(): Promise<PrivateKey> {
    const operatorId = env.HEDERA_OPERATOR_ID;
    const operatorKey = env.HEDERA_OPERATOR_KEY;
    const network = env.HEDERA_NETWORK ? env.HEDERA_NETWORK.toLowerCase() : "testnet";

    if (!operatorId || !operatorKey) {
      throw new Error("Missing required Hedera operator credentials (HEDERA_OPERATOR_ID or HEDERA_OPERATOR_KEY).");
    }

    return this.parsePrivateKey(operatorId, operatorKey, network);
  }

  /**
   * Parses the operator key string using explicit env configuration, auto-detection via mirror node, or SDK default.
   */
  private async parsePrivateKey(operatorId: string, operatorKey: string, network: string): Promise<PrivateKey> {
    const cleanKey = operatorKey.startsWith("0x") ? operatorKey.substring(2) : operatorKey;

    // 1. Explicit environment configuration
    const configuredType = env.HEDERA_OPERATOR_KEY_TYPE;
    if (configuredType === "ECDSA") {
      return PrivateKey.fromStringECDSA(cleanKey);
    }
    if (configuredType === "ED25519") {
      return PrivateKey.fromStringED25519(cleanKey);
    }

    // 2. Auto-detection via mirror node
    try {
      const detectedType = await this.detectKeyTypeFromMirrorNode(operatorId, network);
      if (detectedType === "ECDSA") {
        console.log(`[HederaService] Auto-detected operator key type: ECDSA`);
        return PrivateKey.fromStringECDSA(cleanKey);
      }
      if (detectedType === "ED25519") {
        console.log(`[HederaService] Auto-detected operator key type: ED25519`);
        return PrivateKey.fromStringED25519(cleanKey);
      }
    } catch (error: any) {
      console.warn(`[HederaService] Mirror node auto-detection failed, falling back to default parsing:`, error.message);
    }

    // 3. Fallback to standard SDK parsing
    return PrivateKey.fromString(operatorKey);
  }

  /**
   * Performs a lightweight HTTPS request to the public mirror node to find the account's key type.
   */
  private detectKeyTypeFromMirrorNode(operatorId: string, network: string): Promise<"ECDSA" | "ED25519" | null> {
    return new Promise((resolve, reject) => {
      const host = `${network === "mainnet" ? "mainnet" : "testnet"}.mirrornode.hedera.com`;
      const url = `https://${host}/api/v1/accounts/${operatorId}`;

      const req = https.get(url, { timeout: 2000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const keyType = parsed?.key?._type;
              if (keyType === "ECDSA_SECP256K1") {
                resolve("ECDSA");
              } else if (keyType === "ED25519") {
                resolve("ED25519");
              } else {
                resolve(null);
              }
            } catch (e) {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Mirror node request timed out"));
      });
    });
  }
}

export const hederaService = new HederaService();
