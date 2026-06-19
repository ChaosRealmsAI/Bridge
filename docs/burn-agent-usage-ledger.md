# Burn Agent Usage Ledger

This document defines the `panda-burn` managed Adapter feature for account-level Codex and Claude Code usage accounting.

## Boundary

The ledger belongs to `panda-burn` Adapter / product local tools. It is not a Bridge core feature.

Bridge core only transports encrypted relay envelopes. It must not parse token usage, cost, Codex, Claude Code, project, session, prompt, or file content.

## Source Policy

Allowed source:

- Local Codex JSONL.
- Local Claude Code JSONL.

Forbidden source:

- OpenAI or Anthropic billing APIs.
- Browser cookies, localStorage, web tokens, or reverse-engineered internal web endpoints.
- Bridge Cloud database.
- Product UI rendered messages.

The scan is active only. No watcher, daemon, or continuous background scanner is part of this feature.

## Managed Adapter Runtime

`panda-burn` ships as a manifest-isolated managed Adapter. The Desktop launcher expects the manifest runtime shape used by Rust Desktop:

```json
{
  "schema": "panda.bridge.managed-adapter.v1",
  "product_id": "panda-burn",
  "product_name": "Burn",
  "runtime": {
    "type": "node",
    "entry": "src/adapter-server.mjs",
    "args": ["serve"],
    "cwd": "."
  }
}
```

The Node entry must print a single-line ready JSON object on stdout. Desktop reads the first line only.

## Command

Product command inside encrypted Burn payload:

```json
{
  "type": "burn.agent.usage.summary",
  "input": {
    "project": "/abs/project",
    "source": "codex|claude",
    "profile_id": "optional",
    "profile_ids": ["optional"],
    "exclude_profile_ids": ["optional"],
    "from": "optional ISO date/time",
    "to": "optional ISO date/time",
    "timezone": "optional IANA timezone",
    "view": "optional summary|totals|activity|heatmap|filters|diagnostics|pricing|dimensions",
    "dimension": "optional dimension name",
    "limit": "optional row limit",
    "dimension_limit": "optional summary dimension cap",
    "force": "optional boolean",
    "snapshot": "optional boolean"
  }
}
```

Supported relay aliases:

- `burn.agent.usage.summary`
- `burn.agent.usage.refresh`
- `burn.agent.usage.status`
- `burn.agent.usage.totals`
- `burn.agent.usage.activity`
- `burn.agent.usage.heatmap`
- `burn.agent.usage.dimension`
- `burn.agent.usage.dimensions`
- `burn.agent.usage.filters`
- `burn.agent.usage.diagnostics`
- `burn.agent.usage.pricing`
- `burn.agent.usage.snapshot`
- `burn.agent.usage.compact`

Local CLI equivalent:

```bash
panda-burn agent usage summary --project "$PWD" --timezone Asia/Shanghai --json
panda-burn agent usage dimension --project "$PWD" --dimension by_account_day --limit 20 --json
panda-burn agent usage activity --project "$PWD" --json
panda-burn agent usage snapshot --project "$PWD" --view activity --json
panda-burn agent usage compact --project "$PWD" --json
```

`summary`, `activity`, `dimension`, `dimensions`, `totals`, `filters`, `diagnostics`, and `pricing` actively refresh from local JSONL unless a result cache is valid. `snapshot` reads the latest structured local result only and does not scan JSONL.

## Output

The adapter writes:

```text
<burn-home>/data/agent-usage/usage.sqlite
<burn-home>/data/agent-usage/latest.json
<burn-home>/data/agent-usage/runs/<run_id>.json
<burn-home>/data/agent-usage/views/*.json
<burn-home>/data/agent-usage/views/dimensions/*.json
```

`usage.sqlite` is the local indexed ledger materialized from each fresh scan.
The JSON files remain product-facing read models for fast UI reads, snapshots,
exports, and debugging. If the bundled Node runtime does not provide
`node:sqlite`, the ledger degrades to JSON-only and reports that storage engine
in the result metadata.

Required dimensions:

- totals
- by_provider
- by_account
- by_profile
- by_model
- by_day
- by_week
- by_month
- by_hour
- by_day_hour
- by_weekday_hour
- by_project
- by_account_day
- by_account_week
- by_account_month
- by_account_hour
- by_account_model
- by_account_project
- by_provider_day
- by_provider_week
- by_provider_hour
- by_project_month
- by_project_week
- by_model_day
- by_model_month
- by_session
- by_account_session

No leaderboard in this version. High-cardinality dimensions are capped by default and report truncation metadata in `diagnostics.dimension_meta`.

Activity output includes daily heatmap, day/hour heatmap, weekday/hour heatmap, peak hours, active spans, active days/hours, session count, and session span percentiles. Buckets include cache hit ratio, output/input ratio, average tokens/event, average USD/event, USD per 1M tokens, tokens per active hour, and events per active hour.

## Token and Cost Buckets

Track separately:

- input tokens
- output tokens
- cached input tokens
- cache creation input tokens
- cache creation 5m input tokens
- cache creation 1h input tokens
- cache read input tokens
- reasoning output tokens
- total tokens

Cost must be split by component:

- input USD
- cached input USD
- cache creation USD
- cache read USD
- output USD
- total USD

Pricing is a versioned API-equivalent estimate based on public OpenAI and Anthropic API prices. It is not a subscription invoice and cannot prove exact provider billing. Unknown model pricing records a warning and keeps token counts.

## Redaction

Outputs must not contain raw email, raw account id, token, cookie, prompt, reply, tool args, file content, stdout, or stderr.

Stable identifiers:

- `account_hash`
- `profile_id`
- masked profile path
- provider
- model

Relay responses omit raw local paths by default. Raw `project`, `directory`, `latest_path`, and `run_path` remain only in the local user-level Burn data files.

## Incremental Cache

The active scan may reuse parsed JSONL cache under:

```text
<burn-home>/data/agent-usage/cache/index.json
<burn-home>/data/agent-usage/cache/files/
<burn-home>/data/agent-usage/cache/results/
<burn-home>/data/agent-usage/cache/file-aggregates/
```

The cache is derived from JSONL and invalidated or isolated by parser version, pricing version, file size, file mtime, profile, account hash, timezone, and time filters. It is not a provider API or second billing source.

Cache layers:

- result cache for unchanged full scans.
- parsed file cache for unchanged JSONL.
- per-file aggregate cache for fast recompute across dimensions.
- snapshot views for sub-100ms local reads after a refresh.
- compact maintenance to minify derived cache JSON and remove obsolete cache folders.

The aggregate fast path must preserve global event-id dedupe. If a cached file aggregate conflicts with already-seen event ids, that file falls back to event-level dedupe.

## Verification

Minimum implementation checks:

```bash
bash spec/check-template.sh --no-smoke
```

Feature implementation must add fake JSONL verification before shipping:

- Codex `last_token_usage`.
- Codex cumulative `total_token_usage` delta.
- Claude assistant usage with cache read and cache creation.
- Duplicate Claude request id dedupe.
- Unknown model warning.
- `$BURN_APP_HOME/data/agent-usage/` write path.
- Secret and prompt redaction.
- Project path validation.
- Relay raw path redaction.
- Encrypted business errors.
- Local timezone day/week/month.
- Incremental cache hit on second active scan.
- Per-file aggregate cache hit on repeated scans.
- Snapshot view reads without JSONL scanning.
