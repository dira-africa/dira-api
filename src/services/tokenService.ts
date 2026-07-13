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
import { pool } from "../db/pool";
import { TokenMintTransaction, TokenBurnTransaction } from "@hashgraph/sdk";
import { hederaService } from "./hederaService";
import { env } from "../config/env";

export type TransactionType =
  | "atmospheric_sync"
  | "crop_photo"
  | "redeem_airtime"
  | "redeem_voucher"
  | "redeem_circle"
  | "redeem_mpesa"
  | "bonus"
  | "adjustment";

/**
 * Retrieves the current Climate Token balance of a user by querying the token_transactions table.
 * Confirmed transactions with type 'earn' add to the balance, while redemption types subtract.
 */
export async function getTokenBalance(userId: string): Promise<number> {
  const result = await query(
    `SELECT COALESCE(SUM(
       CASE WHEN type = 'earn' THEN amount
            WHEN type IN ('redeem_airtime','redeem_voucher','redeem_circle','redeem_mpesa')
            THEN -amount ELSE 0 END
     ), 0) AS balance
     FROM token_transactions
     WHERE user_id = $1 AND status = 'confirmed'`,
    [userId]
  );
  return parseFloat(result.rows[0].balance);
}

/**
 * Deducts Climate Tokens from a user's balance in an atomic database transaction.
 * Also performs a dual-write to the legacy token_ledger table for backward compatibility.
 */
