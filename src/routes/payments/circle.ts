/*
 * Copyright 2026 Blockchain & Climate Institute
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
import { diraCircleService } from "../../services/diraCircleService";

interface ContributeCircleBody {
  tokenAmount: number;
  countyId: string;
}

export default async function circleRoutes(fastify: FastifyInstance) {
  
  // POST /api/payments/circle/contribute
  fastify.post<{ Body: ContributeCircleBody }>(
    "/contribute",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      const { tokenAmount, countyId } = request.body;

      // 1. Validation
      if (tokenAmount === undefined || !countyId) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_FIELDS", message: "tokenAmount and countyId are required." }
        });
      }

      if (tokenAmount <= 0) {
        return reply.status(400).send({
          success: false,
          error: { code: "INVALID_AMOUNT", message: "Contribution token amount must be greater than 0." }
        });
      }

      try {
        const result = await diraCircleService.contributeToPool(userId, countyId, tokenAmount);

        return {
          success: true,
          message: `Successfully contributed ${tokenAmount} tokens to ${countyId} Circle community cash pool.`,
          kesValue: result.kesValue
        };
      } catch (err: any) {
        console.error("Circle contribution route error:", err);
        
        // Map common errors to appropriate statuses
        if (err.message.includes("No active Dira Circle coordinator")) {
          return reply.status(400).send({
            success: false,
            error: { code: "COORDINATOR_NOT_FOUND", message: err.message }
          });
        }
        
        if (err.message.includes("Insufficient token balance")) {
          return reply.status(400).send({
            success: false,
            error: { code: "INSUFFICIENT_BALANCE", message: "Insufficient token balance." }
          });
        }

        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to contribute to cash pool." }
        });
      }
    }
  );
}
