# Fantasy Companion

A small, read-only Node.js companion for turning ESPN fantasy-football data into cited, validated research reports and optional Discord notifications.

It polls an ESPN league endpoint, normalizes live league state, queues deterministic research jobs in SQLite, calls only `gpt-5.6-luna` with `reasoning.effort = xhigh`, validates the complete report manifest, writes JSON and Markdown archives, and can deliver material reports to a Discord webhook.

The repository includes prompts, a report schema, an offline fixture, deployment templates, and tests so it can serve as a practical starting point for other fantasy leagues. The checked-in configuration is intentionally pinned to the original reference league; adapting it for another league should be a deliberate fork that updates the identity constants and ESPN allowlist tests as well as the environment values.

## Setup

```bash
npm install
copy .env.example .env   # Windows; keep the existing .env if one was supplied
```

Set these values in `.env`:

- `OPENAI_API_KEY`: used only by the deterministic server-side model client.
- `ESPN_LEAGUE_URL`: the HTTPS ESPN league read endpoint for the target league.
- `ESPN_S2` and `ESPN_SWID` (or ESPN's browser-cookie spellings `espn_s2` and `SWID`): required if ESPN returns 401 for the league read; they never enter model prompts.
- `DISCORD_WEBHOOK`: used only by the deterministic publisher. Set `DELIVERY_ENABLED=true` when you want reports delivered.

To pause delivery, set either `publication.delivery.enabled: false` in `config.yaml` or `DELIVERY_ENABLED=false` in `.env`.

## Commands

```bash
# Safe offline verification: fixture, no model call, no Discord delivery
node src/cli.js dry-run --config config.yaml

# Verify ESPN access and queue the current period baseline
node src/cli.js bootstrap --config config.yaml

# Offline bootstrap/worker using the included fixture
node src/cli.js bootstrap --config config.yaml --fixture fixtures/sample-league.json
FANTASY_DISABLE_LLM=true node src/cli.js worker --once --config config.yaml --fixture fixtures/sample-league.json

# The one-minute dispatcher; it returns without waiting for model calls
node src/cli.js tick --config config.yaml

# Long-running worker for systemd or another supervisor
node src/cli.js worker --config config.yaml

# Deterministic validation of a saved report
node src/cli.js validate-report reports/2026/3/latest.json --config config.yaml
```

`dry-run` defaults to `fixtures/sample-league.json` and does not call OpenAI. Use `--live-llm` only when you intentionally want a live model run; `worker` uses the configured key unless `FANTASY_DISABLE_LLM=true` is set.

Every job has a hard 15-minute end-to-end deadline. ESPN reads are capped at 60 seconds each, Luna requests at 5 minutes each, and Discord delivery is deadline-aware. A timed-out job is marked `timed_out` and is not retried indefinitely; provider failures that finish quickly can still use the configured bounded retries. `FANTASY_JOB_TIMEOUT_MS`, `FANTASY_LLM_TIMEOUT_MS`, and `FANTASY_ESPN_TIMEOUT_MS` may lower these limits but cannot raise them.
The configured 24k output cap is retained as a ceiling; the specialist uses up to 20k tokens and the editor up to 24k so `xhigh` research has room to complete without unbounded output.

## Safety boundaries

- The ESPN adapter permits only HTTPS `GET` reads to the allowlisted league/schedule paths. There are no ESPN mutation methods, generic HTTP tools, shell tools, computer-use tools, or model-selected recipients.
- Every model call, specialist, editor, retry, and structured-output retry is emitted through one client that rejects model/effort overrides and records Luna/xhigh metadata.
- The model receives normalized snapshots, not ESPN cookies. Source URLs are accepted only from host-collected ESPN metadata or Responses API citation annotations.
- `READY` means research-ready, not authorized or executed. No report grants permissions.
- Reports are complete manifests with stable decision keys, supersession, state hashes, deadlines, provenance, and deterministic semantic checks.
- Discord delivery is idempotent after provider acceptance and is independently recorded from research completion. `NO_ACTION` reports are suppressed.

## Deployment templates

`deploy/crontab.example` runs only the one-minute `tick` dispatcher. `deploy/worker.service.example` runs the Node worker; copy them to your host and replace `/opt/fantasy-research` with the deployment directory. The application, not cron, interprets `America/Mexico_City` schedules.

No live ESPN or OpenAI integration is claimed by the repository tests. The included fixture and deterministic validation tests pass offline. A live bootstrap currently requires valid ESPN session credentials when the endpoint returns 401.
