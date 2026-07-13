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

import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { tokenService } from "../services/tokenService";
import { notificationsQueue } from "../jobs/queues";
import { env } from "../config/env";

export default async function webhooksRoutes(fastify: FastifyInstance) {
  fastify.post("/mpesa/callback", async (request, reply) => {
    return { success: true };
  });

  fastify.post("/africastalking/callback", async (request, reply) => {
    const body = (request.body || {}) as any;
    const { requestId, status, errorMessage } = body;

    fastify.log.info(`[AfricaTalking Callback] Received callback for request ${requestId}: status=${status}, error=${errorMessage}`);

    if (!requestId) {
      return reply.status(400).send({ success: false, error: "Missing requestId" });
    }

    try {
      // Find the redemption request matching the at_transaction_id (which is requestId)
      const res = await query(
        "SELECT id, user_id, tokens_spent, status FROM redemption_requests WHERE at_transaction_id = $1",
        [requestId]
      );

      if (res.rows.length === 0) {
        fastify.log.warn(`[AfricaTalking Callback] No redemption request found for transaction ID: ${requestId}`);
        return { success: true }; // Return 200 OK so AT doesn't keep retrying
      }

      const redemption = res.rows[0];

      // Reconcile status
      if (status === "Success" || status === "Sent") {
        if (redemption.status !== "completed") {
          await query(
            "UPDATE redemption_requests SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
            [redemption.id]
          );
          fastify.log.info(`[AfricaTalking Callback] Redemption ${redemption.id} marked as completed.`);
        }
      } else if (status === "Failed" || status === "Failure") {
        if (redemption.status !== "failed") {
          // Refund the spent tokens
          const { refundTokens } = await import("../services/tokenService");
          await refundTokens(redemption.user_id, redemption.tokens_spent, redemption.id);

          await query(
            "UPDATE redemption_requests SET status = 'failed', failure_reason = $1, completed_at = CURRENT_TIMESTAMP WHERE id = $2",
            [errorMessage || "Africa's Talking Callback status: Failed", redemption.id]
          );
          fastify.log.info(`[AfricaTalking Callback] Redemption ${redemption.id} marked as failed and tokens refunded.`);
        }
      }

      return { success: true };
    } catch (err: any) {
      fastify.log.error(`[AfricaTalking Callback] Error processing callback: ${err.message}`);
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}
