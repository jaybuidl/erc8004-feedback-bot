# Sepolia Deployment Runbook

## Deployment model

Use the bot as a scheduled one-shot worker.

- Linux: `systemd` timer
- macOS: `cron` or `launchd`
- Docker: `docker compose run --rm bot`

Do not treat it as a permanent HTTP service.

## 1. Prepare the host

Requirements:

- Node.js 20+
- outbound access to Sepolia RPC and Goldsky
- a funded Sepolia wallet

Install on the target host:

```bash
npm ci
npm run build
```

Native modules are host-specific. Run `npm ci` on Linux and on macOS separately.

## 2. Configure `.env`

Start from:

```bash
cp .env.example .env
```

`.env.example` is the canonical public sample. Keep a private local `.env` per host.

Fill in:

- `GOLDSKY_ENDPOINT_11155111`
- `PGTCR_REGISTRY_ADDRESS_11155111`
- `REPUTATION_REGISTRY_ADDRESS_11155111`
- `SEPOLIA_RPC`
- `PRIVATE_KEY` or `MNEMONIC`
- `DATABASE_PATH`

Recommended initial safety settings:

```bash
DRY_RUN=true
REVOKE_ON_ABSENCE=true
ONCHAIN_DUPLICATE_PROTECTION=true
ENABLE_METRICS=false
```

If you want dynamic review content, customize:

- `FEEDBACK_TITLE_TEMPLATE`
- `FEEDBACK_TEXT_TEMPLATE`
- `FEEDBACK_TAG1`
- `FEEDBACK_TAG2`
- `FEEDBACK_ENDPOINT`
- `FEEDBACK_URI_MODE`
- `FEEDBACK_EXTRA_JSON`

## 3. Validate locally on the target host

```bash
npm run validate-config
npm run preflight:sepolia
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run start:once
```

Expected dry-run behavior:

- wallet loads
- SQLite opens
- Goldsky fetch succeeds
- eligible agents are logged
- no live tx is sent because `DRY_RUN=true`

## 4. Switch to live mode

When the dry-run output looks correct:

```bash
DRY_RUN=false
```

Then run once again:

```bash
npm run start:once
```

Verify:

- a transaction hash is logged
- `feedback_index` is stored in SQLite
- the registry shows the new feedback

## 5. Linux scheduling with systemd

The provided files in [`deploy/systemd`](../deploy/systemd) already match the one-shot model.

Typical flow:

```bash
sudo cp deploy/systemd/erc8004-feedback-bot.service /etc/systemd/system/
sudo cp deploy/systemd/erc8004-feedback-bot.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erc8004-feedback-bot.timer
```

Adjust:

- `WorkingDirectory`
- `EnvironmentFile`
- `User`
- `Group`

Check:

```bash
systemctl list-timers | grep erc8004
journalctl -u erc8004-feedback-bot.service -n 200 --no-pager
```

## 6. macOS scheduling

Simple cron example:

```bash
*/30 * * * * cd /path/to/erc8004-feedback-bot && /usr/bin/env npm run start:once >> /tmp/erc8004-feedback-bot.log 2>&1
```

For a sturdier setup, use `launchd`.

## 7. Docker scheduling

Use Docker as a one-off execution target:

```bash
docker compose run --rm bot
```

If you want recurring runs with Docker, schedule that command externally from host cron, systemd timers, or your orchestration platform.

## 8. Operator checks after deployment

### New eligible agent

1. confirm it appears in Goldsky
2. wait until it crosses `MIN_AGE_HOURS`
3. run the bot
4. confirm SQLite row exists
5. confirm `feedback_index` is stored

### Revocation

1. remove or deactivate collateralization
2. run the bot again
3. confirm revocation tx is logged
4. confirm `revoked_at` and `revoked_tx_hash` are stored

### Duplicate protection

Even if the DB is incomplete, the bot scans the bot wallet's existing feedback on-chain before sending a new one. Leave `ONCHAIN_DUPLICATE_PROTECTION=true` in production.
