import { query } from "../db/query";
import { pool } from "../db/pool";

export class TokenService {
  async getBalance(userId: string): Promise<{ balance: number }> {
    const res = await query(
      "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [userId]
    );
    const balance = res.rows.length > 0 ? Number(res.rows[0].balance_after) : 0;
    return { balance };
  }

  async awardTokens(
    userId: string,
    amount: number,
    reason: string,
    transactionType: "crop_photo" | "atmospheric_sync" | "redeem_airtime" | "redeem_voucher" | "redeem_circle" | "redeem_mpesa" | "bonus" | "adjustment" = "crop_photo",
    referenceId?: string
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the user's latest ledger entry to avoid race conditions
      const balanceRes = await client.query(
        "SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [userId]
      );

      const currentBalance = balanceRes.rows.length > 0 ? Number(balanceRes.rows[0].balance_after) : 0;
      const newBalance = currentBalance + amount;

      await client.query(
        `INSERT INTO token_ledger (user_id, amount, balance_after, transaction_type, reference_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, amount, newBalance, transactionType, referenceId || null, reason]
      );

      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Failed to award tokens in transaction:", err);
      throw err;
    } finally {
      client.release();
    }
  }
}

export const tokenService = new TokenService();
