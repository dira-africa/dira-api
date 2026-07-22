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

import { argon2id } from "hash-wasm";
import crypto from "crypto";

/**
 * Hash a password using Argon2id
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return argon2id({
    password,
    salt,
    parallelism: 1,
    memorySize: 65536, // 64MB
    iterations: 3,
    hashLength: 32,
    outputType: "encoded"
  });
}

/**
 * Verify a password against an Argon2id encoded hash in a timing-safe manner
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    const parts = hash.split("$");
    if (parts.length !== 6 || parts[1] !== "argon2id") {
      return false;
    }

    const paramsPart = parts[3]; // m=65536,t=3,p=1
    const saltBase64 = parts[4];

    const params: Record<string, number> = {};
    paramsPart.split(",").forEach(p => {
      const [k, v] = p.split("=");
      params[k] = parseInt(v, 10);
    });

    let saltString = saltBase64;
    while (saltString.length % 4 !== 0) {
      saltString += "=";
    }
    const saltBuffer = Buffer.from(saltString, "base64");

    const calculated = await argon2id({
      password,
      salt: saltBuffer,
      parallelism: params.p || 1,
      memorySize: params.m || 65536,
      iterations: params.t || 3,
      hashLength: 32,
      outputType: "encoded"
    });

    if (calculated.length !== hash.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(hash));
  } catch (err) {
    console.error("Password verification error:", err);
    return false;
  }
}

/**
 * Verify if password meets the strong password criteria
 */
export function isStrongPassword(password: string): boolean {
  if (password.length < 12) return false;
  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumbers = /\d/.test(password);
  const hasNonalphas = /\W/.test(password);
  return hasUpperCase && hasLowerCase && hasNumbers && hasNonalphas;
}
