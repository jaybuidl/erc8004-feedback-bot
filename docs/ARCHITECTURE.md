# Architecture

## Runtime model

The bot is a one-shot worker. A single run:

1. loads config and wallet state,
2. fetches the current active PGTCR items from Goldsky,
3. upserts them into SQLite,
4. revokes feedback for agents no longer present in the active set,
5. filters active entries by the configured age threshold,
6. claims eligible work locally to avoid duplicate sends,
7. reconciles against on-chain feedback already left by the bot wallet,
8. sends `giveFeedback`,
9. stores `tx_hash` and `feedback_index`,
10. exits.

Production scheduling is external: `systemd`, `cron`, `launchd`, or a job runner. The process is not intended to stay resident.

## Main modules

- `src/index.ts`: orchestration entrypoint
- `src/config.ts`: env loading, validation, per-chain overrides
- `src/goldsky-client.ts`: paginated Goldsky queries and strict item mapping
- `src/goldsky-items-mapper.ts`: transforms Goldsky items into collateralization events
- `src/eligibility.ts`: age-threshold eligibility logic
- `src/store.ts`: SQLite persistence, local idempotency, claim/revoke bookkeeping
- `src/feedback-content.ts`: env-driven review payload generation
- `src/feedback.ts`: ERC-8004 contract calls, feedback scan, revocation
- `src/wallet.ts`: signer/provider setup
- `src/metrics.ts`: optional Prometheus endpoint for long-lived or debugging runs

## Data flow

```text
Goldsky items
  -> GoldskyItemsMapper
  -> CollateralizationEvent[]
  -> SQLite processed_entries
  -> EligibilityEngine
  -> on-chain duplicate scan
  -> Reputation Registry giveFeedback / revokeFeedback
  -> SQLite feedback_index + tx history
```

## Persistence model

`processed_entries` is the source of local operational state. It tracks:

- first time an active collateralization was seen,
- when it became eligible,
- whether it is currently claimed or completed,
- transaction hash for sent feedback,
- stored `feedback_index`,
- revocation timestamps and revocation tx hash.

The table is keyed by `(agent_id, collateralization_id)`.

## Safety model

- Local duplicate protection: SQLite claims eligible work atomically.
- On-chain duplicate protection: before sending, the bot scans feedback previously left by its own wallet and skips matching active feedback.
- Revocation by absence: when an agent disappears from the current active Goldsky set, the bot revokes the feedback it previously left.
- Dry-run: when `DRY_RUN=true`, the bot performs all read-side logic without submitting live feedback transactions.

## Deployment model

- Native: `npm ci`, `npm run build`, then schedule `node dist/src/index.js`
- Linux: [`deploy/systemd/erc8004-feedback-bot.service`](../deploy/systemd/erc8004-feedback-bot.service) plus [`deploy/systemd/erc8004-feedback-bot.timer`](../deploy/systemd/erc8004-feedback-bot.timer)
- Docker: `docker compose run --rm bot`
