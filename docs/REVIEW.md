# Code Review — Viability Assessment

Reviewed: 2026-03-24
Status: **Not mainnet-ready.** Architecture is sound, issues are fixable.
Context: Proof of concept — prioritize lean fixes over heavy engineering. One deployment unit per chain (Sepolia or Mainnet), configured via env vars.

---

## Architectural: Remove SQLite, go fully stateless

**Priority: Highest — do this first, it eliminates multiple bugs and simplifies everything.**

The bot currently uses SQLite (`src/store.ts`, ~650 lines) to track processed entries, dedup sends, and remember which agents need revocation. All of this information is already available from the two external sources of truth:

| DB purpose | Stateless alternative |
|---|---|
| Track `first_seen` for age eligibility | Subgraph already has `includedAt` timestamp |
| Dedup / claim-work | On-chain duplicate protection already exists (`findMatchingActiveFeedbackIndices`) |
| Track sent feedback (tx_hash, index) | Query own wallet's feedback from Reputation Registry |
| Track agents for revocation | Diff current subgraph active set vs own on-chain feedback |

**New run model:** Each run is a full snapshot diff — idempotent and self-contained.

1. Fetch all active PGTCR items from subgraph (already does this)
2. Fetch all own active feedback from the Reputation Registry (via Multicall3 batching for scale)
3. Diff → send feedback for agents in subgraph but not on-chain, revoke for agents on-chain but not in subgraph
4. If a run fails halfway, next run re-diffs and picks up naturally

No checkpoint or flat file needed — there's no incremental cursor to resume from.

**For scale (10k+ agents):** Batch on-chain view calls using Multicall3 (deployed on all major chains). Reduces thousands of `eth_call`s to ~50-100 batched calls.

**This eliminates review issues:** #3 (clearOldData revocation bug), #8 (broken bulk API), #9 (dual singleton), #11 (constructor error). Also removes the `sqlite3` dependency, Docker volume mounts, and DB corruption concerns.

**Files to remove/gut:** `src/store.ts`, `src/utils/database.ts`, all SQLite-related test fixtures, `DATABASE_PATH` config.

---

## Critical

### 1. Duplicate transactions on retry

**File:** `src/feedback.ts:295-326` (giveFeedback), `src/feedback.ts:380-387` (revokeFeedback)

`withRetry` wraps both gas estimation and tx submission in one lambda. If the tx is broadcast but the RPC returns a transient error before confirmation, retry submits the same feedback again with a new nonce.

**Fix:** Split into two steps: (a) estimate gas with retry, (b) submit tx without retry (or retry only if tx was provably not broadcast — e.g. catch and inspect error code before retrying).

### 2. `tx.wait()` null return not handled

**File:** `src/feedback.ts:333`

In ethers v6, `tx.wait(1)` returns `TransactionReceipt | null`. Null means the tx was dropped or replaced. Code accesses `receipt.hash` and `receipt.blockNumber` unconditionally → runtime crash.

**Fix:** Check for null. If null, log a warning with the tx hash so the operator can investigate. The stateless model means the next run will re-diff and detect whether the feedback landed or not, so no persistent state to corrupt.

---

## High

### 3. RPC config naming assumes Sepolia

**Files:** `src/config.ts:44`, `src/wallet.ts:34`

The env var is `SEPOLIA_RPC`. For mainnet deployment the operator must point `SEPOLIA_RPC` at a mainnet URL — confusing and error-prone.

**Fix:** Rename to `RPC_URL`. Keep `SEPELIA_RPC` as a deprecated alias if needed for transition.

### 4. Default chain ID is Sepolia

**File:** `src/config.ts:40`

`CHAIN_ID` defaults to `11155111`. Forgetting to set it for a mainnet deployment silently targets Sepolia.

**Fix:** Remove the default. Make `CHAIN_ID` required. The Zod schema should fail if not provided.

### 5. Skip-based pagination breaks at scale

**File:** `src/goldsky-client.ts:143-163`

Uses `skip` + `first` pagination. The Graph Protocol degrades above 5000 skip and may fail at 10000. Silently truncates results at scale.

**Fix:** Switch to cursor-based pagination using `id_gt` (query items where `id > lastSeenId`, ordered by `id`). Standard pattern for subgraph pagination.

### 6. No graceful shutdown

**File:** `src/index.ts` (missing)

No `SIGTERM`/`SIGINT` handler. If killed mid-transaction (Docker stop, systemd timeout), the tx may confirm on-chain but the run doesn't complete cleanly.

**Fix:** Add a signal handler that sets a shutdown flag. Check the flag between batch items. Stop processing and exit after the current tx completes. The stateless model makes this less dangerous (next run re-diffs), but it still avoids wasted gas on transactions that won't be followed through.

---

## Medium

### 7. No wallet balance preflight

**File:** `src/index.ts` (missing)

An empty wallet means every tx in the batch fails one-by-one, burning time on gas estimation and RPC calls.

**Fix:** Before the send loop, call `provider.getBalance(wallet.address)`. If below a threshold (e.g. `0.01 ETH`), log an error and skip sending. Threshold can be a config var.

### 8. Evidence encoded as base64 data URI in calldata

**File:** `src/feedback-content.ts:138-140`

Evidence JSON is base64-encoded into a `data:application/json;base64,...` URI and passed as calldata to `giveFeedback()`. Every byte costs 16 gas (non-zero calldata). A typical evidence payload is 1-2 KB of base64 — roughly 25-30K extra gas per feedback submission. On mainnet at 30 gwei, that's real money multiplied by every agent, every run.

