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

import { env } from "../config/env";
import { createHash, randomUUID } from "crypto";
import { query } from "../db/query";
import { tokenService, deductTokens } from "./tokenService";
import { redis } from "../db/redis";

export class PaymentService {
  /**
   * Triggers a B2C disbursement to the recipient phone number (Stub)
   */
  async triggerMpesaB2C(
    phoneNumber: string,
    amountKes: number
  ): Promise<{
    success: boolean;
    conversationId?: string;
    errorMessage?: string;
  }> {
    throw new Error("Mobile money cashout via Pretium is pending integration.");
  }

  /**
   * Initiates the B2C cashout process (Stub)
   */
  async initiateMpesaB2C(
    userId: string,
    tokenAmount: number,
    phoneNumber: string
  ): Promise<{
    success: boolean;
    message: string;
    amountKes: number;
    conversationId: string;
    redemptionId: string;
  }> {
    throw new Error("MPESA_NOT_YET_ACTIVE");
  }
}

export const paymentService = new PaymentService();
