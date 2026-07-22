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

import crypto from "crypto";

/**
 * Generate a cryptographically secure Base32 secret for TOTP setup
 */
export function generateTOTPSecret(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = crypto.randomBytes(20); // 160 bits (recommended)
  let secret = "";
  for (let i = 0; i < bytes.length; i++) {
    secret += alphabet[bytes[i] % 32];
  }
  return secret;
}

/**
 * Decode a Base32 string into a Buffer
 */
function base32Decode(base32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleaned = base32.replace(/=+$/, "").toUpperCase();
  const length = cleaned.length;
  const buffer = Buffer.alloc(Math.floor((length * 5) / 8));

  let bits = 0;
  let value = 0;
  let index = 0;

  for (let i = 0; i < length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) {
      throw new Error("Invalid base32 character in secret");
    }
    value = (value << 5) | val;
    bits += 5;
    if (bits >= 8) {
      buffer[index++] = (value >> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return buffer;
}

/**
 * Generate a 6-digit TOTP code for a secret and counter
 */
export function generateTOTP(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  
  let temp = counter;
  for (let i = 7; i >= 0; i--) {
    buffer[i] = temp & 0xff;
    temp = temp >> 8;
  }

  const hmac = crypto.createHmac("sha1", key);
  hmac.update(buffer);
  const hmacResult = hmac.digest();

  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  const otp = code % 1000000;
  return otp.toString().padStart(6, "0");
}

/**
 * Verify a TOTP code within a specific step window (default 1 step = 30s drift)
 */
export function verifyTOTP(token: string, secret: string, windowSteps = 1): boolean {
  if (!secret) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (let errorWindow = -windowSteps; errorWindow <= windowSteps; errorWindow++) {
    if (generateTOTP(secret, counter + errorWindow) === token) {
      return true;
    }
  }
  return false;
}

/**
 * Generate standard OTPAuth URL for QR Code generator
 */
export function generateTOTPUri(email: string, secret: string): string {
  return `otpauth://totp/DiraAfrica:${encodeURIComponent(email)}?secret=${secret}&issuer=DiraAfrica`;
}
