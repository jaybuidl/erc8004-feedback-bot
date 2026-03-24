# ERC-8004 Feedback Bot

This bot runs as a one-shot worker. Each run:

1. fetches the current active PGTCR collateralizations from Goldsky,
2. stores them in SQLite,
3. marks entries eligible after the configured age threshold,
4. checks the ERC-8004 Reputation Registry to avoid duplicate feedback,
5. sends positive feedback for new eligible entries,
6. revokes previously sent feedback when an agent is no longer actively collateralized,
7. exits.

The active runtime is [`src/index.ts`](./src/index.ts). It is meant to be scheduled by `systemd`, `cron`, `launchd`, or an external job runner. It is not a long-lived daemon.

## What changed in this repo

- Feedback content is now configurable from env.
- The bot stores `feedbackIndex` and can revoke by absence.
- Duplicate protection now uses both local SQLite state and on-chain reconciliation.
- The runtime works on both Linux and macOS, but you must install dependencies on each host separately.

Do not copy `node_modules` between Linux and macOS. Run `npm ci` on the target machine.

## Runtime model

- Primary command: `npm run start:once`
- Native production model: prebuild once, then schedule `node dist/src/index.js`
- Linux scheduling: `systemd` timer in [`deploy/systemd`](./deploy/systemd)
- macOS scheduling: `cron` or `launchd`
- Docker usage: run the container as a one-shot job with `docker compose run --rm bot`

## Feedback configuration

The feedback payload is built from env knobs:

- `FEEDBACK_VALUE`, `FEEDBACK_DECIMALS`
- `FEEDBACK_TAG1`, `FEEDBACK_TAG2`
- `FEEDBACK_ENDPOINT`
- `FEEDBACK_TITLE_TEMPLATE`
- `FEEDBACK_TEXT_TEMPLATE`
- `FEEDBACK_URI_MODE`
- `FEEDBACK_URI`
- `FEEDBACK_HASH`
- `FEEDBACK_EXTRA_JSON`

`FEEDBACK_URI_MODE` supports:

- `generated`: create a JSON document and store it as a `data:` URI
- `static`: use `FEEDBACK_URI` and `FEEDBACK_HASH`
- `auto`: use static values when `FEEDBACK_URI` is set, otherwise generate
- `none`: send no URI

Supported template variables include:

- `{{agentId}}`
- `{{agentIdDecimal}}`
- `{{collateralizationId}}`
- `{{collateralizationSince}}`
- `{{collateralizationSinceIso}}`
- `{{chainId}}`
- `{{chainName}}`
- `{{pgtcrId}}`
- `{{amount}}`
- `{{daysActive}}`
- `{{daysActiveRounded}}`
- `{{hoursActive}}`
- `{{walletAddress}}`
- `{{nowIso}}`
- `{{feedbackValue}}`
- `{{feedbackDecimals}}`

## Safety model

- Local idempotency: SQLite tracks processed entries and stored feedback indexes.
- On-chain duplicate protection: enabled with `ONCHAIN_DUPLICATE_PROTECTION=true`.
- Revocation by absence: enabled with `REVOKE_ON_ABSENCE=true`.
- Dry-run mode: `DRY_RUN=true` skips live transactions.

The duplicate scan reads the bot's existing feedback for each agent and skips sending when an active matching feedback already exists.

## Quick start

1. Install locally on the target machine:

```bash
npm ci
```

2. Copy and edit env:

```bash
cp .env.example .env
```

`.env.example` is the canonical public env sample for this repo.

3. Validate with dry-run:

```bash
npm run validate-config
npm run preflight:sepolia
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run start:once
```

4. Switch to live mode only after the dry-run looks correct:

```bash
DRY_RUN=false
```

## Scheduling

### Linux

Use the oneshot service and timer in [`deploy/systemd`](./deploy/systemd).

### macOS

Use `cron` or `launchd` to run:

```bash
cd /path/to/erc8004-feedback-bot && /usr/bin/env npm run start:once
```

### Docker

Run it as a one-off task:

```bash
docker compose run --rm bot
```

Do not use `docker compose up -d` as if it were a permanent service.

## Testing a new verified agent

Recommended path:

1. keep `DRY_RUN=true`,
2. use a fresh test database path,
3. add or verify the new PGTCR entry,
4. wait until it crosses `MIN_AGE_HOURS` or temporarily lower the threshold in a test env,
5. run `npm run start:once`,
6. confirm the entry appears in SQLite and is claimed as eligible,
7. switch to live mode and confirm a new `feedbackIndex` is stored.

## Docs

- Config reference: [`docs/CONFIG-REFERENCE.md`](./docs/CONFIG-REFERENCE.md)
- Operations: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)
- Sepolia deployment runbook: [`docs/DEPLOYMENT-RUNBOOK-SEPOLIA.md`](./docs/DEPLOYMENT-RUNBOOK-SEPOLIA.md)
