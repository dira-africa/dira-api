/*
 * Copyright 2026 Blockchain & Climate Institute
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

export type TransactionType =
  | "atmospheric_sync"
  | "crop_photo"
  | "redeem_airtime"
  | "redeem_voucher"
  | "redeem_circle"
  | "redeem_mpesa"
  | "bonus"
  | "adjustment";

export class TokenService {
  /**
   * Retrieves current balance as sum of ledger entries.
   */
  async getBalance(userId: string): Promise<{ balance: number }> {
    const res = await query(
      "SELECT COALESCE(SUM(amount), 0) AS balance FROM token_ledger WHERE user_id = $1",
      [userId]
    );
    const balance = Number(res.rows[0].balance);
    return { balance };
  }

  /**
   * Credits tokens in an atomic transaction with row-level locking.
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

      // 2. Get the latest balance_after
      const balanceRes = await client.query(
        "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId]
      );
      const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance_after) : 0;
      const newBalance = currentBalance + amount;

      // 3. Insert the positive ledger entry
      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, amount, newBalance, type, referenceId || null, notes || null]
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

      // 2. Get the latest balance_after
      const balanceRes = await client.query(
        "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId]
      );
      const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance_after) : 0;

      // 3. Enforce balance check
      if (currentBalance < amount) {
        throw new Error("INSUFFICIENT_TOKENS");
      }

      const newBalance = currentBalance - amount;

      // 4. Insert the negative ledger entry
      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, -amount, newBalance, type, referenceId || null, `Redeemed ${amount} tokens`]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to deduct tokens:", err);
      throw err;
    } finally {
      client.release();
    }
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
