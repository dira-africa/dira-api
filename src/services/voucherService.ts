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
import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import QRCode from "qrcode";
import { tokenService, deductTokens } from "./tokenService";
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
   * Delegates to the new direct function export.
   */
  async generateVoucher(
    farmerId: string,
    tokenAmount: number,
    agroDealerId: string
  ): Promise<{ qrDataUrl: string; voucherCode: string; kesValue: number; expiresAt: Date; qrHash: string }> {
    const res = await generateVoucher(farmerId, tokenAmount, agroDealerId);
    return {
      qrDataUrl: res.qrDataUrl,
      voucherCode: res.voucherCode,
      kesValue: res.kesValue!,
      expiresAt: res.expiresAt!,
      qrHash: res.qrHash!
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

    // 2. Verify HMAC signature using timingSafeEqual (check both JSON and Base64 signatures)
    const expectedSignatureBase64 = createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(payload)
      .digest("hex");

    const decodedPayload = Buffer.from(payload, "base64").toString("utf-8");
    const expectedSignatureJson = createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
      .update(decodedPayload)
      .digest("hex");

    const sigBuf = Buffer.from(signature, "hex");
    const compBufBase64 = Buffer.from(expectedSignatureBase64, "hex");
    const compBufJson = Buffer.from(expectedSignatureJson, "hex");

    let isMatch = false;
    if (sigBuf.length === compBufBase64.length && timingSafeEqual(sigBuf, compBufBase64)) {
      isMatch = true;
    } else if (sigBuf.length === compBufJson.length && timingSafeEqual(sigBuf, compBufJson)) {
      isMatch = true;
    }

    if (!isMatch) {
      throw new Error("INVALID_SIGNATURE");
    }

    // Decode and parse payload data
    let voucherData;
    try {
      voucherData = JSON.parse(decodedPayload);
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
    const expectedDealerId = voucherData.agroDealerId || voucherData.agroDealer;
    if (dbVoucher.agro_dealer_id !== agroDealerId || expectedDealerId !== agroDealerId) {
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
    const vouchersRes = await query(
      `SELECT agro_dealer_id
       FROM voucher_redemptions
       WHERE status IN ('scanned', 'redeemed') AND reconciled_at IS NULL
       GROUP BY agro_dealer_id`
    );
    const count = vouchersRes.rows.length;
    await runWeeklyReconciliation();
    return { processedDealersCount: count };
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

/**
 * Generates a signed QR-code voucher with deduct-first logic.
 * Direct export for build guide compatibility.
 */
export async function generateVoucher(
  farmerId: string,
  tokenAmount: number,
  agroDealer: string
): Promise<{ qrDataUrl: string; voucherCode: string; kesValue?: number; expiresAt?: Date; qrHash?: string }> {
  const KES_PER_TOKEN = 0.55;
  const kesValue = tokenAmount * KES_PER_TOKEN;
  const voucherCode = randomUUID();

  // Create HMAC-SHA256 signed payload
  const payload = JSON.stringify({
    voucherCode,
    farmerId,
    agroDealer,
    tokenAmount,
    kesValue,
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() // 48-hour expiry
  });

  const signature = createHmac("sha256", env.VOUCHER_SIGNING_SECRET)
    .update(payload)
    .digest("hex");

  const qrPayload = { payload: Buffer.from(payload).toString("base64"), signature };

  // Ensure the user has a record in the farmers table
  const farmerRes = await query("SELECT id FROM farmers WHERE user_id = $1 OR id = $2", [farmerId, farmerId]);
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

  // Attempt to resolve agroDealer as agroDealerId UUID
  let agroDealerId: string | null = null;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(agroDealer)) {
    agroDealerId = agroDealer;
  } else {
    const dealerRes = await query("SELECT id FROM agro_dealers WHERE dealer_name = $1", [agroDealer]);
    if (dealerRes.rows.length > 0) {
      agroDealerId = dealerRes.rows[0].id;
    }
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

  // Deduct tokens immediately on generation
  await deductTokens(farmerId, tokenAmount, "redeem_voucher", voucherCode);

  // Store voucher in DB
  await query(
    `INSERT INTO voucher_redemptions
     (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'generated')`,
    [farmerUuid, agroDealerId, tokenAmount, kesValue, voucherCode, signature, expiresAt]
  );

  const qrDataUrl = await QRCode.toDataURL(JSON.stringify(qrPayload));
  return { 
    qrDataUrl, 
    voucherCode,
    kesValue,
    expiresAt,
    qrHash: signature
  };
}

/**
 * Creates a reconciliation report (db row) for a dealer's weekly batch.
 * Helper function for runWeeklyReconciliation.
 */
async function createReconciliationReport(dealer: any): Promise<void> {
  const dealerInfoRes = await query("SELECT transaction_fee_pct FROM agro_dealers WHERE id = $1", [dealer.id]);
  const feePct = dealerInfoRes.rows.length > 0 ? (Number(dealerInfoRes.rows[0].transaction_fee_pct) || 3.50) : 3.50;
  const netMultiplier = 1 - (feePct / 100);
  const netKesOwed = Number(dealer.total_kes_owed) * netMultiplier;

  const tokensRes = await query(
    "SELECT COALESCE(SUM(token_amount), 0) AS total_tokens FROM voucher_redemptions WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL",
    [dealer.id]
  );
  const totalTokens = Number(tokensRes.rows[0].total_tokens);

  const lastReconRes = await query(
    "SELECT period_end FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1 ORDER BY period_end DESC LIMIT 1",
    [dealer.id]
  );
  const periodStart = lastReconRes.rows.length > 0 
    ? new Date(lastReconRes.rows[0].period_end) 
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const periodEnd = new Date();

  await query(
    `INSERT INTO agro_dealer_reconciliations (agro_dealer_id, period_start, period_end, total_tokens_redeemed, total_kes_owed, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [dealer.id, periodStart, periodEnd, totalTokens, netKesOwed]
  );
}

/**
 * Dispatches notifications (Telegram alerts) to admin and dealer contacts for reconciliation.
 * Helper function for runWeeklyReconciliation.
 */
async function sendDealerReconciliationNotification(dealer: any): Promise<void> {
  const dealerRes = await query("SELECT dealer_name, dealer_phone, transaction_fee_pct FROM agro_dealers WHERE id = $1", [dealer.id]);
  if (dealerRes.rows.length === 0) return;
  const dealerInfo = dealerRes.rows[0];

  const feePct = Number(dealerInfo.transaction_fee_pct) || 3.50;
  const netMultiplier = 1 - (feePct / 100);
  const totalKesValue = Number(dealer.total_kes_owed);
  const totalKesOwed = totalKesValue * netMultiplier;

  const tokensRes = await query(
    "SELECT COALESCE(SUM(token_amount), 0) AS total_tokens FROM voucher_redemptions WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL",
    [dealer.id]
  );
  const totalTokens = Number(tokensRes.rows[0].total_tokens);

  const lastReconRes = await query(
    "SELECT period_end FROM agro_dealer_reconciliations WHERE agro_dealer_id = $1 ORDER BY period_end DESC LIMIT 1",
    [dealer.id]
  );
  const periodStart = lastReconRes.rows.length > 0 
    ? new Date(lastReconRes.rows[0].period_end) 
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const periodEnd = new Date();

  // Notify Admin
  try {
    const adminRes = await query(
      "SELECT telegram_id FROM users WHERE role = 'admin' AND telegram_id IS NOT NULL LIMIT 1"
    );
    const adminId = adminRes.rows[0]?.telegram_id;
    if (adminId) {
      await notificationsQueue.add("send-telegram", {
        telegramId: String(adminId),
        message: `📊 RECONCILIATION COMPLETED: ${dealerInfo.dealer_name}
Period: ${periodStart.toLocaleDateString()} to ${periodEnd.toLocaleDateString()}
Total Vouchers Redeemed: ${totalTokens} DIRA (KES ${totalKesValue.toFixed(2)})
Dira Transaction Fee: ${feePct}%
Net Amount Owed: KES ${totalKesOwed.toFixed(2)} (Settlement pending)`
      });
    }
  } catch (adminErr) {
    console.error("Failed to notify admin on reconciliation:", adminErr);
  }

  // Notify Agro Dealer
  try {
    const dealerContactRes = await query(
      `SELECT telegram_id FROM users 
       WHERE pgp_sym_decrypt(phone_number::bytea, $1) = $2 AND telegram_id IS NOT NULL LIMIT 1`,
      [env.PGCRYPTO_SYMMETRIC_KEY, dealerInfo.dealer_phone]
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

/**
 * Direct export function for weekly reconciliation.
 * Aggregates all scanned/redeemed vouchers per dealer and generates reports.
 */
export async function runWeeklyReconciliation(): Promise<void> {
  const dealers = await query(
    `SELECT ad.id, ad.dealer_name, ad.bank_account,
            SUM(vr.kes_value) AS total_kes_owed,
            COUNT(vr.id) AS voucher_count
     FROM agro_dealers ad
     JOIN voucher_redemptions vr ON vr.agro_dealer_id = ad.id
     WHERE vr.status IN ('scanned', 'redeemed') AND vr.reconciled_at IS NULL
     GROUP BY ad.id, ad.dealer_name, ad.bank_account`
  );

  for (const dealer of dealers.rows) {
    await createReconciliationReport(dealer);
    await sendDealerReconciliationNotification(dealer);
    await query(
      `UPDATE voucher_redemptions SET reconciled_at = NOW(), status = 'reconciled'
       WHERE agro_dealer_id = $1 AND status IN ('scanned', 'redeemed') AND reconciled_at IS NULL`,
      [dealer.id]
    );
  }
}


