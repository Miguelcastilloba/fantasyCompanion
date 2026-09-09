# Fantasy Companion

A Node.js, read-only NFL fantasy research service for league `125290435`, team `2`, season `2026`.

It polls the supplied ESPN league endpoint, normalizes live league state, queues deterministic research jobs in SQLite, calls only `gpt-5.6-luna` with `reasoning.effort = xhigh`, validates the complete report manifest, writes JSON and Markdown archives, and can deliver material reports to a preconfigured Discord webhook.

The supplied `BUILD_BRIEF.md`, prompts, and `report.schema.json` are preserved in this repository as the source specification. The direct request for Node.js is implemented here; the kit's Python CLI examples were adapted to the Node CLI below.

## Setup

```bash
npm install
copy .env.example .env   # Windows; keep the existing .env if one was supplied
```

Set these values in `.env`:

- `OPENAI_API_KEY`: used only by the deterministic server-side model client.
- `ESPN_LEAGUE_URL`: already set to the supplied 2026 league URL.
- `ESPN_S2` and `ESPN_SWID` (or ESPN's browser-cookie spellings `espn_s2` and `SWID`): required if ESPN returns 401 for the league read; they never enter model prompts.
- `DISCORD_WEBHOOK`: used only by the deterministic publisher.

The local configuration is now enabled for Discord notifications, and a real webhook smoke test succeeded. To pause delivery, set either `publication.delivery.enabled: false` in `config.yaml` or `DELIVERY_ENABLED=false` in `.env`.

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

Live model requests have a 180-second timeout by default (`FANTASY_LLM_TIMEOUT_MS` can lower or raise it); timeout and provider errors become `BLOCKED` work rather than a stuck worker.
The configured 24k output cap is retained as a ceiling; specialist and editor calls use smaller internal budgets to keep scheduled research bounded.

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
