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
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

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
   * Generates a random alphanumeric voucher code (e.g., VCH-A1B2-C3D4)
   */
  private generateVoucherCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const part1 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const part2 = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `VCH-${part1}-${part2}`;
  }

  /**
   * Computes the HMAC-SHA256 signature hash of the voucher details
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
   * Issues a signed farm input voucher for a farmer at a specific dealer
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
    const kesValue = tokenAmount * 1.0; // 1:1 conversion rate
    const code = this.generateVoucherCode();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48-hour validity
    const expiresAtStr = expiresAt.toISOString();

    const qrHash = this.computeVoucherHash(code, userId, agroDealerId, tokenAmount, expiresAtStr);

    await query(
      `INSERT INTO voucher_redemptions (farmer_id, agro_dealer_id, token_amount, kes_value, voucher_code, voucher_qr_hash, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
      [userId, agroDealerId, tokenAmount, kesValue, code, qrHash, expiresAt]
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
   * Validates a voucher by its code and signature hash
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
       JOIN users u ON vr.farmer_id = u.id
       JOIN agro_dealers ad ON vr.agro_dealer_id = ad.id
       WHERE vr.voucher_code = $1`,
      [code]
    );

    if (res.rows.length === 0) {
      return { valid: false, errorReason: "Voucher code not found." };
    }

    const dbVoucher = res.rows[0];

    // Check status
    if (dbVoucher.status !== "active") {
      return { valid: false, errorReason: `Voucher is already ${dbVoucher.status}.` };
    }

    // Check expiration
    const expiresAt = new Date(dbVoucher.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return { valid: false, errorReason: "Voucher has expired." };
    }

    // Timing-safe signature check
    const expectedHash = this.computeVoucherHash(
      code,
      dbVoucher.farmer_id,
      dbVoucher.agro_dealer_id,
      Number(dbVoucher.token_amount),
      expiresAt.toISOString()
    );

    const hashA = Buffer.from(qrHash, "hex");
    const hashB = Buffer.from(expectedHash, "hex");

    if (hashA.length !== hashB.length || !timingSafeEqual(hashA, hashB)) {
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
   * Claims/Redeems a voucher at the agro-dealer counter
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
