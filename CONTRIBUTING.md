# Contributing to Dira Africa

> **"The code is a gift to the world. The data, verified on Midnight, is the moat."**

Thank you for your interest in contributing to Dira — a Decentralised Physical Infrastructure Network (DePIN) turning smartphones into a distributed weather sensing network across Sub-Saharan Africa. Every line of code contributed here helps smallholder farmers earn airtime, access crop health reports, and build climate resilience.

This document applies to all four Dira repositories:

| Repository | Purpose |
|---|---|
| [`dira-core`](https://github.com/dira-africa/dira-core) | Telegram Mini App — Next.js 14, TypeScript |
| [`dira-api`](https://github.com/dira-africa/dira-api) | Fastify backend API, AI verification engine |
| [`dira-docs`](https://github.com/dira-africa/dira-docs) | OpenAPI specs, API documentation, impact reports |
| [`dira-contracts`](https://github.com/dira-africa/dira-contracts) | Compact smart contracts for Midnight blockchain |

All Dira code is licensed under **Apache 2.0**. By contributing, you agree that your contributions will be licensed under the same terms.

---

## Table of Contents

1. [Before You Start](#1-before-you-start)
2. [Ways to Contribute](#2-ways-to-contribute)
3. [Development Environment Setup](#3-development-environment-setup)
4. [Branch Strategy](#4-branch-strategy)
5. [Making a Contribution](#5-making-a-contribution)
6. [Commit Message Standards](#6-commit-message-standards)
7. [Pull Request Process](#7-pull-request-process)
8. [Code Standards](#8-code-standards)
9. [Security Contributions](#9-security-contributions)
10. [Testing Requirements](#10-testing-requirements)
11. [Documentation Contributions](#11-documentation-contributions)
12. [Midnight / Compact Contract Contributions](#12-midnight--compact-contract-contributions)
13. [Translation Contributions (English & Swahili)](#13-translation-contributions-english--swahili)
14. [Recognition](#14-recognition)
15. [Getting Help](#15-getting-help)

---

## 1. Before You Start

### Read these first

- **[README.md](./README.md)** — understand what Dira does and why
- **[CODE\_OF\_CONDUCT.md](./CODE_OF_CONDUCT.md)** — how we treat each other
- **[Open Issues](https://github.com/dira-africa/dira-core/issues)** — check if your idea or bug is already being tracked

### Sign the CLA

Dira Africa Limited requires all contributors to accept the [Apache 2.0 Contributor Licence Agreement](https://www.apache.org/licenses/LICENSE-2.0) before any pull request can be merged. By opening a PR you confirm that:

1. You have the right to submit the contribution under the Apache 2.0 licence.
2. You grant Dira Africa Limited a perpetual, worldwide, royalty-free licence to use your contribution.
3. Your contribution does not include any code that is proprietary, patented, or encumbered by a licence incompatible with Apache 2.0.

### A note on the communities we serve

Dira's users are smallholder farmers and rural youth across Kenya, many of whom depend on the platform for income and crop health information. Changes to core data collection, token economics, payment flows, or the AI verification engine can have direct real-world consequences. Please approach contributions to these areas with extra care and always consider the downstream impact on the people the platform serves.

---

## 2. Ways to Contribute

You do not need to write code to make a meaningful contribution to Dira.

### Report a bug

Open an issue using the **Bug Report** template. Include:
- Which repository and which endpoint/feature is affected
- Steps to reproduce (exact API request or UI action)
- Expected behaviour vs actual behaviour
- Device and OS if a frontend issue
- Any relevant logs (sanitised — remove phone numbers, JWTs, and API keys)

### Request a feature

Open an issue using the **Feature Request** template. Describe:
- The problem you are trying to solve
- Which type of user benefits (farmer / data agent / insurer / government)
- How it fits within the Dira circular economy or data verification model

### Fix a bug

Check the [`good first issue`](https://github.com/dira-africa/dira-core/labels/good%20first%20issue) and [`help wanted`](https://github.com/dira-africa/dira-core/labels/help%20wanted) labels. Comment on the issue to say you are working on it before starting — this prevents duplicate effort.

### Improve documentation

Documentation lives in `dira-docs`. API spec improvements, clearer README sections, Swahili translations, and the UNICEF reviewer guide are all high-impact contributions that require no backend knowledge.

### Add or improve Swahili translations

All user-facing strings must exist in both English (`en`) and Swahili (`sw`). Swahili translation quality — particularly for agricultural terminology — is critical to the platform's adoption. See [Section 13](#13-translation-contributions-english--swahili).

### Review pull requests

Code review is a contribution. Leave clear, specific, constructive feedback. Focus on correctness, security, and real-world impact — not personal style preferences.

### Write tests

Test coverage for the circular economy payment layers, the AI verification pipeline, and the Midnight contract interactions is the highest-value testing work. See [Section 10](#10-testing-requirements).

---

## 3. Development Environment Setup

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | ≥ 20.x | Runtime for dira-core and dira-api |
| TypeScript | ≥ 5.x | Language (do not use plain JavaScript) |
| PostgreSQL | 16.x | Database with PostGIS extension |
| Redis | 7.x | Job queue (BullMQ) and caching |
| Docker | Latest | Local Coolify-compatible environment |
| Git | ≥ 2.40 | Version control |

### Clone and install

```bash
# Clone the repository you want to contribute to
git clone https://github.com/dira-africa/dira-core.git
cd dira-core
npm install

# Copy the environment example file
cp .env.local.example .env.local
# Fill in the required values — see .env.local.example for descriptions
```

### Environment variables

**Never commit real credentials.** The `.env.local` file is in `.gitignore`. For local development:

- Use Africa's Talking sandbox credentials (not production)
- Use Safaricom Daraja sandbox credentials (not production)
- Set `DARAJA_PRODUCTION_ACTIVE=false` — always false in development
- Set `VOUCHERS_ACTIVE=false` unless you are specifically testing the voucher system
- Use a locally generated `JWT_SECRET` (minimum 64 characters)
- Use a locally generated `VOUCHER_SIGNING_SECRET` (minimum 32 characters)

Before your first commit, run:

```bash
git status
```

Confirm that `.env.local` does **not** appear in the output. If it does, your `.gitignore` is not working — fix it before committing anything.

### Run the development server

```bash
# dira-core (Next.js frontend)
npm run dev          # starts on localhost:3000

# dira-api (Fastify backend)
npm run dev          # starts on localhost:3001

# Run database migrations (dira-api only)
npm run migrate
```

### Verify your setup

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

All four commands must pass cleanly before you open a pull request.

---

## 4. Branch Strategy

Dira uses a simplified trunk-based development workflow.

| Branch | Purpose | Who pushes |
|---|---|---|
| `main` | Production-ready code. Auto-deploys to Coolify. | Maintainers only (via merged PRs) |
| `develop` | Integration branch. All PRs target this branch. | Via PR only |
| `feature/your-feature-name` | Your work. Branch from `develop`. | Contributors |
| `fix/issue-number-description` | Bug fixes. Branch from `develop`. | Contributors |
| `security/description` | Security fixes. May target `main` directly. | Maintainers + trusted contributors |

### Naming rules

```
feature/agent-sync-debounce
feature/voucher-expiry-countdown
fix/123-token-balance-race-condition
fix/456-gps-bounding-box-validation
security/voucher-hmac-timing-attack
docs/swahili-crop-report-translations
```

Branch names must be lowercase, hyphenated, and descriptive. No spaces, no uppercase.

---

## 5. Making a Contribution

```bash
# 1. Fork the repository on GitHub

# 2. Clone your fork
git clone https://github.com/YOUR-USERNAME/dira-core.git
cd dira-core

# 3. Add the upstream remote
git remote add upstream https://github.com/dira-africa/dira-core.git

# 4. Create your feature branch from develop
git checkout develop
git pull upstream develop
git checkout -b feature/your-feature-name

# 5. Make your changes
# ... write code, write tests, update docs ...

# 6. Run all checks (all must pass)
npx tsc --noEmit
npm run lint
npm test
npm audit

# 7. Stage and commit
git add .
git commit -m "feat(agent): add 90-minute sync debounce with countdown timer"

# 8. Push to your fork
git push origin feature/your-feature-name

# 9. Open a pull request on GitHub targeting the 'develop' branch
```

---

## 6. Commit Message Standards

Dira uses [Conventional Commits](https://www.conventionalcommits.org/). Every commit message must follow this format:

```
<type>(<scope>): <short description>

[optional body — explain WHY, not WHAT]

[optional footer: BREAKING CHANGE or closes #issue-number]
```

### Types

| Type | When to use |
|---|---|
| `feat` | A new feature |
| `fix` | A bug fix |
| `security` | A security fix or hardening change |
| `docs` | Documentation only |
| `test` | Adding or improving tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `chore` | Build process, dependency updates, CI changes |
| `i18n` | Translation additions or corrections |

### Scopes

Use the module name: `auth`, `farmer`, `agent`, `tokens`, `airtime`, `voucher`, `circle`, `mpesa`, `ai`, `triangulation`, `midnight`, `admin`, `dashboard`, `notifications`, `security`, `db`, `api`, `docs`.

### Examples

```
feat(voucher): add HMAC-SHA256 QR code signing with 48-hour expiry

Farmers can now generate farm input vouchers redeemable at agro-dealer
partners. Each voucher is signed with VOUCHER_SIGNING_SECRET to prevent
forgery. Expiry enforced server-side at scan time.

Closes #87
```

```
security(auth): replace === with timingSafeEqual for initData hash comparison

Timing attack vulnerability: the previous === comparison leaked timing
information that could be used to brute-force Telegram auth hashes.
crypto.timingSafeEqual() is now used exclusively for all cryptographic
comparisons throughout the authentication module.

BREAKING CHANGE: none — internal implementation change only
```

```
fix(triangulation): correct altitude-adjusted pressure formula

The previous formula subtracted altitude correction in the wrong direction,
causing high-altitude readings (e.g. Nyandarua County at 2,800m) to be
incorrectly flagged as anomalous. Corrected to: adjusted = reference -
(altitude_m / 100 * 12).

Closes #142
```

```
i18n(notifications): add Swahili templates for Dira Circle distribution

Added sw variants for T5 (circle distribution ready) and T5b (distribution
confirmed). Agricultural Swahili reviewed by native speaker.
```

---

## 7. Pull Request Process

### Before opening a PR

- [ ] All TypeScript errors resolved (`npx tsc --noEmit` passes)
- [ ] All lint errors resolved (`npm run lint` passes)
- [ ] All tests pass (`npm test` passes)
- [ ] No critical or high npm vulnerabilities (`npm audit` passes)
- [ ] New functionality has tests (see Section 10)
- [ ] Documentation updated where relevant
- [ ] No secrets, API keys, or real phone numbers in any committed file
- [ ] `.env.local` is not in `git status` output

### PR title format

Follow the same Conventional Commits format as commit messages:

```
feat(voucher): add agro-dealer QR scan endpoint with replay protection
fix(143): correct Kenyan phone number regex for Telkom numbers
security: replace all cryptographic === comparisons with timingSafeEqual
docs: add UNICEF reviewer guide for Midnight block explorer verification
```

### PR description template

When you open a PR, the description template will be pre-populated. Complete every section:

**What does this PR do?**
A concise description of the change and why it is needed.

**How was it tested?**
Describe exactly how you verified this works. Include test output, device tested on, API requests used.

**Security considerations**
Does this change affect: authentication, token balances, payment flows, GPS data, phone number handling, file uploads, or the voucher system? If yes, explain your security approach.

**Breaking changes**
Does this change break any existing API contracts, database schemas, or environment variable names?

**Related issues**
`Closes #123` or `Related to #456`

### Review process

- Every PR requires **at least one maintainer approval** before merging
- PRs touching payment flows (airtime, vouchers, Dira Circle, M-Pesa) require **two approvals**
- PRs touching the Midnight smart contracts require **two approvals plus a security note**
- Maintainers aim to review within **48 hours** of a PR being opened
- Address all review comments before requesting re-review
- Do not merge your own PR — even if you have write access

### After merging

- Delete your feature branch
- Verify that the CI/CD pipeline completes successfully in Coolify
- If your change affects the public dashboard or a user-facing notification template, test it in the Telegram Mini App on a real device

---

## 8. Code Standards

### TypeScript

- **TypeScript only** — no plain JavaScript files
- Strict mode enabled (`"strict": true` in tsconfig.json)
- No `any` types — use proper typing or `unknown` with type guards
- All functions must have explicit return types
- All async functions must handle errors — no unhandled promise rejections

```typescript
// ✗ Wrong
async function getBalance(userId) {
  const result = await db.query('SELECT * FROM users WHERE id = ' + userId);
  return result;
}

// ✓ Correct
async function getBalance(userId: string): Promise<number> {
  const result = await db.query<{ balance: number }>(
    'SELECT balance_after FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return result.rows[0]?.balance_after ?? 0;
}
```

### SQL

**No string concatenation in SQL queries. Ever.**

```typescript
// ✗ This is a SQL injection vulnerability
db.query(`SELECT * FROM users WHERE county = '${county}'`);

// ✓ Always use parameterised queries
db.query('SELECT * FROM users WHERE county = $1', [county]);
```

Run `grep -r "query\`" src/` before every PR to confirm there is no template literal SQL in your changes.

### Cryptographic comparisons

**Never use `===` to compare hashes, tokens, signatures, or any security-sensitive value.**

```typescript
// ✗ Timing attack vulnerability
if (computedHash === submittedHash) { ... }

// ✓ Timing-safe comparison
import { timingSafeEqual } from 'crypto';
const a = Buffer.from(computedHash, 'hex');
const b = Buffer.from(submittedHash, 'hex');
if (a.length === b.length && timingSafeEqual(a, b)) { ... }
```

### Error responses

Production error responses must never include stack traces, database error messages, file paths, or library names.

```typescript
// ✗ Leaks internal details
return reply.status(500).send({ error: error.message, stack: error.stack });

// ✓ Safe error response
return reply.status(500).send({
  success: false,
  error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' }
});
```

### File and directory naming

- TypeScript files: `camelCase.ts`
- React components: `PascalCase.tsx`
- Test files: `filename.test.ts`
- SQL migration files: `001_extensions.sql`, `002_users.sql` (zero-padded, sequential)
- Compact contract files: `PascalCase.compact`

### Imports

Use absolute imports configured in `tsconfig.json`. Do not use relative `../../..` imports more than one level deep.

```typescript
// ✗ Fragile relative import
import { tokenService } from '../../../services/tokenService';

// ✓ Absolute import
import { tokenService } from '@/services/tokenService';
```

---

## 9. Security Contributions

Security is the highest-priority contribution area in Dira. The platform handles GPS data, phone numbers, crop photos, and real financial transactions on behalf of low-income farmers. A security failure has direct consequences for real people.

### Responsible disclosure

**Do not open a public GitHub issue for a security vulnerability.**

If you discover a security vulnerability, please report it privately:

- **Email:** security@dira.africa
- **Subject line:** `[SECURITY] Brief description`
- **Response time:** We aim to acknowledge within 24 hours and provide a timeline within 72 hours

Your report should include:
1. Which repository and component is affected
2. A description of the vulnerability
3. Steps to reproduce
4. The potential impact (who is affected and how)
5. Any suggested fix (optional but appreciated)

We will credit you in the security advisory unless you prefer to remain anonymous.

### Security review checklist for contributors

Before opening any PR, verify your change does not introduce:

- [ ] SQL string concatenation (use parameterised queries only)
- [ ] `===` comparisons for hashes, tokens, or HMAC signatures (use `timingSafeEqual`)
- [ ] Hardcoded credentials, API keys, or phone numbers
- [ ] Stack traces or database errors in API responses
- [ ] `console.log` statements that output request bodies, JWTs, or phone numbers
- [ ] File upload handling that trusts `Content-Type` headers instead of magic bytes
- [ ] CORS `origin: '*'` (only `app.dira.africa` and `localhost:3000` are permitted)
- [ ] New environment variables that are not validated by Zod at startup
- [ ] GPS coordinates that are not validated against the Kenya bounding box
- [ ] Pressure readings that are not validated against the physical range (870–1084 hPa)
- [ ] Any change to `DARAJA_PRODUCTION_ACTIVE` — this flag defaults to `false` and is changed only through a formal activation process documented in the build guide

### Known security-sensitive areas

Contributions to the following areas receive extra scrutiny and require two reviewer approvals:

| Area | Why it is sensitive |
|---|---|
| `POST /auth/telegram` | Entry point for all users — HMAC verification must be exact |
| `POST /tokens/redeem/*` | All four circular economy payment endpoints touch real money |
| `POST /partner/voucher/scan` | HMAC signature verification — replay and forgery risks |
| `POST /webhooks/daraja/result` | Safaricom IP allowlist — fake callbacks could trigger fraudulent credits |
| `src/services/aiService.ts` | Photo processing — memory management and file path traversal |
| `src/db/migrations/` | Schema changes are permanent and affect data integrity |
| `contracts/` | Compact contracts are immutable once deployed to Midnight Mainnet |

---

## 10. Testing Requirements

### Minimum test coverage requirements

| Module | Minimum coverage | Rationale |
|---|---|---|
| `auth` | 90% | All users pass through here |
| `tokens` (ledger) | 95% | Financial data — no partial failures |
| `airtime` redemption | 90% | Real money to real phones |
| `voucher` system | 90% | Security-critical HMAC path |
| `circle` distribution | 85% | Coordinator payout logic |
| `mpesa` / Daraja | 85% | Only active in production |
| `ai` verification | 80% | Photo pipeline |
| `triangulation` | 80% | Atmospheric verification |
| `midnight` | 75% | Contract interaction layer |

### Test file location

Tests live alongside the code they test:

```
src/
  services/
    tokenService.ts
    tokenService.test.ts       ← unit tests
  routes/
    tokens.ts
    tokens.test.ts             ← route/integration tests
tests/
  e2e/
    farmer-journey.test.ts     ← end-to-end tests
    agent-journey.test.ts
    circular-economy.test.ts
```

### What every test file must include

For any function that touches financial data (token ledger, airtime, vouchers, circle, M-Pesa):

1. **Happy path** — the normal successful flow
2. **Insufficient balance** — attempt to spend more tokens than available
3. **Race condition** — two simultaneous redemption requests with the same balance
4. **Rollback** — if the external API (AT, Daraja) fails, tokens must be refunded
5. **Flag gate** — if `DARAJA_PRODUCTION_ACTIVE=false`, M-Pesa routes must return 503

For any function that validates geographic or physical data:

1. **Within Kenya bounds** — valid coordinates pass
2. **Outside Kenya bounds** — 422 error returned
3. **Valid pressure range** — 870–1084 hPa passes
4. **Invalid pressure** — outside range returns 422

For any function that does cryptographic comparison (auth, vouchers):

1. **Valid signature** — passes
2. **Tampered payload** (one character changed) — returns 401 or 400
3. **Replay** (same valid request twice) — second request rejected
4. **Stale timestamp** — auth\_date older than 5 minutes returns 401

### Running tests

```bash
# All tests
npm test

# With coverage report
npm run test:coverage

# Watch mode during development
npm run test:watch

# A specific test file
npx jest src/services/tokenService.test.ts

# E2E tests (requires a running database)
npm run test:e2e
```

---

## 11. Documentation Contributions

Documentation is a first-class contribution. The `dira-docs` repository is the reference point for:

- The OpenAPI 3.0 specification (`openapi.yaml`)
- The public API documentation (used by insurer and bank partners)
- The UNICEF reviewer guide (how to independently verify data on Midnight)
- The impact reports (quarterly, published as PDFs)
- Setup and deployment guides

### Documentation standards

- Write in plain English. Assume the reader knows their domain (agriculture, insurance, or blockchain) but not Dira's internals.
- Every API endpoint must have: a description, all request parameters, all response fields, at least one example request and response, and documented error codes.
- Code examples must be valid and tested — not pseudocode.
- Swahili translations are required for all user-facing documentation.

### OpenAPI spec contributions

All API changes in `dira-api` must be accompanied by an update to `dira-docs/openapi.yaml`. The PR will not be merged if the spec is out of date.

```yaml
# Example endpoint documentation standard
/tokens/redeem/airtime:
  post:
    summary: Redeem Climate Tokens for mobile airtime
    description: |
      Exchanges Climate Tokens for airtime sent directly to a Kenyan mobile number
      via Africa's Talking. Minimum redemption: 20 tokens (KES 11 airtime).
      Tokens are deducted immediately. If the AT disbursement fails, tokens are
      automatically refunded and the user is notified via Telegram.
    security:
      - bearerAuth: []
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            required: [token_amount, phone_number]
            properties:
              token_amount:
                type: integer
                minimum: 20
                description: Number of tokens to redeem (minimum 20)
                example: 50
              phone_number:
                type: string
                pattern: '^(\+?254|0)[17][0-9]{8}$'
                description: Kenyan mobile number (Safaricom, Airtel, or Telkom)
                example: "+254712345678"
    responses:
      '200':
        description: Airtime sent successfully
      '400':
        description: Validation error (below minimum, invalid phone, or insufficient balance)
      '429':
        description: Rate limit exceeded (maximum 3 redemptions per hour)
```

---

## 12. Midnight / Compact Contract Contributions

The Dira smart contracts in `dira-contracts` are held to the highest standard of any code in the platform. Once deployed to Midnight Mainnet, they **cannot be changed**. Every contribution to the contracts directory is treated as production-critical.

### Before contributing to contracts

1. Complete the [Midnight Developer Academy](https://docs.midnight.network/develop/tutorial/) beginner and intermediate modules
2. Read the Compact language specification in full
3. Understand Midnight's dual-ledger model (public state vs shielded private state)
4. Never submit a Compact contract PR without a corresponding test suite

### Contract contribution process

1. All contract development happens on Testnet first — minimum 30 days of Testnet operation before a Mainnet deployment PR is opened
2. Every contract PR must include:
   - The `.compact` contract file
   - A complete `.test.ts` test suite
   - A `SECURITY.md` file for that contract describing the threat model
   - An `AUDIT.md` template (to be completed by external auditors before Mainnet deployment)
3. Mainnet deployment PRs require two maintainer approvals **plus** a completed `AUDIT.md` showing zero Critical and zero High findings from an external security review

### What belongs on-chain vs off-chain

| On-chain (Midnight) | Off-chain (PostgreSQL) |
|---|---|
| Weekly batch hash (Merkle root of verified data point IDs) | Individual farmer readings and GPS coordinates |
| ZK Data Certificate status (VALID/INVALID/PENDING) | The readings used to generate the certificate |
| Contract access control (authorised oracle address) | User identities and phone numbers |

Never put personally identifiable information on-chain. The purpose of the Midnight integration is to provide tamper-proof provenance of the *existence* of verified data — not to publish the data itself.

---

## 13. Translation Contributions (English & Swahili)

All user-facing strings in Dira must exist in both English (`en`) and Swahili (`sw`). Translation is one of the most impactful contributions a non-developer can make.

### Where translations live

```
dira-core/
  lib/
    i18n/
      en.ts    ← English strings
      sw.ts    ← Swahili strings
```

### Translation standards

- Translations must use **agricultural Swahili** — the Swahili spoken by smallholder farmers in Nakuru and Meru counties, not formal or urban Swahili
- Technical jargon must be avoided. If there is no Swahili agricultural term, use a plain descriptive phrase
- All eight Telegram notification templates must have both language variants
- All onboarding steps must be fully translated
- All error messages must be translated

### Swahili review process

All Swahili translations must be reviewed by at least one native Swahili speaker who has agricultural domain knowledge before merging. If you are not a native speaker, open the PR and tag it `needs-sw-review`. A member of the Dira field operations team will review.

### Key agricultural Swahili terms used in Dira

| English | Swahili (Dira standard) |
|---|---|
| Crop photo | Picha ya mazao |
| Crop health | Afya ya mazao |
| Weather sync | Usawazishaji wa hali ya hewa |
| Climate Token | Token ya hali ya hewa |
| Farm input voucher | Vocha ya pembejeo za kilimo |
| Agro-dealer | Mfanyabiashara wa kilimo |
| Barometric pressure | Shinikizo la anga |
| Data Agent | Wakala wa data |
| Farmer | Mkulima |
| County coordinator | Mkurugenzi wa kaunti |
| Redemption | Ukombozi / Fidia |
| Airtime | Muda wa maongezi |

---

## 14. Recognition

Every contributor to Dira is acknowledged. We believe in transparent, public recognition of the open-source community that makes this platform possible.

- **All merged PRs** are credited in the relevant release notes
- **Contributors** are listed in `CONTRIBUTORS.md` in each repository, maintained automatically via the `all-contributors` bot
- **Significant contributions** (features, security fixes, Compact contracts) are highlighted in the quarterly impact report published to `dira-docs`
- **First-time contributors** receive a personal welcome from the Dira core team
- **Swahili translators and field knowledge contributors** are credited alongside technical contributors — their work is equally valuable

---

## 15. Getting Help

| Channel | Purpose |
|---|---|
| [GitHub Issues](https://github.com/dira-africa/dira-core/issues) | Bug reports and feature requests |
| [GitHub Discussions](https://github.com/dira-africa/dira-core/discussions) | Questions, ideas, architecture discussions |
| community@dira.africa | General community inquiries |
| security@dira.africa | Security vulnerability reports (private) |

When asking for help, please provide:
- Which repository you are working in
- Your Node.js and TypeScript versions (`node --version`, `tsc --version`)
- The exact error message and stack trace (sanitised — remove any credentials or personal data)
- What you have already tried

---

## A note on our mission

Dira exists because smallholder farmers in Sub-Saharan Africa are among the most climate-vulnerable people on Earth, and because existing insurance and data systems have failed them. Every bug you fix, every test you write, every Swahili string you translate makes the platform more reliable for the farmers and Data Agents who depend on it.

Thank you for contributing.

---

*This CONTRIBUTING.md is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Dira Africa Limited, 2025–2026.*
