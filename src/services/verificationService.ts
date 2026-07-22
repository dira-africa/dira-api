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

import fs from "fs";
import sharp from "sharp";
import { query } from "../db/query";
import { aiService, VerificationResult } from "./aiService";
import { reputationService } from "./reputationService";
import { dependencyRegistry } from "./dependencyRegistry";

// Helper: Calculate Hamming distance between two hex string hashes
export function getHammingDistance(hash1: string, hash2: string): number {
  if (!hash1 || !hash2 || hash1.length !== hash2.length) return 999;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    const val1 = parseInt(hash1[i], 16);
    const val2 = parseInt(hash2[i], 16);
    let xor = val1 ^ val2;
    while (xor > 0) {
      if (xor & 1) distance++;
      xor >>= 1;
    }
  }
  return distance;
}

// Helper: Compute average hash (aHash) using sharp
export async function computeAverageHash(imageBuffer: Buffer): Promise<string> {
  const resized = await sharp(imageBuffer)
    .resize(8, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  let sum = 0;
  for (let i = 0; i < 64; i++) {
    sum += resized[i];
  }
  const avg = sum / 64;

  let hashBinary = "";
  for (let i = 0; i < 64; i++) {
    hashBinary += resized[i] >= avg ? "1" : "0";
  }

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = hashBinary.substring(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}

export interface VerificationFactors {
  reputationPrior: number;
  priorOdds: number;
  geminiMatchLr: number;
  plantnetMatchLr: number;
  weatherAgreementLr: number;
  geofenceMembershipLr: number;
  gpsPlausibilityLr: number;
  duplicateHashLr: number;
  posteriorOdds: number;
  posteriorProbability: number;
}

export interface BayesianResult {
  score: number;
  status: "verified" | "rejected" | "manual_review";
  factors: VerificationFactors;
  perceptualHash: string;
  aiResult: VerificationResult;
  needsRecheck?: boolean;
}

// Configurable Server-side parameters
export const VERIFICATION_CONFIG = {
  // Thresholds
  thresholdAccept: 0.75,
  thresholdReject: 0.35,

  // Priors
  defaultPrior: 0.65,
  minPrior: 0.10,
  maxPrior: 0.95,

  // Gemini Likelihoods
  geminiMatchGivenGenuine: 0.90,
  geminiMatchGivenFraud: 0.15,
  geminiMismatchGivenGenuine: 0.01,
  geminiMismatchGivenFraud: 0.95,

  // PlantNet Likelihoods
  plantnetMatchGivenGenuine: 0.85,
  plantnetMatchGivenFraud: 0.10,
  plantnetMismatchGivenGenuine: 0.005,
  plantnetMismatchGivenFraud: 0.95,

  // Open-Meteo Weather Likelihoods
  weatherMatchGivenGenuine: 0.95,
  weatherMatchGivenFraud: 0.50,
  weatherMismatchGivenGenuine: 0.05,
  weatherMismatchGivenFraud: 0.90,

  // Geofence Likelihoods
  geofenceMatchGivenGenuine: 0.98,
  geofenceMatchGivenFraud: 0.30,
  geofenceMismatchGivenGenuine: 0.005,
  geofenceMismatchGivenFraud: 0.90,

  // GPS/Time EXIF Likelihoods
  exifMatchGivenGenuine: 0.95,
  exifMatchGivenFraud: 0.40,
  exifMismatchGivenGenuine: 0.05,
  exifMismatchGivenFraud: 0.90,

  // Perceptual Hash Likelihoods
  uniqueGivenGenuine: 0.999,
  uniqueGivenFraud: 0.95,
  duplicateGivenGenuine: 0.00001,
  duplicateGivenFraud: 0.20
};

export class VerificationService {
  /**
   * Verifies a crop submission using the Bayesian engine
   */
  async verifyCropSubmission(
    submissionId: string,
    options: {
      photoPath: string;
      cropType: string;
      latitude: number;
      longitude: number;
      userId: string;
      farmId: string;
      growthStage: string;
    }
  ): Promise<BayesianResult> {
    const { photoPath, cropType, latitude, longitude, userId, farmId } = options;

    // 1. Prior Odds
    const reputationPrior = await reputationService.getTrustPrior(userId);
    const priorOdds = reputationPrior / (1 - reputationPrior);

    // 2. Read Image Buffer
    if (!fs.existsSync(photoPath)) {
      throw new Error(`Photo file not found: ${photoPath}`);
    }
    const imageBuffer = fs.readFileSync(photoPath);

    // 3. Compute Perceptual Hash and duplicate lookup
    let perceptualHash = "0000000000000000";
    let duplicateHashLr = 1.0;
    try {
      perceptualHash = await computeAverageHash(imageBuffer);
      const pastHashesRes = await query(
        "SELECT id, perceptual_hash FROM crop_submissions WHERE perceptual_hash IS NOT NULL AND id != $1",
        [submissionId]
      );
      let duplicateFound = false;
      for (const row of pastHashesRes.rows) {
        const dist = getHammingDistance(row.perceptual_hash, perceptualHash);
        if (dist <= 4) {
          duplicateFound = true;
          break;
        }
      }

      if (duplicateFound) {
        duplicateHashLr = VERIFICATION_CONFIG.duplicateGivenGenuine / VERIFICATION_CONFIG.duplicateGivenFraud;
      } else {
        duplicateHashLr = VERIFICATION_CONFIG.uniqueGivenGenuine / VERIFICATION_CONFIG.uniqueGivenFraud;
      }
    } catch (hashErr) {
      console.error("Failed to compute perceptual hash, treating as neutral:", hashErr);
    }

    // 4. PostGIS Geofence membership
    let geofenceMembershipLr = 1.0;
    try {
      // Check if coordinate is within 25km of the registered farm
      const geofenceRes = await query(
        `SELECT ST_DWithin(
           location::geography,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           25000
         ) AS within_geofence
         FROM farms
         WHERE id = $3`,
        [longitude, latitude, farmId]
      );
      const inGeofence = geofenceRes.rows.length > 0 && geofenceRes.rows[0].within_geofence;
      if (inGeofence) {
        geofenceMembershipLr = VERIFICATION_CONFIG.geofenceMatchGivenGenuine / VERIFICATION_CONFIG.geofenceMatchGivenFraud;
      } else {
        geofenceMembershipLr = VERIFICATION_CONFIG.geofenceMismatchGivenGenuine / VERIFICATION_CONFIG.geofenceMismatchGivenFraud;
      }
    } catch (geoErr) {
      console.error("Failed to perform PostGIS geofence lookup, treating as neutral:", geoErr);
    }

    // 5. GPS + Timestamp Plausibility (EXIF checks)
    let gpsPlausibilityLr = 1.0;
    try {
      const metadata = await sharp(imageBuffer).metadata();
      let exifValid = true;
      if (metadata.exif) {
        const exifStr = metadata.exif.toString("ascii");
        const match = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const [_, y, m, d, hh, mm, ss] = match;
          const photoTime = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
          const hoursDiff = Math.abs(Date.now() - photoTime) / (3600 * 1000);
          if (hoursDiff > 24) {
            exifValid = false;
          }
        }
      }
      
      if (exifValid) {
        gpsPlausibilityLr = VERIFICATION_CONFIG.exifMatchGivenGenuine / VERIFICATION_CONFIG.exifMatchGivenFraud;
      } else {
        gpsPlausibilityLr = VERIFICATION_CONFIG.exifMismatchGivenGenuine / VERIFICATION_CONFIG.exifMismatchGivenFraud;
      }
    } catch (exifErr) {
      console.error("Failed to perform EXIF check, treating as neutral:", exifErr);
    }

    // 6. Open-Meteo Weather agreement (temperature range check with circuit breaker)
    let weatherAgreementLr = 1.0;
    const isWeatherAvailable = dependencyRegistry.isAvailable("openmeteo");
    if (isWeatherAvailable) {
      try {
        const dateStr = new Date().toISOString().split("T")[0];
        const roundedLat = Number(latitude.toFixed(2));
        const roundedLng = Number(longitude.toFixed(2));
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${roundedLat}&longitude=${roundedLng}&hourly=temperature_2m&start_date=${dateStr}&end_date=${dateStr}`;
        
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json();
          const temps: number[] = data.hourly?.temperature_2m || [];
          const currentHour = new Date().getUTCHours();
          const temp = temps[currentHour] !== undefined ? temps[currentHour] : 25; // fallback to warm Kenya average
          
          // Plausible Kenya temperatures: between 8°C and 43°C
          const consistent = temp >= 8.0 && temp <= 43.0;
          if (consistent) {
            weatherAgreementLr = VERIFICATION_CONFIG.weatherMatchGivenGenuine / VERIFICATION_CONFIG.weatherMatchGivenFraud;
          } else {
            weatherAgreementLr = VERIFICATION_CONFIG.weatherMismatchGivenGenuine / VERIFICATION_CONFIG.weatherMismatchGivenFraud;
          }
          dependencyRegistry.recordSuccess("openmeteo");
        } else {
          throw new Error(`Open-Meteo returned status ${res.status}`);
        }
      } catch (weatherErr) {
        console.warn("Open-Meteo call failed, using default simulated diurnal check:", weatherErr);
        dependencyRegistry.recordFailure("openmeteo", weatherErr);
        // Diurnal weather fallback: consistent
        weatherAgreementLr = VERIFICATION_CONFIG.weatherMatchGivenGenuine / VERIFICATION_CONFIG.weatherMatchGivenFraud;
      }
    } else {
      console.warn("Open-Meteo circuit is OPEN. Using weather fallback.");
      // Diurnal weather fallback: consistent
      weatherAgreementLr = VERIFICATION_CONFIG.weatherMatchGivenGenuine / VERIFICATION_CONFIG.weatherMatchGivenFraud;
    }

    // 7. Gemini crop-photo match
    const aiResult = await aiService.verifyCropPhoto(photoPath, cropType, farmId, latitude, longitude);
    let geminiMatchLr = 1.0;
    
    // Ignore minor file loading/API failures and keep LR neutral rather than auto-rejecting
    if (aiResult.reason !== "IMAGE_LOAD_FAILED" && aiResult.reason !== "GEMINI_API_FAILURE") {
      if (aiResult.isVerified) {
        // scale matching strength based on confidence score (up to max LR)
        const baseLr = VERIFICATION_CONFIG.geminiMatchGivenGenuine / VERIFICATION_CONFIG.geminiMatchGivenFraud;
        geminiMatchLr = 1.0 + (aiResult.confidence * (baseLr - 1.0));
      } else {
        const baseLr = VERIFICATION_CONFIG.geminiMismatchGivenGenuine / VERIFICATION_CONFIG.geminiMismatchGivenFraud;
        geminiMatchLr = 1.0 - (aiResult.confidence * (1.0 - baseLr));
      }
    }

    // 8. PlantNet identification (Simulated match against Gemini species / crop classification with circuit breaker)
    let plantnetMatchLr = 1.0;
    const isPlantnetAvailable = dependencyRegistry.isAvailable("plantnet");
    if (isPlantnetAvailable) {
      try {
        const species = (aiResult.identifiedSpecies || "").toLowerCase();
        const target = cropType.toLowerCase();
        
        // Basic fuzzy matching of crop classification species
        const isMatch = 
          (target.includes("maize") && (species.includes("zea") || species.includes("maize") || species.includes("corn"))) ||
          (target.includes("bean") && (species.includes("phaseolus") || species.includes("bean"))) ||
          (target.includes("wheat") && (species.includes("triticum") || species.includes("wheat"))) ||
          (target.includes("tea") && (species.includes("camellia") || species.includes("tea"))) ||
          (target.includes("coffee") && (species.includes("coffea") || species.includes("coffee"))) ||
          (target.includes("veg") && (species.length > 3 && !species.includes("none") && !species.includes("unknown")));

        if (isMatch) {
          plantnetMatchLr = VERIFICATION_CONFIG.plantnetMatchGivenGenuine / VERIFICATION_CONFIG.plantnetMatchGivenFraud;
        } else {
          plantnetMatchLr = VERIFICATION_CONFIG.plantnetMismatchGivenGenuine / VERIFICATION_CONFIG.plantnetMismatchGivenFraud;
        }
        dependencyRegistry.recordSuccess("plantnet");
      } catch (plantErr) {
        console.error("PlantNet verification simulation error, treating as neutral:", plantErr);
        dependencyRegistry.recordFailure("plantnet", plantErr);
      }
    } else {
      console.warn("PlantNet circuit is OPEN. Treating as neutral.");
      plantnetMatchLr = 1.0;
    }

    // 9. Combine all signals using Bayesian posterior multiplication
    const posteriorOdds = priorOdds * 
                          geminiMatchLr * 
                          plantnetMatchLr * 
                          weatherAgreementLr * 
                          geofenceMembershipLr * 
                          gpsPlausibilityLr * 
                          duplicateHashLr;

    const posteriorProbability = Number((posteriorOdds / (1 + posteriorOdds)).toFixed(4));

    // Determine thresholds dynamically based on the submitter's trust tier
    const rep = await reputationService.getOrCreateReputation(userId);
    let thresholdAccept = VERIFICATION_CONFIG.thresholdAccept; // default 0.75
    let thresholdReject = VERIFICATION_CONFIG.thresholdReject; // default 0.35

    if (rep.trustTier === "trusted") {
      thresholdAccept = 0.70; // loose threshold for trusted agents
      thresholdReject = 0.30;
    } else if (rep.trustTier === "flagged") {
      thresholdAccept = 0.85; // strict threshold for flagged agents
      thresholdReject = 0.45;
    }

    // Determine final status
    let status: "verified" | "rejected" | "manual_review" = "manual_review";
    let needsRecheck = false;

    if (aiResult.reason === "GEMINI_API_FAILURE") {
      // Graceful degradation: compute using other signals but always flag for manual review / re-check
      status = "manual_review";
      needsRecheck = true;
    } else {
      if (posteriorProbability >= thresholdAccept) {
        status = "verified";
      } else if (posteriorProbability < thresholdReject) {
        status = "rejected";
      }
    }

    const factors: VerificationFactors = {
      reputationPrior,
      priorOdds,
      geminiMatchLr: Number(geminiMatchLr.toFixed(3)),
      plantnetMatchLr: Number(plantnetMatchLr.toFixed(3)),
      weatherAgreementLr: Number(weatherAgreementLr.toFixed(3)),
      geofenceMembershipLr: Number(geofenceMembershipLr.toFixed(3)),
      gpsPlausibilityLr: Number(gpsPlausibilityLr.toFixed(3)),
      duplicateHashLr: Number(duplicateHashLr.toFixed(3)),
      posteriorOdds: Number(posteriorOdds.toFixed(3)),
      posteriorProbability
    };

    return {
      score: posteriorProbability,
      status,
      factors,
      perceptualHash,
      aiResult,
      needsRecheck
    };
  }
}

export const verificationService = new VerificationService();

export function getOutcomeAndReason(
  status: string,
  factors: any,
  rejectionReason: string | null,
  lang: "en" | "sw"
): { outcome: string; reason: string } {
  const isSw = lang === "sw";
  
  if (status === "verified") {
    return {
      outcome: isSw ? "Imehakikishwa" : "Verified",
      reason: isSw ? "Uwasilishaji wako umethibitishwa kikamilifu." : "Your submission has been fully verified."
    };
  }

  if (status === "pending") {
    return {
      outcome: isSw ? "Inasubiri Uhakiki" : "Pending Verification",
      reason: isSw ? "Mchakato wa uhakiki unaendelea kujiendesha." : "Verification process is running automatically."
    };
  }

  if (status === "manual_review" || status === "escalated") {
    return {
      outcome: isSw ? "Inahitaji Uhakiki" : "Needs Review",
      reason: isSw ? "Inasubiri ukaguzi wa mwongozo na timu yetu ya kilimo." : "Pending manual review by our agricultural team."
    };
  }

  if (status === "appealed") {
    return {
      outcome: isSw ? "Chini ya Rufaa" : "Under Appeal",
      reason: isSw ? "Rufaa yako imepokelewa na inasubiri ukaguzi wa mwongozo." : "Your appeal has been received and is pending human review."
    };
  }

  // rejected
  let outcome = isSw ? "Imekataliwa" : "Rejected";
  let reason = "";

  if (rejectionReason && !["DUPLICATE_PHOTO", "BAYESIAN_REJECTION", "LOW_QUALITY", "SPECIES_MISMATCH"].includes(rejectionReason.toUpperCase()) && !rejectionReason.toUpperCase().includes("REJECTION")) {
    reason = rejectionReason;
  } else if (factors) {
    if (Number(factors.duplicateHashLr) < 1.0) {
      reason = isSw 
        ? "Picha hii inaonekana kunakiliwa kutoka kwa uwasilishaji uliopita." 
        : "The photo appears to be a duplicate of a previously submitted image.";
    } else if (Number(factors.geofenceMembershipLr) < 1.0) {
      reason = isSw 
        ? "Mahali pa picha hii kulingana na GPS ni mbali sana na shamba lako lililosajiliwa." 
        : "The photo GPS location is too far from your registered farm coordinates.";
    } else if (Number(factors.gpsPlausibilityLr) < 1.0) {
      reason = isSw 
        ? "Picha haikupigwa ndani ya saa 24 zilizopita." 
        : "The photo was not taken within the required recent 24-hour timeframe.";
    } else if (Number(factors.geminiMatchLr) < 1.0) {
      reason = isSw 
        ? "Uchunguzi wa AI unaonyesha aina ya zao hailingani au picha haina ubora ya kutosha." 
        : "AI vision check indicates a species mismatch or insufficient photo quality.";
    } else if (Number(factors.plantnetMatchLr) < 1.0) {
      reason = isSw 
        ? "Uhakiki wa pili wa aina ya zao haukuweza kuthibitisha aina ya mmea." 
        : "Secondary species verification could not confirm the crop type.";
    } else if (Number(factors.weatherAgreementLr) < 1.0) {
      reason = isSw 
        ? "Uchunguzi wa hali ya hewa haukulingana na ripoti za anga za eneo lako." 
        : "The weather check did not match regional meteorological data.";
    } else {
      reason = isSw 
        ? "Uwasilishaji haukufikia viwango vya jumla vya uthibitishaji." 
        : "The submission did not meet the overall verification confidence thresholds.";
    }
  } else {
    reason = isSw 
      ? "Uwasilishaji haukufikia viwango vya uthibitishaji." 
      : "The submission did not meet verification standards.";
  }

  return { outcome, reason };
}

export function getAirtimeBreakdown(actualTokens: number): {
  baseTokens: number;
  baseAirtime: number;
  bonusTokens: number;
  bonusAirtime: number;
  totalTokens: number;
  totalAirtime: number;
  kesPerToken: number;
} {
  const KES_PER_TOKEN = 0.55;
  let baseTokens = 0;
  let bonusTokens = 0;

  if (actualTokens === 15) {
    baseTokens = 15;
    bonusTokens = 0;
  } else if (actualTokens === 6) {
    baseTokens = 5;
    bonusTokens = 1;
  } else if (actualTokens === 5) {
    baseTokens = 5;
    bonusTokens = 0;
  } else {
    baseTokens = actualTokens;
    bonusTokens = 0;
  }

  return {
    baseTokens,
    baseAirtime: Number((baseTokens * KES_PER_TOKEN).toFixed(2)),
    bonusTokens,
    bonusAirtime: Number((bonusTokens * KES_PER_TOKEN).toFixed(2)),
    totalTokens: actualTokens,
    totalAirtime: Number((actualTokens * KES_PER_TOKEN).toFixed(2)),
    kesPerToken: KES_PER_TOKEN
  };
}

