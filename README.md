# dira-api

**Dira — Backend API, AI Verification Engine, and Circular Economy Services**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-teal.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-4.x-black.svg)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791.svg)](https://www.postgresql.org/)
[![Hedera](https://img.shields.io/badge/Hedera-HCS%20%26%20HTS-green.svg)](https://hedera.com/)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

The Fastify REST API that powers the Dira platform. Handles all authentication, data ingestion, AI crop verification, atmospheric triangulation, the four-layer circular economy payment system, Telegram bot notifications, and the Hedera (HCS & HTS) blockchain anchoring services.

---

## What this repository contains

| Path | Purpose |
|---|---|
| `/src/routes/` | One file per feature module |
| `/src/services/` | Business logic — token, airtime, voucher, circle, payment, AI, triangulation, Hedera anchoring, notification |
| `/src/jobs/` | BullMQ job definitions and workers |
| `/src/db/` | PostgreSQL plugin, 15 migration files, migration runner |
| `/src/plugins/` | Fastify plugins — database, JWT auth, rate limiting |
| `/src/middleware/` | Global error handler, log sanitiser |
| `/src/config/env.ts` | Zod environment variable validation — server refuses to start if any required variable is missing |
| `/src/scripts/` | CLI tools — `create-admin.ts` |

---

## Tech stack

- **Framework:** Fastify 4 (TypeScript)
- **Database:** PostgreSQL 16 + PostGIS (geographic queries)
- **Cache / Queue:** Redis 7 + BullMQ
- **File storage:** Cloudflare R2 (pre-signed upload URLs — server never handles raw photo data)
- **AI — plant ID:** PlantNet API (free tier, no cost)
- **AI — weather ref:** Open-Meteo API (free, no key required)
- **AI — image analysis:** `sharp` (colour health scoring)
- **Payment Layer 1:** Africa's Talking (airtime — Day 1, no float required)
- **Payment Layer 2:** Farm input voucher QR codes (HMAC-SHA256 signed)
- **Payment Layer 3:** Dira Circle (county-level community cash pool — one bank transfer per county per month)
- **Payment Layer 4:** Pretium (mobile money B2C cash-out supporting all Kenyan & Ugandan telcos)
- **Blockchain:** Hedera (Consensus Service for provenance anchoring, Token Service for rewards mirroring)
- **Notifications:** Telegram Bot API
- **Deployment:** Coolify on Hetzner, Dockerised

---

## Quick start

### Prerequisites

- Node.js ≥ 20.x
- PostgreSQL 16 with PostGIS extension
- Redis 7

### Install

```bash
git clone https://github.com/dira-africa/dira-api.git
cd dira-api
npm install
cp .env.example .env
# Fill in your values — see .env.example for descriptions
```

### Run database migrations

```bash
npm run migrate
# Runs all 15 migrations in order.
# Idempotent — safe to run multiple times.
```

### Run locally

```bash
npm run dev
# API runs on http://localhost:3001
# Health check: http://localhost:3001/health
```

### Verify setup

```bash
# TypeScript — must pass with zero errors
npx tsc --noEmit

# Lint
npm run lint

# Tests
npm test

# Security audit — no critical or high vulnerabilities
npm audit
```

### Create an admin account

Admin accounts are created via CLI only — never via the API:

```bash
npx ts-node src/scripts/create-admin.ts
# Prompts for email and password (minimum 20 characters)
# Password is hashed with bcrypt cost factor 12
```

---

## Docker Deployment (Coolify)

The project includes a multi-stage **Dockerfile** optimized for containerized cloud deployment:
1. **builder stage**: Installs development dependencies and transpiles TypeScript to `/dist`.
2. **deps stage**: Installs only production node_modules.
3. **runner stage**: Packages the `/dist` build with production node_modules under a lightweight alpine base image.

---

## API overview

Full OpenAPI 3.0 specification lives in [`dira-docs`](https://github.com/dira-africa/dira-docs).

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Server health check |
| `POST` | `/auth/telegram` | None | Telegram Mini App authentication (HMAC-SHA256 verified) |
| `GET` | `/auth/me` | JWT | Current user profile |
| `POST` | `/farmers/profile` | JWT | Create/update farmer profile |
| `POST` | `/crop-submissions/upload-url` | JWT | Get pre-signed R2 upload URL |
| `POST` | `/crop-submissions` | JWT | Submit crop photo metadata |
| `GET` | `/farmers/submissions` | JWT | Paginated submission history |
| `POST` | `/agents/profile` | JWT | Create/update Data Agent profile |
| `POST` | `/atmospheric/submit` | JWT | Submit barometric reading (validated: 870–1084 hPa, Kenya bounds) |
| `GET` | `/tokens/balance` | JWT | Current token balance and KES equivalents |
| `GET` | `/tokens/history` | JWT | Paginated token transaction history |
| `POST` | `/tokens/redeem/airtime` | JWT | Redeem tokens for Africa's Talking airtime |
| `POST` | `/tokens/redeem/voucher` | JWT | Generate farm input voucher QR code |
| `POST` | `/tokens/redeem/circle` | JWT | Register for Dira Circle cash distribution |
| `POST` | `/tokens/redeem/pretium` | JWT | Pretium mobile money B2C redemption |
| `POST` | `/partner/voucher/scan` | Dealer token | Agro-dealer scans a farmer voucher QR |
| `GET` | `/public/stats` | None | Aggregated network statistics (Redis cached) |
| `GET` | `/public/coverage-map` | None | GeoJSON heatmap — no individual user data |
| `POST` | `/webhooks/pretium/result` | IP allowlist | Pretium B2C payment callback |

---

## Database schema

The database uses sequential migration files:

| Range | Tables / Features |
|---|---|
| 001–003 | Core platform authentication, role management (`users`, `user_roles`, `sessions`), Farmers (`farmers`, `farmer_profiles`, `crop_types`), and Data Agents (`data_agents`, `agent_certifications`) |
| 004–006 | Cooperatives & counties (`counties`, `cooperatives`), atmospheric consensus (`atmospheric_readings`, `atmospheric_triangulations`), crop photos and AI verification (`crop_photos`, `ai_analysis_results`) |
| 007–010 | Climate token ledger (`token_ledger`, `token_transfers`), redemptions & M-Pesa config (`payment_requests`, `redemption_requests`, `mpesa_activation_settings`), API clients, and audit logs |
| 011–012 | Hedera HCS anchoring layer (`hedera_anchors`, `batch_contents`, `hedera_certificates`) |
| 013–015 | Circular economy integrations (`voucher_redemptions`, `agro_dealer_reconciliations`, `circle_coordinators`, `dira_circle_distributions`, `county_cash_pools`, `agro_dealers`) |

All phone numbers are encrypted at rest using pgcrypto. The `token_ledger` table has a database-level `CHECK (balance_after >= 0)` constraint — negative balances cannot exist even if application code has a bug.

---

## Security architecture

| Layer | Implementation |
|---|---|
| Authentication | Telegram HMAC-SHA256 verified `initData` → JWT (7 days). All comparisons use `crypto.timingSafeEqual()`. |
| Authorisation | Fastify `authenticate` and `requireRole` decorators on all protected routes |
| Rate limiting | Per-endpoint: 10/min on auth, 4/day on atmospheric sync, 3/hour on redemptions |
| SQL injection | Parameterised queries throughout. Zero string concatenation in SQL. |
| File uploads | Pre-signed R2 URLs. Server never handles raw file data. Magic byte validation on scan. |
| Phone numbers | Encrypted at rest with pgcrypto `pgp_sym_encrypt`. Key in environment variable only. |
| Daraja callbacks | IP allowlist — only Safaricom's documented IP ranges are accepted |
| Voucher QR codes | HMAC-SHA256 signed with `VOUCHER_SIGNING_SECRET`. Timing-safe comparison on scan. One-time use enforced at database level. |
| Pretium gateway | Pretium API sandbox mode — verified at startup to ensure no production credentials are loaded in development |
| Logging | Fastify redacts `Authorization`, `phone_number`, `initData`, and any field named `token`, `secret`, or `key` |
| Secrets | Validated at startup by Zod — server refuses to start with any missing or malformed required variable |

---

## Environment variables

Key variables — see `.env.example` for the complete list:

| Variable | Default | Notes |
|---|---|---|
| `HEDERA_OPERATOR_ID` | — | Hedera Account ID for transaction submission |
| `HEDERA_OPERATOR_KEY` | — | Hedera Operator private key for HCS/HTS operations |
| `HEDERA_TOKEN_ID` | — | Hedera Token Service Climate Token ID |
| `HEDERA_TOPIC_ID` | — | Hedera Consensus Service Topic ID for telemetry anchoring |
| `PRETIUM_API_KEY` | — | Pretium API credential key |
| `PRETIUM_API_URL` | — | Pretium API sandbox or production endpoint URL |
| `VOUCHERS_ACTIVE` | `false` | Set `true` only when first agro-dealer MOU is signed |
| `DIRA_CIRCLE_ACTIVE` | `false` | Set `true` only when first county coordinator is confirmed |
| `VOUCHER_SIGNING_SECRET` | — | Minimum 32 characters. Server refuses to start if shorter. |
| `PGCRYPTO_SYMMETRIC_KEY` | — | Used to encrypt phone numbers at rest. Never stored in DB. |

---

## Contributing

We welcome contributions. Before you start, please read:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — environment setup, branch strategy, commit standards, PR process, code standards, security checklist, and testing requirements
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — how we treat each other in this community

PRs touching payment flows require two reviewer approvals. For security vulnerabilities, do **not** open a public issue. Email **security@diraafrica.org** instead.

---

## Community and support

| Channel | Purpose |
|---|---|
| [GitHub Issues](https://github.com/dira-africa/dira-api/issues) | Bug reports and feature requests |
| [GitHub Discussions](https://github.com/dira-africa/dira-api/discussions) | Architecture questions and ideas |
| community@diraafrica.org | General inquiries |
| security@diraafrica.org | Security vulnerabilities (private) |
| conduct@dira.africa | Code of Conduct reports (private) |

---

## Related repositories

* **[`dira-core`](https://github.com/dira-africa/dira-core)** — Telegram Mini App frontend. Next.js 14 App Router + @twa-dev/sdk. Onboarding, capture (with device barometer), reports, wallet/redeem, maps, dashboards, English/Swahili. Carries XION account abstraction to remove.
* **[`dira-api`](https://github.com/dira-africa/dira-api)** — the backend. Fastify + TypeScript, raw SQL migrations via pg, BullMQ + Redis, Zod env, pgcrypto PII. Services already cover AI verification, triangulation, tokens (internal ledger), airtime, Dira Circle, vouchers, B2B/partner, DPA and the public dashboard. Anchoring is zkVerify + XION and cash-out is Daraja M-Pesa — those are the parts we replace (Hedera for anchoring, Pretium for cash-out).
* **[`dira-docs`](https://github.com/dira-africa/dira-docs)** — docs & evidence room. Architecture, OpenAPI, reviewer guide. Currently XION/zkVerify-themed; rewritten to Hedera in P3.4.
* **`dira-contracts`** — DELETED. Held a CosmWasm/XION contract and a zkVerify circom circuit. Removed entirely in P0.2 (along with the Midnight .compact files inside dira-api) so there are no mix-ups.

---

## Licence

Apache 2.0 — see [LICENSE](LICENSE).

*Dira Africa Limited, 2026.*
