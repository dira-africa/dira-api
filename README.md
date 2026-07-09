<div align="center">

# dira-api

**The Dira Africa backend**

The Fastify REST API that verifies climate data, anchors it on Hedera, mints Climate Token rewards, and settles redemptions to mobile money, airtime, and vouchers.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-0A6E56.svg)](../LICENSE)
[![Fastify](https://img.shields.io/badge/Fastify-4-1A1A6E.svg)](https://fastify.dev)
[![Built on Hedera](https://img.shields.io/badge/Built_on-Hedera-0A6E56.svg)](https://hedera.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-1A1A6E.svg)](https://www.typescriptlang.org)

</div>

---

## Overview

`dira-api` is the backend for the [Dira Africa](https://github.com/dira-africa) platform — a decentralized climate-data verification network for African smallholder agriculture. It handles authentication, data ingestion, AI crop verification, atmospheric triangulation, Hedera anchoring, the Climate Token economy, the circular-economy redemption rails, and the B2B verification API used by insurance partners.

All blockchain activity runs here, server-side, under Dira-controlled Hedera accounts — a **custodial** model, so farmers using the [`dira-core`](https://github.com/dira-africa/dira-core) Mini App never handle keys.

## How it works

```
Submission → Verify (AI + triangulation) → Anchor (Hedera HCS) → Reward (Hedera HTS) → Redeem
```

- **Provenance:** each verified submission is hashed (SHA-256) and the hash is written to a **Hedera Consensus Service** topic. Only the hash is anchored — never raw farmer data.
- **Rewards:** the Climate Token is a **Hedera Token Service** token. An internal, atomic ledger (`token_transactions`) is the source of truth for balances; HTS mint (on earn) and burn (on redeem) mirror it on-chain.
- **Redemption:** Pretium (stablecoin → mobile money across Kenya and Uganda), Africa's Talking (airtime), agro-dealer QR vouchers, and the Dira Circle community pool.

## Features

- 🔐 JWT authentication with role-based access (farmers, agents, admins, partners)
- 🌾 Crop-submission pipeline with AI verification and atmospheric triangulation
- ⛓️ Hedera HCS provenance anchoring and HTS Climate Token mint/burn
- 💸 Multi-rail redemption (mobile money, airtime, vouchers, community pool)
- 🤝 B2B verification API for insurers to independently audit data provenance
- 🛡️ Kenya Data Protection Act (ODPC) compliance — consent and data-subject rights
- 📈 Public dashboard and Prometheus metrics

## Tech stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 20, TypeScript, Fastify 4 |
| Database | PostgreSQL 16 + PostGIS (raw SQL migrations via `pg`) |
| Jobs & cache | Redis + BullMQ |
| Validation | Zod (input and environment) |
| PII | Encrypted at rest with pgcrypto |
| Blockchain | Hedera SDK (`@hashgraph/sdk`) — HCS + HTS |
| Payments | Pretium (mobile money), Africa's Talking (airtime) |
| Media / AI | `sharp`, AI crop verification |

## Project structure

```
src/
  config/        Zod-validated environment (env.ts)
  db/            pg pool, query helper, and numbered SQL migrations
  routes/        auth, farmers, agents, cropSubmissions, atmospheric, tokens,
                 partner (B2B), payments/*, public, webhooks, admin
  services/      Business logic — AI verification, triangulation, token,
                 airtime, payment, voucher, Dira Circle, DPA, Hedera anchor
  jobs/          BullMQ queues and workers (verification, anchoring, indexing)
  scripts/       Operational scripts (create Hedera topic / token, admin)
```

## Getting started

### Prerequisites

- Node.js 20+ and npm
- PostgreSQL 16 with the PostGIS extension
- Redis
- A [Hedera testnet account](https://portal.hedera.com) (operator ID + key)
- Sandbox credentials for Pretium and Africa's Talking

### Install, migrate & run

```bash
npm install
cp .env.example .env        # then fill in the values below
npm run migrate             # applies SQL migrations (enables PostGIS)
npm run dev                 # start the API (tsx watch)
```

### Environment

Set the following in `.env` (never commit real values — only `.env.example` placeholders are tracked):

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `JWT_SECRET` | Auth signing secret (≥ 16 chars) |
| `PGCRYPTO_SYMMETRIC_KEY` | Key used to encrypt farmer PII at rest |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (initData verification) |
| `HEDERA_NETWORK` | `testnet` \| `mainnet` (defaults to `testnet`) |
| `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` | Hedera operator account |
| `DIRA_HCS_TOPIC_ID` | HCS provenance topic ID |
| `DIRA_HTS_TOKEN_ID` | HTS Climate Token ID |
| `PRETIUM_BASE_URL` / `PRETIUM_API_KEY` / `PRETIUM_WEBHOOK_SECRET` | Pretium mobile-money rail |
| `AFRICAS_TALKING_USERNAME` / `AFRICAS_TALKING_API_KEY` | Airtime rail |
| `VOUCHER_SIGNING_SECRET` | Signs redemption QR vouchers (≥ 32 chars) |

### Provision Hedera assets

After configuring a testnet operator, create the on-chain assets (idempotent):

```bash
npx tsx src/scripts/create-hedera-topic.ts    # → DIRA_HCS_TOPIC_ID
npx tsx src/scripts/create-hedera-token.ts    # → DIRA_HTS_TOKEN_ID
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled server |
| `npm run migrate` | Apply database migrations |

## Testing

The repository includes integration tests covering authentication, the crop pipeline, triangulation, redemptions, wallet concurrency, DPA compliance, and API security. Run them with `tsx` (see the `src/test_*.ts` suites).

## Deployment

Containerized (see `Dockerfile`) and deployed via Coolify on Hetzner, with PostgreSQL/PostGIS and Redis alongside. Payment webhooks (Pretium) and callbacks (Africa's Talking) require publicly reachable HTTPS endpoints.

## Security

- PII encrypted at rest (pgcrypto); no PII is ever written on-chain — only hashes.
- Webhook signatures verified; rate limiting via `@fastify/rate-limit`; `@fastify/helmet` headers.
- Real Hedera mainnet keys and production payment credentials are handled by operators only, never in test or CI environments.

## Contributing

Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Database migrations are **append-only** — never edit an existing migration.

## Project status

Active development, testnet-first: the anchoring and token layers are being migrated to Hedera (HCS + HTS), with Pretium as the unified mobile-money rail. See [`dira-docs`](https://github.com/dira-africa/dira-docs) for the current architecture.

## License

[Apache License 2.0](./LICENSE) © Dira Africa.
