# AGENTS.md — dira-api

> Read this before doing anything in this repo. It tells you what this service is,
> how it is built, and the rules you must follow. Pair it with `GUARDRAILS.md`.

## What this repo is
`dira-api` is the **backend** for Dira Africa — a DePIN climate-data verification
network for African smallholder farmers. Data Agents capture weather/crop
observations in a Telegram Mini App (`dira-core`); this API verifies them, anchors
a tamper-proof record on **Hedera**, rewards contributors in **Climate Tokens**,
and settles redemptions to mobile money, airtime, community pools and vouchers.

## Target architecture (Hedera-native)
**Telegram frontend → this API → Hedera (HCS + HTS) → Pretium / Africa's Talking / vouchers.**

- **Provenance:** each verified submission is hashed (SHA-256) and the hash is
  submitted to a **Hedera Consensus Service (HCS)** topic. Only the hash goes
  on-chain — never raw farmer data.
- **Rewards:** the Climate Token is a **Hedera Token Service (HTS)** token. The
  internal `token_transactions` ledger remains the source of truth for balances;
  HTS mint (on earn) and burn (on redeem) mirror it on-chain. Custodial model —
  farmers never hold keys or on-chain accounts.
- **Redemption:** Africa's Talking (airtime), Pretium (stablecoin → M-Pesa cash),
  Dira Circle (community pool), agro-dealer QR vouchers.

## Migration in progress — remove, do not extend
This repo is being migrated OFF XION + zkVerify + Midnight. When you touch related
code, replace it with the Hedera equivalent; do not build on the old rails:
- Replace `src/services/anchorService.ts` (zkVerify / `zkverifyjs`) and
  `src/services/xionService.ts` + `src/jobs/xionAnchorJob.ts` with a Hedera anchor
  service + job.
- Remove `contracts/DiraDataAnchor.compact` and `contracts/DiraDataCertificate.compact`.
- Remove `zkverifyjs` and any XION deps from `package.json`.
- In `src/config/env.ts`, remove `XION_*` and `ZKVERIFY_*`; add `HEDERA_*` and
  `PRETIUM_*`.

## Stack & conventions
- **Runtime:** Node.js + TypeScript (strict), Fastify 4. Dev: `npm run dev` (tsx).
- **DB:** PostgreSQL 16 + PostGIS, accessed through the `pg` pool in
  `src/db/pool.ts` via `query()` in `src/db/query.ts`. **Do not add an ORM.**
- **Migrations:** plain SQL files in `src/db/migrations/NNN_name.sql`, applied by
  `src/db/migrate.ts` (`npm run migrate`). **Append only** — never edit or
  renumber an existing migration. The runner is PostGIS-aware with a local mock
  fallback; keep new migrations compatible with both.
- **Jobs:** BullMQ + ioredis in `src/jobs/*` (`queues.ts`, `workers.ts`).
- **Validation:** Zod for all external input and for env (`src/config/env.ts`).
- **PII:** encrypted at rest with pgcrypto using `PGCRYPTO_SYMMETRIC_KEY`.
- **Auth:** `@fastify/jwt`; see `src/plugins/auth.ts`.
- **Licensing:** every source file starts with the Apache-2.0 header already used
  across the repo — preserve it.

## Where things live
- `src/routes/*` — HTTP routes (auth, farmers, agents, cropSubmissions,
  atmospheric, tokens, partner (B2B), payments/*, public, webhooks).
- `src/services/*` — business logic (aiService, triangulationService,
  tokenService, airtimeService, paymentService, voucherService, diraCircleService,
  dpaService, notificationService, anchorService → to be replaced by Hedera).
- `src/scripts/*` — one-off scripts (e.g. `create-admin.ts`). **New Hedera
  provisioning scripts (create topic / create token) go here.**
- `src/db/migrations/*` — schema.

## Verification already exists — reuse it
`aiService.ts` (photo/species + health) and `triangulationService.ts` (weather
cross-check) already produce a verification result. Do **not** rebuild them or add
new vision/weather providers. The Hedera work only consumes their PASS/FAIL output
and anchors it.

## How to work here
1. Produce a PLAN artifact and wait for human approval before changing code.
2. Stay inside this repo. Never edit `dira-core` or `dira-docs` from here.
3. Testnet + sandbox only (see GUARDRAILS.md). Never touch mainnet keys or real
   payment credentials.
