# Operations Runbook

## Normal operating model

- Keep the bot in one-shot mode.
- Schedule it every 15 to 30 minutes.
- Keep `DRY_RUN=true` until you have validated the full path on the target chain.
- Use a persistent SQLite path per chain.

## What to check first

### The bot did not run

- Linux: `systemctl list-timers | grep erc8004`
- Linux logs: `journalctl -u erc8004-feedback-bot.service -n 200 --no-pager`
- macOS / cron: check the scheduler logs and run `npm run start:once` manually
- Docker one-shot: `docker compose run --rm bot`

### The bot ran but sent nothing

- Verify `DRY_RUN`
- Verify the Goldsky endpoint and registry filter
- Check the threshold: `MIN_AGE_HOURS` or `MIN_ACTIVE_DAYS`
- Check current active entries in SQLite:

```bash
sqlite3 data/bot-state-sepolia.db "select agent_id, collateralization_id, eligible_at, feedback_sent_at, revoked_at, status from processed_entries order by first_seen_at desc;"
```

### A new verified agent should have been picked up

1. Confirm it exists in Goldsky and is still `Submitted` or `Reincluded`.
2. Confirm it is older than the configured threshold.
3. Confirm the bot sees it after a run:

```bash
sqlite3 data/bot-state-sepolia.db "select agent_id, collateralization_id, first_seen_at, eligible_at, status from processed_entries where agent_id = '<lowercased_agent_id>';"
```

4. In live mode, confirm `feedback_index` and `tx_hash` are filled.

### Duplicate feedback concern

The bot now has two layers of protection:

- SQLite state
- on-chain scan of the bot's own feedback for the target agent

Check tracked feedback locally:

```bash
sqlite3 data/bot-state-sepolia.db "select agent_id, collateralization_id, feedback_index, tx_hash, revoked_at from processed_entries where feedback_sent_at is not null order by feedback_sent_at desc;"
```

If you lose or replace the DB, on-chain duplicate protection is what prevents immediate resends.

### Revocation concern

If `REVOKE_ON_ABSENCE=true`, the bot compares currently active Goldsky entries with agents that still have tracked active feedback. If an agent disappears from the active set, the bot revokes all unrevoked feedback it previously left for that agent.

Check locally:

```bash
sqlite3 data/bot-state-sepolia.db "select agent_id, feedback_index, feedback_sent_at, revoked_at, revoked_tx_hash from processed_entries where feedback_sent_at is not null order by agent_id, feedback_index;"
```

## Common failure modes

### Goldsky errors

- Check endpoint reachability
- Increase `GOLDSKY_TIMEOUT_MS` if the endpoint is slow
- If you hit upstream limits, reduce schedule frequency or page size

### Metrics port conflict

If `ENABLE_METRICS=true` and the port is already taken, the bot now logs a warning and continues. This is expected behavior for one-shot scheduled runs when another process already owns the port.

### SQLite / native module issues

If the app fails with a native module error on a new host:

```bash
npm ci
# or, if needed
npm rebuild sqlite3
```

Do this on the actual target machine. Do not copy `node_modules` between operating systems.

### Database reset

Only reset the DB intentionally.

```bash
rm -f data/bot-state-sepolia.db
```

If you do this, the bot will rebuild local state from Goldsky. Duplicate protection on-chain should still prevent immediate re-sends, but you should still treat a DB reset as an operator action that needs review.

## Verification commands

```bash
npm run validate-config
npm run preflight:sepolia
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run start:once
```

## Recommended live checklist

1. `DRY_RUN=true`
2. clean test database path
3. `npm run start:once`
4. confirm entries are fetched and marked eligible
5. switch to `DRY_RUN=false`
6. run once again
7. confirm `feedback_index` and `tx_hash`
8. later, confirm revocation works when the agent is no longer active
