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

export interface AgentReputation {
  userId: string;
  alpha: number;
  beta: number;
  trustScore: number;
  trustTier: "new" | "trusted" | "flagged";
  updatedAt: Date;
}

export const REPUTATION_CONFIG = {
  // Cautious Prior
  alphaPrior: 2.0,
  betaPrior: 2.0,

  // Exponential Time-Decay Parameter
  lambda: 0.95, // 5% decay per submission outcome

  // Tier Thresholds
  flaggedThreshold: 0.45,
  trustedThreshold: 0.75,
  minSubmissionsForTrusted: 5
};

export class ReputationService {
  /**
   * Fetches the reputation record for a user, creating it with the cautious prior if missing.
   */
  async getOrCreateReputation(userId: string): Promise<AgentReputation> {
    try {
      const res = await query(
        `SELECT user_id, alpha, beta, trust_score, trust_tier, updated_at 
         FROM agent_reputations 
         WHERE user_id = $1`,
        [userId]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          userId: row.user_id,
          alpha: Number(row.alpha),
          beta: Number(row.beta),
          trustScore: Number(row.trust_score),
          trustTier: row.trust_tier,
          updatedAt: row.updated_at
        };
      }

      // Initialize with cautious prior
      const defaultTrust = REPUTATION_CONFIG.alphaPrior / (REPUTATION_CONFIG.alphaPrior + REPUTATION_CONFIG.betaPrior);
      
      await query(
        `INSERT INTO agent_reputations (user_id, alpha, beta, trust_score, trust_tier)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, REPUTATION_CONFIG.alphaPrior, REPUTATION_CONFIG.betaPrior, defaultTrust, "new"]
      );

      return {
        userId,
        alpha: REPUTATION_CONFIG.alphaPrior,
        beta: REPUTATION_CONFIG.betaPrior,
        trustScore: defaultTrust,
        trustTier: "new",
        updatedAt: new Date()
      };
    } catch (err) {
      console.error(`Failed to get/create reputation for user ${userId}:`, err);
      // Fallback
      return {
        userId,
        alpha: REPUTATION_CONFIG.alphaPrior,
        beta: REPUTATION_CONFIG.betaPrior,
        trustScore: 0.50,
        trustTier: "new",
        updatedAt: new Date()
      };
    }
  }

  /**
   * Updates an agent's reputation posterior based on a verification success/failure.
   */
  async updateReputation(
    userId: string,
    submissionType: "crop" | "atmospheric",
    submissionId: string,
    outcome: "success" | "failure"
  ): Promise<AgentReputation> {
    const current = await this.getOrCreateReputation(userId);

    // Apply gentle time-decay to past successes and failures
    const decayedAlpha = REPUTATION_CONFIG.lambda * (current.alpha - REPUTATION_CONFIG.alphaPrior) + REPUTATION_CONFIG.alphaPrior;
    const decayedBeta = REPUTATION_CONFIG.lambda * (current.beta - REPUTATION_CONFIG.betaPrior) + REPUTATION_CONFIG.betaPrior;

    // Add new outcome
    const newAlpha = decayedAlpha + (outcome === "success" ? 1.0 : 0.0);
    const newBeta = decayedBeta + (outcome === "failure" ? 1.0 : 0.0);

    // Compute derived trust score
    const newTrustScore = Number((newAlpha / (newAlpha + newBeta)).toFixed(4));

    // Get total historical outcomes for tier transition checks
    const countRes = await query(
      "SELECT COUNT(*) AS total FROM agent_reputation_logs WHERE user_id = $1",
      [userId]
    );
    const totalSubmissions = Number(countRes.rows[0].total) + 1;

    // Determine derived trust tier
    let newTrustTier: "new" | "trusted" | "flagged" = "new";
    if (newTrustScore < REPUTATION_CONFIG.flaggedThreshold) {
      newTrustTier = "flagged";
    } else if (newTrustScore >= REPUTATION_CONFIG.trustedThreshold && totalSubmissions >= REPUTATION_CONFIG.minSubmissionsForTrusted) {
      newTrustTier = "trusted";
    }

    // Save update to reputation table
    await query(
      `UPDATE agent_reputations
       SET alpha = $1,
           beta = $2,
           trust_score = $3,
           trust_tier = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $5`,
      [newAlpha, newBeta, newTrustScore, newTrustTier, userId]
    );

    // Update verified flag in users table for backward-compatible system trust
    await query(
      `UPDATE users
       SET is_verified = $1
       WHERE id = $2`,
      [newTrustTier === "trusted", userId]
    );

    // Log update in audit history logs
    await query(
      `INSERT INTO agent_reputation_logs (
         user_id, old_alpha, old_beta, new_alpha, new_beta, 
         old_trust_score, new_trust_score, old_trust_tier, new_trust_tier, 
         submission_id, submission_type, outcome
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId,
        current.alpha,
        current.beta,
        newAlpha,
        newBeta,
        current.trustScore,
        newTrustScore,
        current.trustTier,
        newTrustTier,
        submissionId,
        submissionType,
        outcome
      ]
    );

    return {
      userId,
      alpha: newAlpha,
      beta: newBeta,
      trustScore: newTrustScore,
      trustTier: newTrustTier,
      updatedAt: new Date()
    };
  }

  /**
   * Retrieves the trust score for use as the prior odds in Bayesian engine R1.
   */
  async getTrustPrior(userId: string): Promise<number> {
    const rep = await this.getOrCreateReputation(userId);
    return rep.trustScore;
  }

  /**
   * Checks if an agent is eligible to receive rewards (any tier except 'flagged').
   */
  async checkRewardEligibility(userId: string): Promise<boolean> {
    const rep = await this.getOrCreateReputation(userId);
    return rep.trustTier !== "flagged";
  }
}

export const reputationService = new ReputationService();