**Fix:** Pin evidence to IPFS (Pinata or web3.storage), pass only the `ipfs://Qm...` URI on-chain (46 bytes). This is what the PRD specifies (see `docs/PRD_GAPS.md` G3). The entire `buildGeneratedFeedbackDocument` / `createDataUri` / template rendering pipeline in `src/feedback-content.ts` should be replaced with IPFS upload of a structured evidence JSON per the PRD §13 schema.

### 9. Metrics server never shut down

**File:** `src/index.ts:354-364`

`process.exit(0)` forcefully kills the Express metrics server. `metricsService.shutdown()` exists but is never called.

**Fix:** Call `metricsService.shutdown()` before exit. Or for a PoC, just accept the force-kill and document it.

---

## Low / Cleanup

### 9. Dead code

- `GAS_ESTIMATE_FALLBACK` in config — defined but never used
- `fetchActiveCollateralizations` in `src/goldsky-client.ts` — unclear which fetch method is canonical
- Unused type exports in `src/types.ts`: `GoldskyResponse`, `GoldskyPaginatedResponse`, `FeedbackConfig`, `MapperConfig`
- Eligibility engine withdrawal/challenged branches (`src/eligibility.ts:50-65`) — dead code since the subgraph query only returns active items

**Fix:** Remove. Less code = less confusion.

### 10. Private key may appear in Zod validation errors

**File:** `src/config.ts:386-391`

If Zod validation fails, error messages can include field values. A malformed `PRIVATE_KEY` would appear in logs.

**Fix:** Validate `PRIVATE_KEY` separately before passing to Zod, or use `.transform()` to redact in error paths.

### 11. Mixed `console.error` and structured logging

**File:** `src/index.ts:332`

Catastrophic error handler uses both `console.error` (stderr) and `logger.error` (file). In production, stderr may not be captured.

**Fix:** Use only `logger.error`.

---

## Test Coverage Analysis

414 test cases across 13 files. High count, low value. The suite provides a false sense of safety.

**The problem: tests mock the things they should be testing.**

- **Orchestrator test** (`tests/unit/orchestrator.test.ts`) — 64 mock setup lines for 3 test cases. Mocks store, goldsky, eligibility, feedback, wallet, metrics. Tests that mocks are called in the right order. Tests zero real behavior — if the orchestration wiring changes, every test breaks even if the system still works correctly.
- **Feedback test** (`tests/unit/feedback.test.ts`) — Mocks `ethers.Contract` entirely. `giveFeedback` returns a pre-built object with a `wait()` that returns a pre-built receipt. The two critical bugs (retry wrapping tx submission, null receipt) are structurally invisible — the mock never exhibits those failure modes.
- **E2e test** (`tests/e2e/orchestrate-dryrun.test.ts`) — Runs full orchestrator in DRY_RUN mode with mocked Goldsky and real SQLite. Verifies DB state. Never exercises a real contract call — not even against a local hardhat/anvil node. DRY_RUN skips the exact code path that has bugs.
- **No test verifies the ABI matches the deployed contract.** The feedback sender constructs an `ethers.Contract` with a hardcoded ABI array. If the ABI is wrong, every test still passes because the contract is fully mocked.

**What's actually well-tested:**

- **GoldskyItemsMapper** (`tests/unit/goldsky-items-mapper.test.ts`) — 154 match lines, tests crafted payloads against real validation logic (CAIP-10, bytes32 overflow, chain ID mismatch). This is the right approach: testing a boundary with real logic, not mocks.
- **Config validation** (`tests/unit/config.test.ts`) — Tests Zod schema with missing/invalid fields. Useful.
- **Retry utility** (`tests/unit/retry.test.ts`) — Tests backoff behavior. Useful.

**What the reworked bot should test instead:**

| Category | What | How |
|---|---|---|
| Subgraph validation | Malformed responses, missing fields, wrong chain, invalid CAIP-10 | Unit tests with crafted payloads (already good) |
| Diff logic | Given subgraph state X and Router state Y → correct actions | Pure function tests on `computeActions()`. No mocks needed. |
| Contract ABI | ABI matches deployed contract | Integration test against anvil fork — instantiate contract, call a view function |
| Tx lifecycle | Dropped tx, null receipt, gas failure, revert | Integration test against anvil fork with simulated failures |
| Config | Missing required fields, invalid formats, key redaction | Unit tests on Zod schema (already good) |

**Bottom line:** When rewriting, don't port the existing test approach. Test the boundaries and the diff logic, not mock call ordering. See `docs/PRD_AMENDMENTS.md` Amendment 10 for full guidance.

---

## What's solid — don't over-refactor

- **On-chain duplicate protection** (`findMatchingActiveFeedbackIndices`) — critical safety feature, works correctly
- **Revocation-by-absence design** — sound, becomes even simpler when stateless (just diff two sets)
- **Zod config validation** — catches most misconfigurations at startup
- **GoldskyItemsMapper** with strict CAIP10/bytes32 validation — well-tested, defensive
- **Template-based feedback content** — flexible without code changes

---

## Suggested fix order

1. **Remove SQLite** — go stateless, add Multicall3 batching for on-chain reads
2. **#1, #2** (tx safety) — prevent burning ETH on duplicates
3. **#3, #4** (chain config) — required for correct mainnet deployment
4. **#5** (pagination) — required for mainnet scale
5. **#6** (shutdown) — cleaner failure mode
6. Remaining medium/low items as time allows
