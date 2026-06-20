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
import { env } from "../config/env";
import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import QRCode from "qrcode";
import { tokenService } from "./tokenService";
import { notificationsQueue } from "../jobs/queues";

export interface VoucherDetails {
  id: string;
  farmer_id: string;
  farmer_name: string;
  agro_dealer_id: string;
  dealer_name: string;
  token_amount: number;
  kes_value: number;
  voucher_code: string;
  voucher_qr_hash: string;
  expires_at: Date;
  status: string;
  created_at: Date;
}

export class VoucherService {
  /**
   * Generates a random alphanumeric voucher code for legacy compatibility
   */
  private generateVoucherCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const part1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const part2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `VCH-${part1}-${part2}`;
  }

  /**
   * Computes the HMAC-SHA256 signature hash of the voucher details for legacy compatibility
   */
  computeVoucherHash(
    code: string,
    farmerId: string,
    agroDealerId: string,
    tokenAmount: number,
    expiresAtStr: string
  ): string {
    const payload = [code, farmerId, agroDealerId, tokenAmount, expiresAtStr].join("|");
    return createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(payload)
      .digest("hex");
  }

  /**
   * Generates a signed QR-code voucher with deduct-first logic.
   * Ensures secure timing-safe double-spend validation and key rotation auditing.
   */
  async generateVoucher(
    farmerId: string,
    tokenAmount: number,
    agroDealerId: string
  ): Promise<{ qrDataUrl: string; voucherCode: string; kesValue: number; expiresAt: Date; qrHash: string }> {
    // 1. Validations
    if (tokenAmount < 50) {
      throw new Error("BELOW_MINIMUM_TOKENS");
    }

    const dealerRes = await query(
      "SELECT id, dealer_name FROM agro_dealers WHERE id = $1 AND active = TRUE",
      [agroDealerId]
    );
    if (dealerRes.rows.length === 0) {
      throw new Error("DEALER_NOT_FOUND");
    }
    const dealerName = dealerRes.rows[0].dealer_name;

    const { balance } = await tokenService.getBalance(farmerId);
    if (balance < tokenAmount) {
      throw new Error("INSUFFICIENT_TOKENS");
    }

    // 2. Generate UUID voucher code and expiration (48 hours)
    const voucherCode = randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const kesValue = tokenAmount * 0.55;

    // 3. Deduct tokens immediately using deductTokens() before saving/signing
    try {
      await tokenService.deductTokens(farmerId, tokenAmount, "redeem_voucher", voucherCode);
    } catch (err: any) {
      throw new Error("INSUFFICIENT_TOKENS");
    }

    // Ensure the user has a record in the farmers table
    let farmerRes = await query("SELECT id FROM farmers WHERE user_id = $1", [farmerId]);
    let farmerUuid;
    if (farmerRes.rows.length === 0) {
      const insertFarmer = await query(
        "INSERT INTO farmers (user_id) VALUES ($1) RETURNING id",
        [farmerId]
      );
      farmerUuid = insertFarmer.rows[0].id;
    } else {
      farmerUuid = farmerRes.rows[0].id;
    }

    // 4. Construct JSON payload & Base64 encode
    const payloadObj = {
      voucherCode,
      farmerId,
      agroDealerId,
      tokenAmount,
      kesValue,
      expiresAt: expiresAt.toISOString(),
      keyVersion: 1
    };
    const payloadStr = JSON.stringify(payloadObj);
    const payloadBase64 = Buffer.from(payloadStr).toString("base64");

    // 5. Sign payload with HMAC-SHA256 using VOUCHER_SIGNING_SECRET
    const signature = createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(payloadBase64)
      .digest("hex");

    // 6. Save voucher to voucher_redemptions table with status 'generated'
    await query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'generated')`,
      [farmerUuid, agroDealerId, tokenAmount, kesValue, voucherCode, signature, expiresAt]
    );

    // 7. Generate QR code
    const qrText = JSON.stringify({ payload: payloadBase64, signature });
    const qrDataUrl = await QRCode.toDataURL(qrText);

    return {
      qrDataUrl,
      voucherCode,
      kesValue,
      expiresAt,
      qrHash: signature
    };
  }

  /**
   * Scans a signed QR-code voucher and performs timing-safe checks
   */
  async scanVoucher(
    qrPayload: string,
    agroDealerId: string
  ): Promise<{ success: boolean; farmerId: string; kesValue: number }> {
    // 1. Parse payload and signature
    let payload = "";
    let signature = "";
    try {
      const parsed = JSON.parse(qrPayload);
      payload = parsed.payload;
      signature = parsed.signature;
    } catch (err) {
      throw new Error("INVALID_SIGNATURE");
    }

    if (!payload || !signature) {
      throw new Error("INVALID_SIGNATURE");
    }

    // 2. Verify HMAC signature using timingSafeEqual
    const expectedSignature = createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(payload)
      .digest("hex");

    const sigBuf = Buffer.from(signature, "hex");
    const compBuf = Buffer.from(expectedSignature, "hex");

    if (sigBuf.length !== compBuf.length || !timingSafeEqual(sigBuf, compBuf)) {
      throw new Error("INVALID_SIGNATURE");
    }

    // Decode and parse payload data
    let voucherData;
    try {
      const payloadJsonStr = Buffer.from(payload, "base64").toString("utf-8");
      voucherData = JSON.parse(payloadJsonStr);
    } catch (err) {
      throw new Error("INVALID_SIGNATURE");
    }

    const { voucherCode, farmerId, expiresAt, kesValue } = voucherData;

    // 3. Verify expiresAt has not passed
    const expiresTime = new Date(expiresAt).getTime();
    if (expiresTime < Date.now()) {
      throw new Error("VOUCHER_EXPIRED");
    }

    // 4. Verify status is 'generated' (not already scanned or redeemed)
    const dbRes = await query(
      "SELECT status, agro_dealer_id FROM voucher_redemptions WHERE voucher_code = $1",
      [voucherCode]
    );
    if (dbRes.rows.length === 0) {
      throw new Error("VOUCHER_NOT_FOUND");
    }

    const dbVoucher = dbRes.rows[0];
    if (dbVoucher.status === "redeemed" || dbVoucher.status === "scanned") {
      throw new Error("VOUCHER_ALREADY_REDEEMED");
    }

    if (dbVoucher.status !== "generated" && dbVoucher.status !== "active") {
      throw new Error("INVALID_VOUCHER_STATUS");
    }

    // 5. Verify agroDealerId matches
    if (dbVoucher.agro_dealer_id !== agroDealerId || voucherData.agroDealerId !== agroDealerId) {
      throw new Error("DEALER_MISMATCH");
    }

    // 6. Mark status as 'redeemed', set scanned_at
    await query(
      `UPDATE voucher_redemptions 
       SET status = 'redeemed', scanned_at = CURRENT_TIMESTAMP 
       WHERE voucher_code = $1`,
      [voucherCode]
    );

    return {
      success: true,
      farmerId,
      kesValue: Number(kesValue)
    };
  }

  /**
   * Weekly reconciliation job to calculate total net amount owed after Dira fees
   */
  async runWeeklyReconciliation(): Promise<{ processedDealersCount: number }> {
    // 1. Aggregate all scanned or redeemed but unreconciled vouchers per dealer
    const vouchersRes = await query(
      `SELECT agro_dealer_id, COALESCE(SUM(token_amount), 0) AS total_tokens, 
              COALESCE(SUM(kes_value), 0) AS total_kes_value
       FROM voucher_redemptions
       WHERE status IN ('scanned', 'redeemed') AND reconciled_at IS NULL
       GROUP BY agro_dealer_id`
    );

    if (vouchersRes.rows.length === 0) {
      console.log("No unreconciled redeemed vouchers found.");
      return { processedDealersCount: 0 };
    }

    const periodEnd = new Date();

    for (const row of vouchersRes.rows) {
      const agroDealerId = row.agro_dealer_id;
      const totalTokens = Number(row.total_tokens);
      const totalKesValue = Number(row.total_kes_value);

      // Query dealer MOU configurations
      const dealerRes = await query(
        "SELECT dealer_name, dealer_phone, transaction_fee_pct FROM agro_dealers WHERE id = $1",
        [agroDealerId]
      );
      if (dealerRes.rows.length === 0) continue;
      const dealer = dealerRes.rows[0];

      // Calculate net cash owed (after 3.5% Dira fee by default)
      const feePct = Number(dealer.transaction_fee_pct) || 3.50;
      const netMultiplier = 1 - (feePct / 100);
      const totalKesOwed = totalKesValue * netMultiplier;

      // Find period start (end date of last reconciliation or fallback to 7 days ago)
      const lastReconRes = await query(
        "SELECT period_end FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1 ORDER BY period_end DESC LIMIT 1",
        [agroDealerId]
      );
      const periodStart = lastReconRes.rows.length > 0 
        ? new Date(lastReconRes.rows[0].period_end) 
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // 2. Create agro_dealer_reconciliations record
      await query(
        `INSERT INTO agro_dealer_reconciliations (agro_dealer_id, period_start, period_end, total_tokens, total_kes_owed, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [agroDealerId, periodStart, periodEnd, totalTokens, totalKesOwed]
      );

      // 3. Mark matching vouchers as 'reconciled' and set reconciled_at
      await query(
        `UPDATE voucher_redemptions
         SET status = 'reconciled', reconciled_at = CURRENT_TIMESTAMP
         WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL`,
        [agroDealerId]
      );

      // 4. Send Telegram alerts to Dira Admin
      try {
        const adminRes = await query(
          "SELECT telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL LIMIT 1"
        );
        const adminId = adminRes.rows[0]?.telegram_id;
        if (adminId) {
          await notificationsQueue.add("send-telegram", {
            telegramId: String(adminId),
            message: `📊 RECONCILIATION COMPLETED: ${dealer.dealer_name}
Period: ${periodStart.toLocaleDateString()} to ${periodEnd.toLocaleDateString()}
Total Vouchers Redeemed: ${totalTokens} DIRA (KES ${totalKesValue.toFixed(2)})
Dira Transaction Fee: ${feePct}%
Net Amount Owed: KES ${totalKesOwed.toFixed(2)} (Settlement pending)`
          });
        }
      } catch (adminErr) {
        console.error("Failed to notify admin on reconciliation:", adminErr);
      }

      // 5. Send Telegram alert to agro-dealer manager contact
      try {
        const dealerContactRes = await query(
          `SELECT telegram_id FROM users 
           WHERE pgp_sym_decrypt(phone_number::bytea, $1) = $2 AND telegram_id IS NOT NULL LIMIT 1`,
          [env.PGCRYPTO_SYMMETRIC_KEY, dealer.dealer_phone]
        );
        const dealerContactId = dealerContactRes.rows[0]?.telegram_id;
        if (dealerContactId) {
          await notificationsQueue.add("send-telegram", {
            telegramId: String(dealerContactId),
            message: `Hello! Your weekly Dira agro-dealer reconciliation statement is ready.
Period: ${periodStart.toLocaleDateString()} to ${periodEnd.toLocaleDateString()}
Total Redeemed Vouchers: ${totalTokens} tokens
Net Settlement Owed: KES ${totalKesOwed.toFixed(2)}
This will be credited to your registered bank account shortly.`
          });
        }
      } catch (dealerErr) {
        console.error("Failed to notify agro-dealer on reconciliation:", dealerErr);
      }
    }

    return { processedDealersCount: vouchersRes.rows.length };
  }

  /**
   * Issues a signed farm input voucher for a farmer at a specific dealer (Legacy compat)
   */
  async issueInputVoucher(
    userId: string,
    agroDealerId: string,
    tokenAmount: number
  ): Promise<{
    success: boolean;
    code?: string;
    expiresAt?: Date;
    qrHash?: string;
    kesValue?: number;
  }> {
    // Ensure the user has a record in the farmers table
    let farmerRes = await query("SELECT id FROM farmers WHERE user_id = $1", [userId]);
    let farmerUuid;
    if (farmerRes.rows.length === 0) {
      const insertFarmer = await query(
        "INSERT INTO farmers (user_id) VALUES ($1) RETURNING id",
        [userId]
      );
      farmerUuid = insertFarmer.rows[0].id;
    } else {
      farmerUuid = farmerRes.rows[0].id;
    }

    const kesValue = tokenAmount * 1.0;
    const code = this.generateVoucherCode();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const expiresAtStr = expiresAt.toISOString();

    const qrHash = this.computeVoucherHash(code, farmerUuid, agroDealerId, tokenAmount, expiresAtStr);

    await query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      [farmerUuid, agroDealerId, tokenAmount, kesValue, code, qrHash, expiresAt]
    );

    return {
      success: true,
      code,
      expiresAt,
      qrHash,
      kesValue
    };
  }

  /**
   * Validates a voucher by its code and signature hash (Legacy compat)
   */
  async validateVoucher(
    code: string,
    qrHash: string
  ): Promise<{
    valid: boolean;
    voucher?: VoucherDetails;
    errorReason?: string;
  }> {
    const res = await query(
      `SELECT vr.*, u.full_name AS farmer_name, ad.dealer_name
       FROM voucher_redemptions vr
       JOIN farmers f ON vr.farmer_id = f.id
       JOIN users u ON f.user_id = u.id
       JOIN agro_dealers ad ON vr.agro_dealer_id = ad.id
       WHERE vr.voucher_code = $1`,
      [code]
    );

    if (res.rows.length === 0) {
      return { valid: false, errorReason: "Voucher code not found." };
    }

    const dbVoucher = res.rows[0];

    if (dbVoucher.status !== "active" && dbVoucher.status !== "generated") {
      return { valid: false, errorReason: `Voucher is already ${dbVoucher.status}.` };
    }

    const expiresAt = new Date(dbVoucher.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return { valid: false, errorReason: "Voucher has expired." };
    }

    const expectedHash = this.computeVoucherHash(
      code,
      dbVoucher.farmer_id,
      dbVoucher.agro_dealer_id,
      Number(dbVoucher.token_amount),
      expiresAt.toISOString()
    );

    const hashA = Buffer.from(qrHash, "hex");
    const hashB = Buffer.from(expectedHash, "hex");
    const dbHashBuf = Buffer.from(dbVoucher.voucher_qr_hash || "", "hex");

    let isMatch = false;
    if (hashA.length === hashB.length && timingSafeEqual(hashA, hashB)) {
      isMatch = true;
    } else if (hashA.length === dbHashBuf.length && timingSafeEqual(hashA, dbHashBuf)) {
      isMatch = true;
    }

    if (!isMatch) {
      return { valid: false, errorReason: "Voucher signature verification failed (tampered payload)." };
    }

    return {
      valid: true,
      voucher: {
        id: dbVoucher.id,
        farmer_id: dbVoucher.farmer_id,
        farmer_name: dbVoucher.farmer_name,
        agro_dealer_id: dbVoucher.agro_dealer_id,
        dealer_name: dbVoucher.dealer_name,
        token_amount: Number(dbVoucher.token_amount),
        kes_value: Number(dbVoucher.kes_value),
        voucher_code: dbVoucher.voucher_code,
        voucher_qr_hash: dbVoucher.voucher_qr_hash,
        expires_at: expiresAt,
        status: dbVoucher.status,
        created_at: new Date(dbVoucher.created_at)
      }
    };
  }

  /**
   * Claims/Redeems a voucher at the agro-dealer counter (Legacy compat)
   */
  async redeemVoucher(
    code: string,
    qrHash: string,
    agroDealerId: string
  ): Promise<{
    success: boolean;
    errorReason?: string;
  }> {
    const valResult = await this.validateVoucher(code, qrHash);
    if (!valResult.valid || !valResult.voucher) {
      return { success: false, errorReason: valResult.errorReason };
    }

    const { voucher } = valResult;

    if (voucher.agro_dealer_id !== agroDealerId) {
      return {
        success: false,
        errorReason: `This voucher is registered for ${voucher.dealer_name} and cannot be scanned by this dealer.`
      };
    }

    await query(
      `UPDATE voucher_redemptions 
       SET status = 'scanned', 
           scanned_at = CURRENT_TIMESTAMP 
       WHERE voucher_code = $1`,
      [code]
    );

    return { success: true };
  }
}

export const voucherService = new VoucherService();
