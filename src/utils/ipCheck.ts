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

/**
 * Normalizes IP address to strip IPv6 mapping prefixes
 */
export function normalizeIp(ip: string): string {
  let cleaned = ip.trim();
  if (cleaned.startsWith("::ffff:")) {
    cleaned = cleaned.substring(7);
  }
  return cleaned;
}

/**
 * Validates if an IP address is within a single IP or CIDR block
 */
export function ipMatchesCidr(clientIp: string, cidr: string): boolean {
  try {
    const ip = normalizeIp(clientIp);
    const targetCidr = normalizeIp(cidr);

    // Single IP check
    if (!targetCidr.includes("/")) {
      return ip === targetCidr;
    }

    const [subnet, maskStr] = targetCidr.split("/");
    const mask = parseInt(maskStr, 10);

    // IPv4 matching
    if (ip.includes(".") && subnet.includes(".")) {
      const ipParts = ip.split(".").map(Number);
      const subnetParts = subnet.split(".").map(Number);

      if (ipParts.some(isNaN) || subnetParts.some(isNaN)) {
        return false;
      }

      // Convert components into 32-bit unsigned integers
      // Using >>> 0 prevents negative numbers in JS bitwise operations
      const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
      const subnetInt = ((subnetParts[0] << 24) | (subnetParts[1] << 16) | (subnetParts[2] << 8) | subnetParts[3]) >>> 0;

      const maskInt = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
      return (ipInt & maskInt) === (subnetInt & maskInt);
    }

    // fallback for IPv6 exact matches
    return ip === subnet;
  } catch (err) {
    console.error("CIDR evaluation error:", err);
    return false;
  }
}

/**
 * Masks IP address to protect privacy (e.g. 197.•••.•••.45 or 102.68.•••.0/24)
 */
export function maskIp(cidr: string): string {
  try {
    const normalized = normalizeIp(cidr);
    const [ipPart, maskPart] = normalized.split("/");
    
    if (ipPart.includes(".")) {
      const parts = ipPart.split(".");
      if (parts.length === 4) {
        // Mask parts 2 and 3
        const maskedIp = `${parts[0]}.•••.•••.${parts[3]}`;
        return maskPart ? `${maskedIp}/${maskPart}` : maskedIp;
      }
    }
    return normalized;
  } catch {
    return cidr;
  }
}
