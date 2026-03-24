# CLAUDE.md

## Project Status

**Proof of concept, needs significant rework** → `docs/REVIEW.md` — code-level bugs and issues, prioritized

## Overview

ERC-8004 reputation feedback bot for Kleros. One-shot worker (scheduled hourly), not a daemon. One deployment unit per chain (Sepolia for testing, Mainnet for production), configured via env vars.

**What it does:** Bridges two systems:
- **Kleros PGTCR** (subgraph via Goldsky) — curated registry where agents are collateralized. Presence = skin in the game.
- **ERC-8004 Reputation Registry** (on-chain) — bot writes reputation feedback based on PGTCR state changes.

Both registries are ecosystem singletons maintained externally — we only consume and write to them.

**Three scenarios:**
1. Agent verified (Submitted/Reincluded) → positive feedback (+95) via Router — **implemented**
2. Agent removed by dispute (Absent + challenger won) → revoke old positive, submit negative (-95) via Router — **not implemented**
3. Agent voluntarily withdraws (Absent, no dispute) → revoke only (neutral) — **partial:** revocation works but bot can't distinguish withdrawal from dispute (treats all absences as revoke)

**Target architecture (per review docs):**
- **Stateless snapshot diff** — each run reads subgraph + Router contract state, computes diff, executes actions, exits. No local database.
- **KlerosReputationRouter contract** — on-chain intermediary that owns feedback state, tracks indices, provides access control. Bot calls Router, never ReputationRegistry directly.
- **IPFS evidence** — pin structured evidence JSON to IPFS, pass `ipfs://` URI on-chain (not base64 data URIs).

The current codebase has none of these — it calls ReputationRegistry directly, uses SQLite, has no Router, no IPFS, no negative feedback scenario, and encodes evidence as base64 calldata.

## Commands

```bash
npm run build              # TS → dist/
npm run dev                # ts-node dev mode
npm start                  # run pre-built
npm run start:once         # build + run

npm run lint               # ESLint
npm run lint:fix
npm run typecheck          # tsc --noEmit

npm run test:unit          # tests/unit/
npm run test:integration   # tests/integration/
npm run test:e2e           # tests/e2e/
npm test                   # all three sequentially
npx jest tests/unit/config.test.ts  # single file
```

## Current Architecture (to be reworked)

Entry: `orchestrateRun()` in `src/index.ts`. All major modules are singletons.

**Key modules:**
- `src/config.ts` — Zod-validated env vars, over-engineered multi-chain overrides
- `src/goldsky-client.ts` — GraphQL paginated fetch (skip-based, needs cursor-based)
- `src/goldsky-items-mapper.ts` — item validation (CAIP10, bytes32, chain match) — **well-tested, keep**
- `src/eligibility.ts` — age-based filtering (redundant with PGTCR's own periods, remove)
- `src/feedback.ts` — calls ReputationRegistry directly (should call Router instead)
- `src/feedback-content.ts` — template rendering + base64 data URIs (replace with IPFS)
- `src/store.ts` — SQLite persistence (remove entirely, go stateless)

## Safety Defaults

- `DRY_RUN=true` — must explicitly disable for live transactions
- `ONCHAIN_DUPLICATE_PROTECTION=true` — scans existing feedback before sending
- `REVOKE_ON_ABSENCE=true` — auto-revokes for disappeared agents

## Testing
- `tests/setup.ts` resets config singleton per file
- Fixtures: `tests/fixtures/sample-events.ts`
- CI: lint → typecheck → unit → integration → e2e → build → validate-config

Tests exist but mock at the wrong layer — see `docs/REVIEW.md` test coverage analysis. When reworking, test boundaries (subgraph validation, contract ABI, tx lifecycle) and diff logic, not mock call ordering. Use anvil fork for integration tests.
