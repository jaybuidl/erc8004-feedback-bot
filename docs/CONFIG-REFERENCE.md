# Configuration Reference

This bot is configured entirely from env. The runtime is one-shot, so most operators only need a single `.env` plus an external scheduler.

## Required on real runs

| Variable | Purpose |
| --- | --- |
| `GOLDSKY_ENDPOINT` or `GOLDSKY_ENDPOINT_<CHAIN_ID>` | Goldsky GraphQL endpoint |
| `PGTCR_REGISTRY_ADDRESS` or suffixed override | Registry filter for Goldsky items |
| `REPUTATION_REGISTRY_ADDRESS` or suffixed override | ERC-8004 Reputation Registry |
| `PRIVATE_KEY` or `MNEMONIC` | Signer credential |
| `SEPOLIA_RPC` | RPC endpoint used for contract reads and writes |
| `MIN_AGE_HOURS` or `MIN_ACTIVE_DAYS` | Eligibility threshold |

## Chain selection

| Variable | Default | Notes |
| --- | --- | --- |
| `CHAIN` | unset | Optional chain name such as `sepolia` or `mainnet` |
| `CHAIN_ID` | `11155111` in production | Numeric EIP-155 chain id |
| `CHAINS` | unset | Optional JSON object of per-chain overrides |
| `PGTCR_ID` | `1` | Numeric PGTCR instance id stored with each entry |

Suffix-based overrides are supported and usually simpler than `CHAINS`, for example:

- `GOLDSKY_ENDPOINT_11155111`
- `REPUTATION_REGISTRY_ADDRESS_11155111`
- `PGTCR_REGISTRY_ADDRESS_11155111`
- `DATABASE_PATH_11155111`
- `PGTCR_ID_11155111`

## Feedback payload

| Variable | Default | Notes |
| --- | --- | --- |
| `FEEDBACK_VALUE` | `1` | Reputation delta |
| `FEEDBACK_DECIMALS` | `0` | Decimal precision |
| `FEEDBACK_TAG1` | `pgtcr_active` | Primary tag |
| `FEEDBACK_TAG2` | empty | Secondary tag |
| `FEEDBACK_ENDPOINT` | empty | Free-form endpoint string |
| `FEEDBACK_TITLE_TEMPLATE` | `PGTCR collateralization active` | Rendered into generated payloads |
| `FEEDBACK_TEXT_TEMPLATE` | built-in default | Rendered into generated payloads |
| `FEEDBACK_URI_MODE` | `auto` | `auto`, `generated`, `static`, or `none` |
| `FEEDBACK_URI` | empty | Used in `static` mode, or in `auto` when present |
| `FEEDBACK_HASH` | zero hash | Used in `static` mode |
| `FEEDBACK_EXTRA_JSON` | `{}` | Extra JSON merged into generated payloads |
| `FEEDBACK_TAGS` | `["pgtcr_active"]` | Legacy fallback for tag derivation |

### Template variables

These variables can be used in `FEEDBACK_TITLE_TEMPLATE`, `FEEDBACK_TEXT_TEMPLATE`, and string values inside `FEEDBACK_EXTRA_JSON`:

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

### URI mode behavior

- `generated`: create a JSON document, encode it as a `data:` URI, and hash it on the fly.
- `static`: use `FEEDBACK_URI` and `FEEDBACK_HASH`.
- `auto`: use static values if `FEEDBACK_URI` is set, otherwise generate.
- `none`: send empty URI and zero hash.

## Duplicate protection and revocation

| Variable | Default | Notes |
| --- | --- | --- |
| `REVOKE_ON_ABSENCE` | `true` | Revoke active feedback when the agent is no longer currently collateralized |
| `ONCHAIN_DUPLICATE_PROTECTION` | `true` | Scan the registry before sending new feedback |
| `ONCHAIN_FEEDBACK_SCAN_LIMIT` | `100` | Max feedback indexes scanned per agent |

The bot stores `feedback_index` in SQLite after successful sends or successful reconciliation against existing on-chain feedback.

## Throughput and timing

| Variable | Default | Notes |
| --- | --- | --- |
| `MIN_AGE_HOURS` | unset | Preferred threshold input, accepts decimals such as `0.5` |
| `MIN_ACTIVE_DAYS` | unset | Backward-compatible threshold input |
| `MAX_BATCH_SIZE` | `10` | Max feedback items prepared per run batch |
| `FEEDBACK_BATCH_INTERVAL_MS` | `100` | Delay between individual sends inside `sendBatch()` |
| `BATCH_PAUSE_MS` | `500` | Delay between orchestrator batches |
| `QUEUE_BATCH_PAUSE_MS` | `1000` | Legacy queue pause knob, still accepted |

## Goldsky

| Variable | Default |
| --- | --- |
| `GOLDSKY_PAGE_SIZE` | `100` |
| `GOLDSKY_TIMEOUT_MS` | `30000` |
| `PAGINATION_DELAY_MS` | `200` |

## Runtime and persistence

| Variable | Default | Notes |
| --- | --- | --- |
| `DRY_RUN` | `false` | No live transactions when true |
| `DATABASE_PATH` | `./data/bot-state.db` | SQLite database path |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ENABLE_METRICS` | `false` | Optional HTTP metrics endpoint |
| `METRICS_PORT` | `3000` | Used only when metrics are enabled |
| `NODE_ENV` | `production` | `development`, `production`, or `test` |

## Operational notes

- For timer-based production runs, `ENABLE_METRICS=false` is usually the right default because the process exits after each run.
- The bot now tolerates metrics port conflicts; it logs a warning and continues.
- Install dependencies on the target host with `npm ci`. Native modules such as `sqlite3` must be built per platform.
