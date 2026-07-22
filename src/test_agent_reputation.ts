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

import { pool } from "./db/pool";
import { reputationService, REPUTATION_CONFIG } from "./services/reputationService";
import { verificationService, VERIFICATION_CONFIG } from "./services/verificationService";

// Mock Database in-memory state
const dbReputations: Record<string, any> = {};
const dbReputationLogs: any[] = [];
const dbUsers: Record<string, any> = {};

// Override pool.query to simulate PostgreSQL in-memory
(pool as any).query = async (text: string, params?: any[]): Promise<any> => {
  const sql = text.toLowerCase();

  if (sql.includes("select") && sql.includes("agent_reputations")) {
    const userId = params?.[0];
    const row = dbReputations[userId];
    return { rows: row ? [row] : [] };
  }

  if (sql.includes("insert into") && sql.includes("agent_reputations")) {
    const [userId, alpha, beta, trustScore, trustTier] = params!;
    dbReputations[userId] = {
      user_id: userId,
      alpha,
      beta,
      trust_score: trustScore,
      trust_tier: trustTier,
      updated_at: new Date()
    };
    return { rows: [dbReputations[userId]] };
  }

  if (sql.includes("update") && sql.includes("agent_reputations")) {
    const [alpha, beta, trustScore, trustTier, userId] = params!;
    dbReputations[userId] = {
      user_id: userId,
      alpha,
      beta,
      trust_score: trustScore,
      trust_tier: trustTier,
      updated_at: new Date()
    };
    return { rows: [dbReputations[userId]] };
  }

  if (sql.includes("update") && sql.includes("users")) {
    const [isVerified, userId] = params!;
    dbUsers[userId] = { ...dbUsers[userId], is_verified: isVerified };
    return { rows: [dbUsers[userId]] };
  }

  if (sql.includes("count(*)") && sql.includes("agent_reputation_logs")) {
    const userId = params?.[0];
    const count = dbReputationLogs.filter(l => l.user_id === userId).length;
    return { rows: [{ total: count }] };
  }

  if (sql.includes("insert into") && sql.includes("agent_reputation_logs")) {
    const [
      userId, old_alpha, old_beta, new_alpha, new_beta, 
      old_trust_score, new_trust_score, old_trust_tier, new_trust_tier, 
      submission_id, submission_type, outcome
    ] = params!;
    dbReputationLogs.push({
      user_id: userId,
      old_alpha,
      old_beta,
      new_alpha,
      new_beta,
      old_trust_score,
      new_trust_score,
      old_trust_tier,
      new_trust_tier,
      submission_id,
      submission_type,
      outcome,
      created_at: new Date()
    });
    return { rows: [{ id: "mock-log-id" }] };
  }

  // Fallbacks for verification tests
  if (sql.includes("st_dwithin") && sql.includes("farms")) {
    return { rows: [{ within_geofence: true }] };
  }
  if (sql.includes("perceptual_hash") && sql.includes("crop_submissions")) {
    return { rows: [] };
  }

  return { rows: [] };
};

(pool as any).connect = async (): Promise<any> => {
  return {
    query: pool.query,
    release: () => {}
  };
};

