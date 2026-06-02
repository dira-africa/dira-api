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
import { notificationsQueue } from "../jobs/queues";
import { env } from "../config/env";

const SAFARICOM_IPS = [
  "196.201.214.200", "196.201.214.206", "196.201.214.207", "196.201.214.208",
  "196.201.213.114", "196.201.213.44", "196.201.212.127", "196.201.212.138",
  "196.201.212.129", "196.201.212.136", "196.201.212.74", "196.201.212.69",
  "127.0.0.1", "::1"
];

export default async function webhooksRoutes(fastify: FastifyInstance) {
  fastify.post("/mpesa/callback", async (request, reply) => {
    return { success: true };
  });

  fastify.post("/africastalking/callback", async (request, reply) => {
    return { success: true };
  });

  // POST /api/webhooks/daraja/result
  fastify.post(
    "/daraja/result",
    async (request, reply) => {
      // 1. IP Whitelist check
      const clientIp = request.ip;
      if (!SAFARICOM_IPS.includes(clientIp)) {
        return reply.status(401).send({ error: "Unauthorized IP source" });
      }

      const body = request.body as any;
      if (!body || !body.Result) {
        return reply.status(400).send({ error: "Invalid callback payload" });
      }

      const { ConversationID, ResultCode, ResultDesc, ResultParameters } = body.Result;

      // Find the request by ConversationID
      const reqRes = await query(
        `SELECT id, user_id, tokens_spent, status FROM redemption_requests 
         WHERE at_transaction_id = $1`,
        [ConversationID]
      );

      if (reqRes.rows.length === 0) {
        return { success: true, message: "Request not found" };
      }

      const redemption = reqRes.rows[0];

      // If already processed, acknowledge and return
      if (redemption.status !== "processing" && redemption.status !== "pending") {
        return { success: true, message: "Already processed" };
      }

      const userRes = await query("SELECT telegram_id, full_name FROM users WHERE id = $1", [redemption.user_id]);
      const telegramId = userRes.rows[0]?.telegram_id;
      const fullName = userRes.rows[0]?.full_name || "User";

      if (ResultCode === 0) {
        // Payment Success!
        const resultParams = ResultParameters?.ResultParameter || [];
        const receiptParam = resultParams.find((p: any) => p.Key === "TransactionReceipt");
        const mpesaReceipt = receiptParam?.Value || body.Result.TransactionID || "SUCCESS";

        await query(
          `UPDATE redemption_requests 
           SET status = 'completed', 
               mpesa_receipt = $1, 
               completed_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [mpesaReceipt, redemption.id]
        );

        if (telegramId) {
          try {
            await notificationsQueue.add("send-telegram", {
              telegramId: String(telegramId),
              message: `Habari ${fullName}! Your M-Pesa cashout of KES ${(redemption.tokens_spent * 0.50).toFixed(2)} has been completed successfully. Receipt: ${mpesaReceipt}.`
            });
          } catch (e) {
            console.error("Failed to queue success notification:", e);
          }
        }
      } else {
        // Payment Failure!
        await query(
          `UPDATE redemption_requests 
           SET status = 'failed', 
               failure_reason = $1, 
               completed_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [ResultDesc || "Daraja transaction failed", redemption.id]
        );

        // Refund tokens
        await tokenService.creditTokens(
          redemption.user_id,
          Number(redemption.tokens_spent),
          "adjustment",
          redemption.id,
          `M-Pesa refund: ${ResultDesc || "Daraja transaction failed"}`
        );

        if (telegramId) {
          try {
            await notificationsQueue.add("send-telegram", {
              telegramId: String(telegramId),
              message: `Habari ${fullName}. Your M-Pesa cashout request has failed: ${ResultDesc || "Transaction declined"}. Your ${redemption.tokens_spent} tokens have been refunded to your wallet.`
            });
          } catch (e) {
            console.error("Failed to queue failure notification:", e);
          }
        }
      }

      return { success: true };
    }
  );

  // POST /api/webhooks/daraja/timeout
  fastify.post(
    "/daraja/timeout",
    async (request, reply) => {
      // 1. IP Whitelist check
      const clientIp = request.ip;
      if (!SAFARICOM_IPS.includes(clientIp)) {
        return reply.status(401).send({ error: "Unauthorized IP source" });
      }

      const body = request.body as any;
      if (!body || !body.Result) {
        return reply.status(400).send({ error: "Invalid callback payload" });
      }

      const { ConversationID } = body.Result;

      const reqRes = await query(
        `SELECT id, user_id, tokens_spent, status FROM redemption_requests 
         WHERE at_transaction_id = $1`,
        [ConversationID]
      );

      if (reqRes.rows.length === 0) {
        return { success: true, message: "Request not found" };
      }

      const redemption = reqRes.rows[0];

      if (redemption.status !== "processing" && redemption.status !== "pending") {
        return { success: true, message: "Already processed" };
      }

      const userRes = await query("SELECT telegram_id, full_name FROM users WHERE id = $1", [redemption.user_id]);
      const telegramId = userRes.rows[0]?.telegram_id;
      const fullName = userRes.rows[0]?.full_name || "User";

      // Mark request as failed due to timeout
      await query(
        `UPDATE redemption_requests 
         SET status = 'failed', 
             failure_reason = 'Daraja timeout', 
             completed_at = CURRENT_TIMESTAMP 
         WHERE id = $1`,
        [redemption.id]
      );

      // Refund tokens
      await tokenService.creditTokens(
        redemption.user_id,
        Number(redemption.tokens_spent),
        "adjustment",
        redemption.id,
        "M-Pesa refund: Daraja timeout"
      );

      if (telegramId) {
        try {
          await notificationsQueue.add("send-telegram", {
            telegramId: String(telegramId),
            message: `Habari ${fullName}. Your M-Pesa cashout request has timed out. Please try again. Your ${redemption.tokens_spent} tokens have been refunded to your wallet.`
          });
        } catch (e) {
          console.error("Failed to queue timeout notification:", e);
        }
      }

      return { success: true };
    }
  );
}
