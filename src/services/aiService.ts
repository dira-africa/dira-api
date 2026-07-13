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
import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";

export interface VerificationResult {
  isVerified: boolean;
  confidence: number;
  healthScore: number;
  detectedIssues: Record<string, any>;
  reportEn: string;
  reportSw: string;
  identifiedSpecies: string;
  reason?: string;
}

export class AiService {
  private genAI: GoogleGenerativeAI | null = null;

  constructor() {
    const apiKey = env.GEMINI_API_KEY;
    if (apiKey && apiKey !== "placeholder" && !apiKey.includes("placeholder")) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    }
  }

  /**
   * Helper: Calculate Haversine distance in km
   */
  private getHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Main AI pipeline execution using Gemini
   */
  async verifyCropPhoto(
    photoUrlOrPath: string,
    cropType: string,
    farmId?: string,
    latitude?: number,
    longitude?: number
  ): Promise<VerificationResult> {
    // 1. Download photo / Load buffer
    let imageBuffer: Buffer;
    try {
      if (photoUrlOrPath.startsWith("http://") || photoUrlOrPath.startsWith("https://")) {
        const res = await fetch(photoUrlOrPath);
        if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
        imageBuffer = Buffer.from(await res.arrayBuffer());
      } else {
        if (!fs.existsSync(photoUrlOrPath)) {
          throw new Error(`File does not exist: ${photoUrlOrPath}`);
        }
        imageBuffer = fs.readFileSync(photoUrlOrPath);
      }
    } catch (err: any) {
      console.error("Failed to load photo buffer:", err);
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { file_load_error: true },
        reportEn: `Failed to load image buffer: ${err.message}`,
        reportSw: `Imeshindwa kupakia faili ya picha: ${err.message}`,
        identifiedSpecies: "None",
        reason: "IMAGE_LOAD_FAILED"
      };
    }

    // 2. Validate and limit uploaded image size (10MB limit)
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (imageBuffer.length > MAX_SIZE) {
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { image_too_large: true },
        reportEn: "Image is too large. Maximum size allowed is 10MB.",
        reportSw: "Picha ni kubwa mno. Kiwango cha juu cha ukubwa ni 10MB.",
        identifiedSpecies: "None",
        reason: "IMAGE_TOO_LARGE"
      };
    }

    // 3. Authenticity checks - Image Size
    let metadata: sharp.Metadata;
    try {
      metadata = await sharp(imageBuffer).metadata();
    } catch (err: any) {
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { invalid_image_format: true },
        reportEn: "Invalid image format.",
        reportSw: "Mfumo wa picha si sahihi.",
        identifiedSpecies: "None",
        reason: "INVALID_IMAGE_FORMAT"
      };
    }

    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (width < 200 || height < 200) {
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { image_too_small: true },
        reportEn: "Image is too small. Minimum resolution is 200x200 pixels.",
        reportSw: "Picha ni ndogo sana. Kiwango cha chini cha ubora ni pikseli 200x200.",
        identifiedSpecies: "None",
        reason: "IMAGE_TOO_SMALL"
      };
    }

    // 4. Authenticity checks - Solid color variance
    try {
      const stats = await sharp(imageBuffer)
        .resize(20, 20)
        .raw()
        .toBuffer();

      let sumR = 0, sumG = 0, sumB = 0;
      let sumSqR = 0, sumSqG = 0, sumSqB = 0;
      const numPixels = stats.length / 3;
      for (let i = 0; i < stats.length; i += 3) {
        const r = stats[i];
        const g = stats[i + 1];
        const b = stats[i + 2];
        sumR += r; sumSqR += r * r;
        sumG += g; sumSqG += g * g;
        sumB += b; sumSqB += b * b;
      }
      const varR = (sumSqR / numPixels) - (sumR / numPixels) ** 2;
      const varG = (sumSqG / numPixels) - (sumG / numPixels) ** 2;
      const varB = (sumSqB / numPixels) - (sumB / numPixels) ** 2;

      if (varR < 10 && varG < 10 && varB < 10) {
        return {
          isVerified: false,
          confidence: 0,
          healthScore: 0,
          detectedIssues: { solid_color: true },
          reportEn: "Invalid image (solid colour detected). Please capture a real photo of your crop.",
          reportSw: "Picha isiyo sahihi (rangi moja imegunduliwa). Tafadhali piga picha halisi ya zao lako.",
          identifiedSpecies: "None",
          reason: "SCREENSHOT_REJECTED"
        };
      }
    } catch (err: any) {
      console.error("Solid color check failed:", err);
    }

    // 5. Authenticity checks - Laplacian Blur variance
    try {
      const laplacianKernel = {
        width: 3,
        height: 3,
        kernel: [
          0,  1, 0,
          1, -4, 1,
          0,  1, 0
        ]
      };
      const convolved = await sharp(imageBuffer)
        .greyscale()
        .convolve(laplacianKernel)
        .raw()
        .toBuffer();

      let sum = 0;
      let sumSq = 0;
      const N = convolved.length;
      for (let i = 0; i < N; i++) {
        const val = convolved[i];
        sum += val;
        sumSq += val * val;
      }
      const mean = sum / N;
      const variance = (sumSq / N) - (mean * mean);

      if (variance < 15.0) {
        return {
          isVerified: false,
          confidence: 0,
          healthScore: 0,
          detectedIssues: { blurry_image: true },
          reportEn: "Image quality too low (out of focus or blurry). Make sure the crop is in focus.",
          reportSw: "Ubora wa picha ni wa chini mno (haionyeshi vizuri au ina ukungu). Hakikisha mmea unaonekana wazi.",
          identifiedSpecies: "None",
          reason: "IMAGE_QUALITY_TOO_LOW"
        };
      }
    } catch (err: any) {
      console.error("Blur check failed:", err);
    }

    // 6. Authenticity checks - Time check (EXIF data)
    let isTimeValid = true;
    if (metadata.exif) {
      try {
        const exifStr = metadata.exif.toString("ascii");
        const match = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (match) {
          const [_, y, m, d, hh, mm, ss] = match;
          const photoTime = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
          const now = Date.now();
          const hoursDiff = Math.abs(now - photoTime) / (3600 * 1000);
          if (hoursDiff > 24) {
            isTimeValid = false;
          }
        }
      } catch (exifErr) {
        console.warn("Error parsing EXIF metadata:", exifErr);
      }
    }
    if (!isTimeValid) {
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { photo_too_old: true },
        reportEn: "Submission rejected. Photo must be captured within the last 24 hours.",
        reportSw: "Uwasilishaji umekataliwa. Picha lazima iwe imepigwa ndani ya saa 24 zilizopita.",
        identifiedSpecies: "None",
        reason: "EXIF_TIME_INVALID"
      };
    }

    // 7. Geo-consistency check (Flag geo_anomaly if distance > 10km)
    let geoAnomaly = false;
    if (farmId && latitude !== undefined && longitude !== undefined) {
      try {
        const farmRes = await query(
          `SELECT ST_X(farm_location::geometry) AS longitude, ST_Y(farm_location::geometry) AS latitude 
           FROM farms WHERE id = $1`,
          [farmId]
        );
        if (farmRes.rows.length > 0) {
          const farmLon = Number(farmRes.rows[0].longitude);
          const farmLat = Number(farmRes.rows[0].latitude);
          const dist = this.getHaversineDistance(latitude, longitude, farmLat, farmLon);
          if (dist > 10.0) {
            geoAnomaly = true;
          }
        }
      } catch (dbErr) {
        console.error("Failed to fetch farm coordinates for consistency check:", dbErr);
      }
    }

    // 8. Call Google Gemini Vision model
    if (!this.genAI) {
      // If API key is not configured, fallback/mock for local offline development
      console.warn("⚠️ Google GenAI is not initialized (GEMINI_API_KEY missing). Falling back to development mock.");
      return {
        isVerified: true,
        confidence: 0.915,
        healthScore: 0.85,
        detectedIssues: geoAnomaly ? { geo_anomaly: true } : {},
        reportEn: `Observation: Healthy crop foliage detected.\nInterpretation: Good active growth.\nRecommended Actions:\n- 1. Continue standard weeding.\n- 2. Monitor weekly.\n- 3. Maintain soil nutrition.`,
        reportSw: `Uchunguzi: Majani ya zao yenye afya yamegunduliwa.\nTafsiri: Ukuaji dhabiti wenye afya.\nHatua Zinazopendekezwa:\n- 1. Endelea kupalilia shamba.\n- 2. Chunguza afya kila wiki.\n- 3. Dumisha rutuba ya udongo.`,
        identifiedSpecies: cropType === "Maize" ? "Zea mays" : "Phaseolus vulgaris"
      };
    }

    let responseText = "";
    try {
      const model = this.genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
      const prompt = `
You are an expert agricultural AI assistant. Your task is to analyze the provided photo of a crop field.
The farmer claims this is a photo of the crop type: "${cropType}".

You must evaluate and return a JSON object with the following fields:
1. "isVerified": boolean. Set to true if and only if the image is a clear, real, and genuine photo of a crop field containing the expected crop type: "${cropType}". If the image is a stock photo, a screenshot, a non-crop object, or a mismatching plant, set to false.
2. "confidence": number between 0.0 and 1.0 representing your confidence in the crop classification.
3. "healthScore": number between 0.0 and 1.0 representing the general health of the crops (1.0 is perfectly healthy, 0.0 is dead or severely diseased).
4. "detectedIssues": an object mapping the severity (number between 0.0 and 1.0) of agricultural stress factors:
   - "drought_stress": severity number (0.0 to 1.0)
   - "pest_damage": severity number (0.0 to 1.0)
   - "disease": severity number (0.0 to 1.0)
   - "nutrient_deficiency": severity number (0.0 to 1.0)
   - "flood_damage": severity number (0.0 to 1.0)
   - "species_mismatch": boolean (true if the identified species does not match the claimed crop type: "${cropType}")
5. "identifiedSpecies": string (scientific name or common name of the primary crop identified)
6. "reportEn": string. A brief, professional summary report in English. It MUST follow this exact structure:
   "Observation: <what you observe in the image>
   Interpretation: <what it indicates regarding health and stress>
   Recommended Actions:
   - 1. <first recommendation>
   - 2. <second recommendation>
   - 3. <third recommendation>"
7. "reportSw": string. The exact same report translated accurately and professionally into Swahili. It MUST follow this exact structure:
   "Uchunguzi: <Swahili translation of observation>
   Tafsiri: <Swahili translation of interpretation>
   Hatua Zinazopendekezwa:
   - 1. <first Swahili recommendation>
   - 2. <second Swahili recommendation>
   - 3. <third Swahili recommendation>"

Output only the JSON object, do not include any markdown styling, code blocks, or extra text.
`;

      const result = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  data: imageBuffer.toString("base64"),
                  mimeType: "image/jpeg"
                }
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json"
        }
      });

      responseText = result.response.text();
      const verificationData = JSON.parse(responseText.trim());

      const detectedIssues = verificationData.detectedIssues || {};
      if (geoAnomaly) {
        detectedIssues.geo_anomaly = true;
      }

      return {
        isVerified: !!verificationData.isVerified,
        confidence: Number(verificationData.confidence) || 0,
        healthScore: Number(verificationData.healthScore) || 0,
        detectedIssues,
        reportEn: verificationData.reportEn || "No report details generated.",
        reportSw: verificationData.reportSw || "Hakuna maelezo ya ripoti yaliyotolewa.",
        identifiedSpecies: verificationData.identifiedSpecies || "Unknown"
      };
    } catch (err: any) {
      console.error("Gemini crop verification failed, failing closed:", err);
      if (responseText) {
        console.error("Raw Gemini response text was:\n", responseText);
      }
      return {
        isVerified: false,
        confidence: 0,
        healthScore: 0,
        detectedIssues: { api_failure: true },
        reportEn: `AI crop verification service is temporarily unavailable: ${err.message}`,
        reportSw: `Huduma ya uthibitishaji wa mazao ya AI haipatikani kwa sasa: ${err.message}`,
        identifiedSpecies: "None",
        reason: "GEMINI_API_FAILURE"
      };
    }
  }
}

export const aiService = new AiService();