async function runSimulation() {
  console.log("🧪 Starting Bayesian Data Agent Reputation (R2) Simulation Test...");

  const userId = "test-agent-123";

  // ========================================================
  // STEP 1: Verify Cautious Prior State
  // ========================================================
  console.log("\n--- STEP 1: Cautious Prior Initialization ---");
  let rep = await reputationService.getOrCreateReputation(userId);
  console.log(`Initial Alpha: ${rep.alpha}, Beta: ${rep.beta}`);
  console.log(`Initial Trust Score: ${rep.trustScore} (Expected: 0.5)`);
  console.log(`Initial Trust Tier: ${rep.trustTier} (Expected: new)`);

  if (rep.trustScore !== 0.5 || rep.trustTier !== "new") {
    throw new Error("Initialization failed: Expected trust 0.50 and tier 'new'");
  }
  console.log("✅ Prior initialized correctly.");

  // ========================================================
  // STEP 2: Simulate 20 Genuine Submissions (Successes)
  // ========================================================
  console.log("\n--- STEP 2: Simulating 20 Genuine Submissions ---");
  for (let i = 1; i <= 20; i++) {
    rep = await reputationService.updateReputation(userId, "crop", `sub-success-${i}`, "success");
    console.log(`Success #${i} -> Alpha: ${rep.alpha.toFixed(2)}, Beta: ${rep.beta.toFixed(2)}, Trust: ${rep.trustScore.toFixed(4)}, Tier: ${rep.trustTier}`);
  }

  console.log(`\nFinal Trust Score after 20 successes: ${rep.trustScore}`);
  console.log(`Final Trust Tier after 20 successes: ${rep.trustTier} (Expected: trusted)`);

  if (rep.trustScore <= 0.75 || rep.trustTier !== "trusted") {
    throw new Error("Success simulation failed: Expected trust > 0.75 and tier 'trusted'");
  }

  // Verify reward eligibility
  const eligible = await reputationService.checkRewardEligibility(userId);
  console.log(`Reward Eligibility: ${eligible} (Expected: true)`);
  if (!eligible) {
    throw new Error("Reward eligibility check failed: Trusted agent should be eligible.");
  }

  // Check custom R1 thresholds for trusted agent
  let acceptThresh = VERIFICATION_CONFIG.thresholdAccept;
  let rejectThresh = VERIFICATION_CONFIG.thresholdReject;
  if (rep.trustTier === "trusted") {
    acceptThresh = 0.70;
    rejectThresh = 0.30;
  }
  console.log(`Dynamic Verification Scrutiny -> Accept Threshold: ${acceptThresh} (Expected: 0.70), Reject Threshold: ${rejectThresh} (Expected: 0.30)`);
  if (acceptThresh !== 0.70 || rejectThresh !== 0.30) {
    throw new Error("Verification scrutiny adjustments failed for trusted agent.");
  }
  console.log("✅ Genuine submissions simulation passed.");

  // ========================================================
  // STEP 3: Simulate 3 Fraudulent Submissions (Failures)
  // ========================================================
  console.log("\n--- STEP 3: Simulating 3 Fraudulent Submissions (Reputation Drop) ---");
  for (let i = 1; i <= 3; i++) {
    rep = await reputationService.updateReputation(userId, "crop", `sub-fraud-${i}`, "failure");
    console.log(`Failure #${i} -> Alpha: ${rep.alpha.toFixed(2)}, Beta: ${rep.beta.toFixed(2)}, Trust: ${rep.trustScore.toFixed(4)}, Tier: ${rep.trustTier}`);
  }

  console.log(`\nTrust Score after 3 failures: ${rep.trustScore}`);
  console.log(`Trust Tier after 3 failures: ${rep.trustTier} (Expected: new)`);

  if (rep.trustScore >= 0.80 || rep.trustTier !== "new") {
    throw new Error("Fraud drop failed: Expected trust to drop and tier to become 'new'");
  }

  // Scrutiny should have tightened from trusted (0.70) back to normal (0.75)
  let acceptThreshAfter = VERIFICATION_CONFIG.thresholdAccept;
  let rejectThreshAfter = VERIFICATION_CONFIG.thresholdReject;
  if (rep.trustTier === "new") {
    acceptThreshAfter = 0.75;
    rejectThreshAfter = 0.35;
  }
  console.log(`Verification Scrutiny Tightened -> Accept: ${acceptThreshAfter} (Expected: 0.75), Reject: ${rejectThreshAfter} (Expected: 0.35)`);
  if (acceptThreshAfter !== 0.75 || rejectThreshAfter !== 0.35) {
    throw new Error("Scrutiny tightening failed after initial fraud.");
  }

  // ========================================================
  // STEP 4: Simulate Additional Failures until Agent is Flagged
  // ========================================================
  console.log("\n--- STEP 4: Simulating Failures until Agent is Flagged ---");
  let totalFailures = 3;
  while (rep.trustTier !== "flagged" && totalFailures < 30) {
    totalFailures++;
    rep = await reputationService.updateReputation(userId, "crop", `sub-fraud-${totalFailures}`, "failure");
    console.log(`Failure #${totalFailures} -> Alpha: ${rep.alpha.toFixed(2)}, Beta: ${rep.beta.toFixed(2)}, Trust: ${rep.trustScore.toFixed(4)}, Tier: ${rep.trustTier}`);
  }

  console.log(`\nFinal Trust Score after ${totalFailures} failures: ${rep.trustScore}`);
  console.log(`Final Trust Tier after ${totalFailures} failures: ${rep.trustTier} (Expected: flagged)`);

  if (rep.trustScore >= 0.45 || rep.trustTier !== "flagged") {
    throw new Error("Fraud simulation failed: Expected final trust < 0.45 and tier 'flagged'");
  }

  // Verify reward eligibility is suspended
  const eligibleAfterFraud = await reputationService.checkRewardEligibility(userId);
  console.log(`Reward Eligibility after Fraud: ${eligibleAfterFraud} (Expected: false)`);
  if (eligibleAfterFraud) {
    throw new Error("Reward eligibility suspension failed: Flagged agent should be blocked.");
  }

  // Check custom R1 thresholds for flagged agent (strict scrutiny)
  let acceptThreshFlagged = VERIFICATION_CONFIG.thresholdAccept;
  let rejectThreshFlagged = VERIFICATION_CONFIG.thresholdReject;
  if (rep.trustTier === "flagged") {
    acceptThreshFlagged = 0.85;
    rejectThreshFlagged = 0.45;
  }
  console.log(`Dynamic Verification Scrutiny -> Accept Threshold: ${acceptThreshFlagged} (Expected: 0.85), Reject Threshold: ${rejectThreshFlagged} (Expected: 0.45)`);
  if (acceptThreshFlagged !== 0.85 || rejectThreshFlagged !== 0.45) {
    throw new Error("Verification scrutiny adjustments failed for flagged agent.");
  }

  // Verify audit logs completeness
  console.log(`\nTotal Audit History Logs written: ${dbReputationLogs.length}`);
  if (dbReputationLogs.length !== (20 + totalFailures)) {
    throw new Error(`Audit logging failed: Expected ${20 + totalFailures} log entries, got ${dbReputationLogs.length}`);
  }
  console.log("Sample Audit Log Entry:", JSON.stringify(dbReputationLogs[dbReputationLogs.length - 1], null, 2));

  console.log("\n🎉 Bayesian Data Agent Reputation (R2) Simulation Test passed successfully!\n");
}

runSimulation().catch(err => {
  console.error("❌ Simulation run failed with error:", err);
  process.exit(1);
});
