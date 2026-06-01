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
import { query } from "../db/query";
import { tokenService } from "../services/tokenService";

export default async function tokensRoutes(fastify: FastifyInstance) {
  // 1. GET /api/tokens/balance - Retrieve actual token balance
  fastify.get(
    "/balance",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const { balance } = await tokenService.getBalance(userId);
        return { success: true, balance };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve balance." }
        });
      }
    }
  );

  // 2. GET /api/tokens/history - Retrieve user's transaction ledger history
  fastify.get(
    "/history",
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const userId = request.user.id;
      try {
        const res = await query(
          `SELECT id, amount, balance_after, transaction_type, reference_id, notes, created_at 
           FROM token_ledger 
           WHERE user_id = $1 
           ORDER BY created_at DESC`,
          [userId]
        );
        return { success: true, transactions: res.rows };
      } catch (err: any) {
        return reply.status(500).send({
          success: false,
          error: { code: "SERVER_ERROR", message: err.message || "Failed to retrieve ledger history." }
        });
      }
    }
  );
}
