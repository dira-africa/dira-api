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

// Swahili agricultural terms dictionary
const AGRI_DICT: Record<string, string> = {
  // Headings
  "Observation": "Uchunguzi",
  "Interpretation": "Tafsiri",
  "Recommended Actions": "Hatua Zinazopendekezwa",

  // Observations
  "Healthy crop foliage detected with active growth.": "Majani ya zao yenye afya yamegunduliwa yakiwa na ukuaji dhabiti.",
  "Foliage shows signs of significant yellowing.": "Majani yanaonyesha dalili za njano kupita kiasi.",
  "Foliage shows necrotic spots or browning.": "Majani yanaonyesha madoa ya seli zilizokufa au rangi ya kahawia.",
  "Foliage exhibits yellowing and browning simultaneously.": "Majani yanaonyesha dalili za njano na kahawia kwa wakati mmoja.",

  // Interpretations
  "Chlorophyll levels are optimal, confirming healthy photosynthesis.": "Kiwango cha klorofili ni kizuri, kikithibitisha usimbaji hewa wenye afya.",
  "Yellowing indicates potential nitrogen deficiency or drought stress.": "Ujano unaonyesha uwezekano wa upungufu wa nitrojeni au ukame.",
  "Browning suggests pest damage or fungal disease infection.": "Rangi ya kahawia inaashiria uharibifu wa wadudu au maambukizi ya fangasi.",
  "Combined symptoms suggest multi-stress conditions (disease and nutrient deficiency).": "Dalili mchanganyiko zinaashiria changamoto nyingi kwa wakati mmoja (ugonjwa na upungufu wa virutubisho).",

  // Recommendations
  "Continue standard weeding and irrigation schedules.": "Endelea na ratiba ya kawaida ya kupalilia na kumwagilia maji.",
  "Monitor crop health weekly for any early pest indicators.": "Chunguza afya ya zao kila wiki ili kugundua wadudu mapema.",
  "Maintain farm hygiene and soil nutrition levels.": "Weka shamba katika hali ya usafi na udumishe rutuba ya udongo.",
  "Apply nitrogen-rich fertilizer (e.g. CAN or Urea) to boost growth.": "Weka mbolea yenye nitrojeni kwa wingi (k.m. CAN au Urea) ili kukuza zao.",
  "Increase watering frequency to mitigate drought stress.": "Ongeza ratiba ya kumwagilia maji ili kukabiliana na ukame.",
  "Perform soil test to check pH and nutrient availability.": "Pima udongo ili kujua kiwango cha tindikali na virutubisho vilivyopo.",
  "Spray appropriate organic or recommended chemical pesticides.": "Nyunyizia dawa inayofaa ya kikaboni au ya kemikali dhidi ya wadudu.",
  "Prune and burn heavily infected leaves to halt disease spread.": "Kata na uchome moto majani yaliyoathirika sana ili kuzuia kuenea kwa ugonjwa.",
  "Improve air circulation by proper spacing and weeding.": "Imarisha mzunguko wa hewa kwa nafasi sahihi ya mimea na kupalilia.",
  "Consult your local agricultural extension officer for diagnostic support.": "Wasiliana na afisa wa ugani wa kilimo wa eneo lako kwa usaidizi.",
  "Implement integrated pest and disease management protocols.": "Tekeleza mbinu jumuishi za kudhibiti wadudu na magonjwa.",
  "Apply broad-spectrum fungicide if fungal infection is active.": "Weka dawa ya kuua fangasi ya wigo mpana ikiwa fangasi wapo hai."
};

const translate = (text: string): string => {
  const cleanText = text.replace(/^\d+\.\s+/, "").replace(/^-\s+/, "").trim();
  const translated = AGRI_DICT[cleanText] || cleanText;
  if (text.startsWith("1.")) return `1. ${translated}`;
  if (text.startsWith("2.")) return `2. ${translated}`;
  if (text.startsWith("3.")) return `3. ${translated}`;
  if (text.startsWith("- ")) return `- ${translated}`;
  return translated;
};

