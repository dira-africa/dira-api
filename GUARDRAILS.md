# GUARDRAILS.md — dira-api

Hard constraints for any agent working in this repo. These override any task
instruction. If a task asks you to break one, STOP and ask the human.

## Secrets & keys
- NEVER commit secrets. Only `.env.example` (placeholders) is tracked; real `.env`
  is git-ignored.
- NEVER print, log, or echo a private key, mnemonic, JWT secret, pgcrypto key, or
  any API key.
- You may use ONLY Hedera **testnet** operator credentials and **sandbox** payment
  credentials. You must never request, read, or use a Hedera **mainnet** operator
  key or **production** Pretium / Africa's Talking credentials.

## Money & mainnet — human-only
- Do NOT execute any Hedera **mainnet** transaction. For mainnet you prepare
  scripts + a runbook; the human runs them and pastes back only public IDs.
- Do NOT move real money or send real payouts. Sandbox providers only.
- Any payout path must be idempotent (idempotency key) and must never double-send.

## Database
- Migrations are APPEND-ONLY. Never edit, delete, or renumber an existing file in
  `src/db/migrations/`. Add the next number.
- No destructive SQL (DROP/TRUNCATE/DELETE without a WHERE) without an explicit
  human checkpoint.
- Never put PII (phone, name, exact location, photo) into any on-chain payload —
  on-chain data is the SHA-256 hash and Hedera metadata only.

## Scope & process
- Work ONLY inside `dira-api`. Do not modify `dira-core`, `dira-docs`, or any
  other repo from here.
- Run every task in Plan mode; produce a plan and wait for approval before writing.
- Require a human checkpoint before: any mainnet call, any real payment, any
  migration, any dependency removal, any change to auth or secrets handling.
- Preserve the Apache-2.0 license header on every source file.
- Do not reintroduce XION, zkVerify, or Midnight. They are being removed.
