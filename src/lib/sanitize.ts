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
 * Trim, remove null bytes (\0), and truncate string to a maximum of 500 characters.
 */
export function sanitizeString(input: any, maxLength = 500): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/\0/g, "").trim().slice(0, maxLength);
}

/**
 * Normalise a phone number to Kenyan 2547XXXXXXXX or 2541XXXXXXXX format.
 */
export function sanitizePhone(input: any): string {
  if (typeof input !== "string") {
    return "";
  }

  // Strip all non-digit characters
  const digits = input.replace(/\D/g, "");

  // If it starts with 254 and has 12 digits, return it
  if (digits.startsWith("254") && digits.length === 12) {
    return digits;
  }

  // If it starts with 0 and has 10 digits (e.g. 0712345678 or 0112345678)
  if (digits.startsWith("0") && digits.length === 10) {
    return "254" + digits.slice(1);
  }

  // If it has 9 digits and starts with 7 or 1 (e.g. 712345678 or 112345678)
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) {
    return "254" + digits;
  }

  return digits;
}

/**
 * Validate that latitude and longitude are within Kenya bounds.
 * (lat -4.67 to 4.62, lon 33.9 to 41.9)
 */
export function validateCoordinate(lat: any, lon: any): boolean {
  const parsedLat = parseFloat(lat);
  const parsedLon = parseFloat(lon);
  
  if (isNaN(parsedLat) || isNaN(parsedLon)) {
    return false;
  }

  return parsedLat >= -4.67 && parsedLat <= 4.62 && parsedLon >= 33.9 && parsedLon <= 41.9;
}