export class AiService {
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
   * Call PlantNet API (or mock) to identify plant species.
   */
  async identifyPlantFromBuffer(
    buffer: Buffer,
    cropType: string
  ): Promise<{ isMatched: boolean; species: string; confidence: number }> {
    const apiKey = process.env.PLANTNET_API_KEY;

    if (!apiKey || apiKey === "placeholder" || apiKey.includes("placeholder")) {
      return this.mockPlantNet(cropType);
    }

    try {
      const blob = new Blob([buffer as any], { type: "image/jpeg" });
      const formData = new FormData();
      formData.append("organs", "leaf");
      formData.append("images", blob, "crop.jpg");

      const res = await fetch(`https://my-api.plantnet.org/v2/identify/all?api-key=${apiKey}`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`PlantNet HTTP error: ${res.status}`);
      }

      const data = await res.json();
      const results = data.results || [];

      if (results.length === 0) {
        return { isMatched: false, species: "Unknown", confidence: 0 };
      }

      for (const result of results.slice(0, 3)) {
        const speciesName = result.species?.scientificNameWithoutAuthor || "";
        const score = result.score || 0;

        if (this.matchesCropType(speciesName, cropType)) {
          return { isMatched: true, species: speciesName, confidence: score };
        }
      }

      const primarySpecies = results[0].species?.scientificNameWithoutAuthor || "Unknown";
      const primaryScore = results[0].score || 0;
      return { isMatched: false, species: primarySpecies, confidence: primaryScore };
    } catch (err) {
      console.error("PlantNet API request failed, falling back to mock:", err);
      return this.mockPlantNet(cropType);
    }
  }

  private matchesCropType(scientificName: string, cropType: string): boolean {
    const name = scientificName.toLowerCase();
    const type = cropType.toLowerCase();

    if (type === "maize" && name.includes("zea mays")) return true;
    if (type === "beans" && (name.includes("phaseolus") || name.includes("vicia") || name.includes("vigna"))) return true;
    if (type === "wheat" && name.includes("triticum")) return true;
    if (type === "tea" && name.includes("camellia sinensis")) return true;
    if (type === "coffee" && name.includes("coffea")) return true;
    if (type === "vegetables") {
      const commonVeg = ["brassica", "solanum", "allium", "spinacia", "lactuca", "capsicum", "lycopersicon", "daucus"];
      return commonVeg.some(veg => name.includes(veg));
    }
    if (type === "other") return true;

    return false;
  }

  private mockPlantNet(cropType: string): { isMatched: boolean; species: string; confidence: number } {
    const speciesMap: Record<string, string> = {
      Maize: "Zea mays",
      Beans: "Phaseolus vulgaris",
      Wheat: "Triticum aestivum",
      Tea: "Camellia sinensis",
      Coffee: "Coffea arabica",
      Vegetables: "Solanum lycopersicum",
      Other: "Ageratum conyzoides",
    };

    return {
      isMatched: true,
      species: speciesMap[cropType] || "Zea mays",
      confidence: 0.915,
    };
  }

  /**
   * Main AI pipeline execution
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

    // 2. Authenticity checks - Image Size
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

    // 3. Authenticity checks - Solid color variance
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

    // 4. Authenticity checks - Laplacian Blur variance
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

    // 5. Authenticity checks - Time check (EXIF data)
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

    // 6. Geo-consistency check (Flag geo_anomaly if distance > 10km)
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

    // 7. Plant Detection
    const idResult = await this.identifyPlantFromBuffer(imageBuffer, cropType);

    // Mismatch flag (do not reject mix crop farming)
    const speciesMismatch = !idResult.isMatched;

    // 8. Health Assessment (colour ratio calculations)
    let colorGrid: Buffer;
    try {
      colorGrid = await sharp(imageBuffer)
        .resize(100, 100)
        .raw()
        .toBuffer();
    } catch (err: any) {
      colorGrid = Buffer.alloc(30000); // safety fallback
    }

    let greenCount = 0;
    let yellowCount = 0;
    let brownCount = 0;
    const pixelCount = colorGrid.length / 3;

    for (let i = 0; i < colorGrid.length; i += 3) {
      const r = colorGrid[i];
      const g = colorGrid[i + 1];
      const b = colorGrid[i + 2];

      if (g > r * 1.05 && g > b * 1.05 && g > 40) {
        greenCount++;
      } else if (r > 100 && g > 100 && b < 120 && Math.abs(r - g) < 30 && r > b * 1.3) {
        yellowCount++;
      } else if (r > 50 && r < 180 && g > 30 && g < 150 && b < 100 && r > g * 1.1) {
        brownCount++;
      }
    }

    const greenRatio = greenCount / pixelCount;
    const yellowRatio = yellowCount / pixelCount;
    const brownRatio = brownCount / pixelCount;

    // Reject if image has less than 8% green pixels (non-foliage filter)
    if (greenRatio < 0.08) {
      return {
        isVerified: false,
        confidence: idResult.confidence,
        healthScore: greenRatio,
        detectedIssues: { no_vegetation: true },
        reportEn: "Low greenness detected. The image does not contain healthy crop foliage or vegetation. Make sure you are taking a photo of a live crop.",
        reportSw: "Kiwango cha kijani kibichi ni cha chini mno. Picha haionyeshi majani yenye afya ya mmea. Hakikisha unapiga picha ya mmea ulio hai.",
        identifiedSpecies: idResult.species,
        reason: "LOW_GREENNESS_REJECTED"
      };
    }

    const drought_stress = Number(Math.min(1.0, yellowRatio * 3).toFixed(3));
    const nutrient_deficiency = Number(Math.min(1.0, yellowRatio * 2).toFixed(3));
    const pest_damage = Number(Math.min(1.0, brownRatio * 2).toFixed(3));
    const disease = Number(Math.min(1.0, brownRatio * 2.5).toFixed(3));
    const flood_damage = Number(Math.min(1.0, (yellowRatio + brownRatio) * 0.5).toFixed(3));

    const issues: Record<string, any> = {
      drought_stress,
      pest_damage,
      disease,
      nutrient_deficiency,
      flood_damage
    };

    if (geoAnomaly) issues.geo_anomaly = true;
    if (speciesMismatch) issues.species_mismatch = true;

    // Deduct from initial perfect 1.0 health score based on symptoms
    const deductions = drought_stress * 0.4 + nutrient_deficiency * 0.2 + pest_damage * 0.2 + disease * 0.2;
    const healthScore = Number(Math.max(0.0, Math.min(1.0, 1.0 - deductions)).toFixed(3));

    // 9. Report templates selector
    let observation = "Healthy crop foliage detected with active growth.";
    let interpretation = "Chlorophyll levels are optimal, confirming healthy photosynthesis.";
    let rec1 = "1. Continue standard weeding and irrigation schedules.";
    let rec2 = "2. Monitor crop health weekly for any early pest indicators.";
    let rec3 = "3. Maintain farm hygiene and soil nutrition levels.";

    if (yellowRatio > 0.1 && brownRatio > 0.1) {
      observation = "Foliage exhibits yellowing and browning simultaneously.";
      interpretation = "Combined symptoms suggest multi-stress conditions (disease and nutrient deficiency).";
      rec1 = "1. Consult your local agricultural extension officer for diagnostic support.";
      rec2 = "2. Implement integrated pest and disease management protocols.";
      rec3 = "3. Apply broad-spectrum fungicide if fungal infection is active.";
    } else if (yellowRatio > 0.1) {
      observation = "Foliage shows signs of significant yellowing.";
      interpretation = "Yellowing indicates potential nitrogen deficiency or drought stress.";
      rec1 = "1. Apply nitrogen-rich fertilizer (e.g. CAN or Urea) to boost growth.";
      rec2 = "2. Increase watering frequency to mitigate drought stress.";
      rec3 = "3. Perform soil test to check pH and nutrient availability.";
    } else if (brownRatio > 0.1) {
      observation = "Foliage shows necrotic spots or browning.";
      interpretation = "Browning suggests pest damage or fungal disease infection.";
      rec1 = "1. Spray appropriate organic or recommended chemical pesticides.";
      rec2 = "2. Prune and burn heavily infected leaves to halt disease spread.";
      rec3 = "3. Improve air circulation by proper spacing and weeding.";
    }

    const reportEn = `Observation: ${observation}\nInterpretation: ${interpretation}\nRecommended Actions:\n- ${rec1}\n- ${rec2}\n- ${rec3}`;
    const reportSw = `Uchunguzi: ${translate(observation)}\nTafsiri: ${translate(interpretation)}\nHatua Zinazopendekezwa:\n- ${translate(rec1)}\n- ${translate(rec2)}\n- ${translate(rec3)}`;

    return {
      isVerified: true,
      confidence: idResult.confidence,
      healthScore,
      detectedIssues: issues,
      reportEn,
      reportSw,
      identifiedSpecies: idResult.species
    };
  }
}

export const aiService = new AiService();