export async function deductTokens(
  userId: string,
  amount: number,
  type: "redeem_airtime" | "redeem_voucher" | "redeem_circle" | "redeem_mpesa",
  referenceId?: string
): Promise<void> {
  if (amount <= 0) {
    throw new Error("Deduct amount must be greater than zero");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock the user row to serialize all ledger insertions/updates for this user
    const userLock = await client.query(
      "SELECT id FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userLock.rows.length === 0) {
      throw new Error("USER_NOT_FOUND");
    }

    // 2. Fetch the latest balance using the internal getTokenBalance query within the transaction
    const balanceRes = await client.query(
      `SELECT COALESCE(SUM(
         CASE WHEN type = 'earn' THEN amount
              WHEN type IN ('redeem_airtime','redeem_voucher','redeem_circle','redeem_mpesa')
              THEN -amount ELSE 0 END
       ), 0) AS balance
       FROM token_transactions
       WHERE user_id = $1 AND status = 'confirmed'`,
      [userId]
    );
    const balance = parseFloat(balanceRes.rows[0].balance);

    if (balance < amount) {
      throw new Error("INSUFFICIENT_TOKENS");
    }

    const newBalance = balance - amount;

    // HTS Burn Transaction mirroring redemption
    let htsTxId: string | null = null;
    const tokenId = env.DIRA_HTS_TOKEN_ID;
    if (!tokenId || tokenId === "0.0.12345") {
      throw new Error("Missing or invalid DIRA_HTS_TOKEN_ID in configuration.");
    }

    console.log(`Executing HTS Token Burn: Burning ${amount} tokens (${amount * 100} units) from treasury for user ${userId}...`);
    try {
      const htsClient = await hederaService.getClient(false);
      const burnTx = new TokenBurnTransaction()
        .setTokenId(tokenId)
        .setAmount(amount * 100);

      const response = await burnTx.execute(htsClient);
      await response.getReceipt(htsClient);
      htsTxId = response.transactionId.toString();
    } catch (htsErr: any) {
      throw new Error(`Hedera HTS Burn failed: ${htsErr.message}`);
    }

    // 3. Insert transaction into token_transactions
    await client.query(
      `INSERT INTO token_transactions (user_id, amount, type, reference_id, status, hts_tx_id)
       VALUES ($1, $2, $3, $4, 'confirmed', $5)`,
      [userId, amount, type, referenceId || null, htsTxId]
    );

    // 4. Dual-write negative entry to legacy token_ledger for compatibility
    await client.query(
      `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes, hts_tx_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, -amount, newBalance, type, referenceId || null, `Redeemed ${amount} tokens`, htsTxId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export class TokenService {
  /**
   * Retrieves current balance as sum of ledger entries.
   */
  async getBalance(userId: string): Promise<{ balance: number }> {
    const balance = await getTokenBalance(userId);
    return { balance };
  }

  /**
   * Credits tokens in an atomic transaction with row-level locking.
   * Dual-writes to both token_transactions and legacy token_ledger.
   */
  async creditTokens(
    userId: string,
    amount: number,
    type: TransactionType,
    referenceId?: string,
    notes?: string
  ): Promise<boolean> {
    if (amount <= 0) {
      throw new Error("Credit amount must be greater than zero");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Lock the user row to serialize all ledger insertions/updates for this user
      const userLock = await client.query(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [userId]
      );
      if (userLock.rows.length === 0) {
        throw new Error("USER_NOT_FOUND");
      }

      // 2. Get the latest balance from token_transactions
      const balanceRes = await client.query(
        `SELECT COALESCE(SUM(
           CASE WHEN type = 'earn' THEN amount
                WHEN type IN ('redeem_airtime','redeem_voucher','redeem_circle','redeem_mpesa')
                THEN -amount ELSE 0 END
         ), 0) AS balance
         FROM token_transactions
         WHERE user_id = $1 AND status = 'confirmed'`,
        [userId]
      );
      const currentBalance = parseFloat(balanceRes.rows[0].balance);
      const newBalance = currentBalance + amount;

      // HTS Mint Transaction mirroring reward earning
      let htsTxId: string | null = null;
      const tokenId = env.DIRA_HTS_TOKEN_ID;
      if (!tokenId || tokenId === "0.0.12345") {
        throw new Error("Missing or invalid DIRA_HTS_TOKEN_ID in configuration.");
      }

      console.log(`Executing HTS Token Mint: Minting ${amount} tokens (${amount * 100} units) to treasury for user ${userId}...`);
      try {
        const htsClient = await hederaService.getClient(false);
        const mintTx = new TokenMintTransaction()
          .setTokenId(tokenId)
          .setAmount(amount * 100);

        const response = await mintTx.execute(htsClient);
        await response.getReceipt(htsClient);
        htsTxId = response.transactionId.toString();
      } catch (htsErr: any) {
        throw new Error(`Hedera HTS Mint failed: ${htsErr.message}`);
      }

      // 3. Insert transaction into token_transactions
      await client.query(
        `INSERT INTO token_transactions (user_id, amount, type, reference_id, status, hts_tx_id)
         VALUES ($1, $2, 'earn', $3, 'confirmed', $4)`,
        [userId, amount, referenceId || null, htsTxId]
      );

      // 4. Insert positive ledger entry into legacy token_ledger
      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes, hts_tx_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, amount, newBalance, type, referenceId || null, notes || null, htsTxId]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to credit tokens:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Deducts tokens in an atomic transaction with row-level locking.
   * Throws 'INSUFFICIENT_TOKENS' if the balance is less than the requested amount.
   */
  async deductTokens(
    userId: string,
    amount: number,
    type: TransactionType,
    referenceId?: string
  ): Promise<boolean> {
    const allowedTypes = ["redeem_airtime", "redeem_voucher", "redeem_circle", "redeem_mpesa"];
    if (!allowedTypes.includes(type)) {
      throw new Error(`Invalid redemption type for token deduction: ${type}`);
    }
    await deductTokens(userId, amount, type as any, referenceId);
    return true;
  }

  /**
   * Compatibility wrapper for awarding tokens.
   * Handles both positive rewards (credits) and negative redemptions (deducts).
   */
  async awardTokens(
    userId: string,
    amount: number,
    reason: string,
    transactionType: TransactionType = "crop_photo",
    referenceId?: string
  ): Promise<boolean> {
    if (amount < 0) {
      return this.deductTokens(userId, -amount, transactionType, referenceId);
    }
    return this.creditTokens(userId, amount, transactionType, referenceId, reason);
  }
}

export const tokenService = new TokenService();

/**
 * Refunds Climate Tokens to a user's balance (e.g. after a failed redemption).
 * Implemented as a transaction using the creditTokens method.
 */
export async function refundTokens(
  userId: string,
  amount: number,
  referenceId: string
): Promise<void> {
  await tokenService.creditTokens(
    userId,
    amount,
    "adjustment",
    referenceId,
    `Refund for failed transaction ${referenceId}`
  );
}
