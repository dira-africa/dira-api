# dira-api

**Backend API — Dira Climate Verification Infrastructure**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Built with Fastify](https://img.shields.io/badge/Built_with-Fastify_4-black)](https://fastify.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://typescriptlang.org)
[![Midnight Mainnet](https://img.shields.io/badge/Midnight-Mainnet-1A1A6E)](https://midnight.network)

> *Your data earns your airtime. Your data grows your crops. Your data builds your safety net.*

---

## What Is Dira?

Dira is a Decentralised Physical Infrastructure Network (DePIN) that turns the existing smartphone network into the most granular agricultural weather sensing layer in Sub-Saharan Africa. Every verified data point is anchored as a zero-knowledge proof on the [Midnight blockchain](https://midnight.network). Contributors are rewarded through a four-layer circular economy — airtime, farm inputs, community cash pools, and M-Pesa — that generates real value from Day 1 without requiring Daraja production credentials or an M-Pesa float.

---

## This Repository

`dira-api` is the **Fastify 4 backend API**. It handles authentication, data ingestion, AI verification, the Climate Token ledger, all four circular economy payment layers, and the Midnight batch anchor pipeline.

**Tech stack:**
- Fastify 4 (TypeScript)
- PostgreSQL 16 + PostGIS (geographic data)
- Redis 7 (job queues, caching)
- BullMQ (async AI verification jobs)
- Sharp (crop photo colour analysis)
- PlantNet API (plant species identification)
- Open-Meteo (free atmospheric reference data)
- Africa's Talking (airtime disbursement — Day 1)
- Safaricom Daraja B2C (M-Pesa — Month 3–4)
- Midnight SDK (ZK batch anchoring — Month 4–5)

---

## Repository Structure

```
dira-api/
├── src/
│   ├── routes/              # One file per feature module
│   │   ├── auth.ts          # Telegram initData verification, JWT issuance
│   │   ├── farmers.ts       # Crop photo submission, health reports
│   │   ├── agents.ts        # Atmospheric sync, coverage, leaderboard
│   │   ├── tokens.ts        # Token balance, history, redemption routing
│   │   ├── payments/
│   │   │   ├── airtime.ts   # Africa's Talking airtime (Day 1)
│   │   │   ├── vouchers.ts  # Farm input QR vouchers (Month 1)
│   │   │   ├── circle.ts    # Dira Circle cash pools (Month 2)
│   │   │   └── mpesa.ts     # Daraja B2C (Month 3–4, flag-gated)
│   │   ├── admin.ts         # Internal admin dashboard routes
│   │   └── public.ts        # Unauthenticated dashboard data endpoints
│   ├── services/
│   │   ├── tokenService.ts          # Atomic ledger operations
│   │   ├── airtimeService.ts        # Africa's Talking integration
│   │   ├── voucherService.ts        # HMAC-SHA256 QR voucher generation
│   │   ├── diraCircleService.ts     # County cash pool aggregation
│   │   ├── paymentService.ts        # Daraja B2C (flag-gated)
│   │   ├── aiService.ts             # Crop photo verification pipeline
│   │   ├── triangulationService.ts  # Atmospheric Open-Meteo cross-check
│   │   └── midnightService.ts       # ZK batch anchor pipeline
│   ├── jobs/
│   │   ├── queues.ts                # BullMQ queue definitions
│   │   ├── photoVerificationJob.ts  # Async crop photo AI pipeline
│   │   ├── atmosphericJob.ts        # Async barometric triangulation
│   │   ├── midnightAnchorJob.ts     # Weekly Midnight batch commit
│   │   └── notificationJob.ts       # Telegram message delivery
│   ├── db/
│   │   ├── migrations/              # 15 SQL migration files
│   │   └── migrate.ts               # Migration runner
│   ├── plugins/
│   │   ├── database.ts              # PostgreSQL connection pool plugin
│   │   ├── auth.ts                  # JWT authenticate decorator
│   │   └── redis.ts                 # Redis connection plugin
│   ├── middleware/
│   │   ├── errorHandler.ts          # Global error normalisation
│   │   └── logSanitiser.ts          # Strips sensitive fields from logs
│   └── config/
│       └── env.ts                   # Zod schema — server refuses to start with missing vars
├── Dockerfile
└── .env.example
```

---

## API Overview

Full OpenAPI specification lives in [dira-docs](https://github.com/dira-africa/dira-docs). Key endpoints:

### Authentication
```
POST /auth/telegram      Verify Telegram initData (HMAC-SHA256), issue JWT
GET  /auth/me            Return current authenticated user profile
```

### Farmer Module
```
POST /crop-submissions/upload-url   Generate pre-signed R2 upload URL
POST /crop-submissions              Submit photo metadata, dispatch AI job
GET  /crop-submissions              Paginated submission history
GET  /crop-submissions/:id          Single submission with full AI report
```

### Agent Module
```
POST /atmospheric/submit            Submit barometric reading, dispatch triangulation job
GET  /atmospheric/sync-history      Today's syncs and streak count
GET  /agents/leaderboard            Weekly county leaderboard (anonymised)
GET  /public/coverage-map           GeoJSON heatmap (no personal data)
```

### Circular Economy — Token Redemption
```
GET  /tokens/balance                Current balance and KES equivalent
GET  /tokens/history                Paginated earning and spending history
POST /tokens/redeem/airtime         Africa's Talking airtime (Day 1, always active)
POST /tokens/redeem/voucher         Farm input QR code generation (Month 1)
POST /tokens/redeem/circle          Dira Circle cash pool request (Month 2)
POST /tokens/redeem/mpesa           Daraja B2C payout (Month 3–4, flag-gated)
POST /webhooks/daraja/result        Safaricom B2C result callback
POST /webhooks/daraja/timeout       Safaricom B2C timeout callback
POST /partner/voucher/scan          Agro-dealer QR scan endpoint
```

### Public Dashboard
```
GET  /public/stats                  Network statistics (Redis-cached, 60s)
GET  /public/coverage-map           Data density GeoJSON (cached, 5min)
GET  /public/activity-feed          Anonymised recent events (cached, 30s)
GET  /public/quality-metrics        AI verification confidence rates (cached, 1h)
```

---

## The Circular Economy Payment Architecture

Four independent payment layers. Each layer requires progressively more financial infrastructure. Each layer's failure is isolated — AT downtime does not affect vouchers; voucher reconciliation issues do not affect Dira Circle.

```
DARAJA_PRODUCTION_ACTIVE=false  →  M-Pesa B2C routes return 503 (expected behaviour)
VOUCHERS_ACTIVE=false           →  Voucher routes return 503 (expected behaviour)
DIRA_CIRCLE_ACTIVE=false        →  Circle routes return 503 (expected behaviour)
AT_API_KEY set                  →  Airtime routes always active (Day 1)
```

The `DARAJA_PRODUCTION_ACTIVE` flag must only be set to `true` when **both** conditions are confirmed:
1. Daraja production credentials approved by Safaricom in writing
2. First B2B API revenue received (provides the M-Pesa float)

---

## Database Migrations

Run migrations before starting the server:

```bash
npm run migrate
```

Migrations are idempotent — safe to run multiple times. The migration runner tracks completed migrations in a `migrations` table and only runs new files.

**15 migrations total:**
- `001–010`: Core platform (users, farmers, agents, atmospheric, crop photos, tokens, payments, API clients, audit, midnight)
- `011–012`: Midnight anchor and certificate tables
- `013`: Voucher redemptions and agro-dealer reconciliation (circular economy)
- `014`: Dira Circle distributions and county coordinators (circular economy)
- `015`: Agro-dealer management and MOU records (circular economy)

---

## Local Development

### Prerequisites

```bash
node --version   # 20 LTS required
docker --version # For PostgreSQL + Redis containers
```

### Setup

```bash
git clone https://github.com/dira-africa/dira-api.git
cd dira-api

# Start PostgreSQL + Redis via Docker
docker compose up -d

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Fill in your values — especially AT_API_KEY and AT_USERNAME for airtime testing

# Run migrations
npm run migrate

# Start development server
npm run dev
```

API runs at `http://localhost:3001`. Health check: `http://localhost:3001/health`

### Environment Variables

The server uses Zod to validate all environment variables at startup. Missing or malformed variables cause the server to refuse to start with a clear error message.

See `.env.example` for the complete list with descriptions. Security-critical variables:

| Variable | Notes |
|---|---|
| `VOUCHER_SIGNING_SECRET` | Minimum 32 characters. Rotate immediately if compromised. |
| `DARAJA_PRODUCTION_ACTIVE` | Defaults to `false`. Two-trigger activation only. |
| `JWT_SECRET` | Minimum 64 characters. Different from any Midnight private key. |

---

## Security

- All SQL uses parameterised queries — zero string interpolation
- Phone numbers encrypted at rest using `pgcrypto`
- API keys stored as SHA-256 hashes — never plaintext
- Voucher QR codes signed with HMAC-SHA256 and verified with `crypto.timingSafeEqual`
- Daraja callbacks validated against Safaricom IP allowlist
- Fastify logger configured to redact: `Authorization` headers, phone numbers, `initData`, any field named `secret`, `token`, or `key`
- Rate limits: 100 req/min global, 10/min on auth, 3/hour on redemption, 4/day on atmospheric sync

Report security vulnerabilities to: **security@dira.africa**

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Write tests for any new service logic
4. Run `npm run test` — all tests must pass
5. Run `npm audit` — zero critical or high vulnerabilities
6. Open a Pull Request against `main`

All contributions are accepted under the Apache 2.0 license.

---

## Related Repositories

| Repository | Contents |
|---|---|
| [dira-core](https://github.com/dira-africa/dira-core) | Next.js 14 Telegram Mini App frontend |
| [dira-docs](https://github.com/dira-africa/dira-docs) | OpenAPI specs, API documentation, impact reports |
| [dira-contracts](https://github.com/dira-africa/dira-contracts) | Compact smart contracts for Midnight blockchain |

---

## License

Copyright 2025 Dira Africa

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.

The code is a gift to the world. The data, verified on Midnight, is the moat.
