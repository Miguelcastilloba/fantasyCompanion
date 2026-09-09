# Codex build task: research-only NFL fantasy staff for Miguel

Build the service specified in this folder. Do not connect or deploy automatically, do not make ESPN modifications, and do not create a ChatGPT task. Produce implementation, tests, and clear deployment commands. Use current official OpenAI documentation and verify any ESPN adapter against actual read access; ESPN-specific parsing must fail closed when the response shape changes.

## Fixed requirements

League ID 125290435, team ID 2, initial season 2026. Discover the live scoring period and fantasy-season state from ESPN. Display America/Mexico_City time and store UTC. Never hard-code a roster or assume default scoring, waiver, position, or lock settings.

Every model invocation, specialist, research reviewer, output-formatting repair, retry, and delegated AI call MUST use:

```json
{"model":"gpt-5.6-luna","reasoning":{"effort":"xhigh"}}
```

Centralize the model client, forbid request-level overrides, record model/effort on every request, and fail closed on unsupported model/effort. No fallback to a different model or lower reasoning. The executor is external and not implemented here.

## Architecture

Implement a Python service with a deterministic scheduler, a durable queue, read-only source adapters, seven prompted research roles, deterministic validation, and a report publisher. A small SQLite database with transactions, leases, and durable job IDs is sufficient for one team. Avoid unnecessary microservices. Separate the collector credential boundary from model-facing functions.

CLI contract:

- `python -m fantasy_research tick --config /etc/fantasy-research/config.yaml`: discover due jobs and enqueue them; return promptly without waiting for model calls.
- `python -m fantasy_research worker --config /etc/fantasy-research/config.yaml`: consume jobs, gather research, review, validate, and publish.
- `python -m fantasy_research bootstrap --config ...`: verify read access and rules, build baseline state, and queue actionable current-period research.
- `python -m fantasy_research validate-report PATH`: deterministic schema/provenance/freshness validation.
- `python -m fantasy_research dry-run --config ...`: use fixtures or live reads, never deliver to the executor or mutate ESPN.

The cron and systemd files are templates for these commands; create those commands before installing the templates. Make dry-run mode the deployment default.

## Data collection and isolation

Read current league settings, complete own roster, relevant opponent state, exact lineup eligibility, byes, authoritative kickoff times, player locks, available players, waiver state/deadlines, pending claims, acquisition limits, budget/priority, recent transactions, projections, usage data, and official injuries/inactives. Store ESPN IDs as identifiers, including defense IDs. Track missing fields explicitly.

The model receives typed read functions or normalized snapshots, never ESPN cookies. Keep actual session cookies in the read adapter's secret store; do not assume those cookies are inherently read-only. Enforce a host/path/method/function allowlist in code, and expose no generic HTTP, shell, computer-use, ESPN POST/PUT/PATCH/DELETE, or transaction mutation tool to any model. Only the deterministic publisher can write the service's own output files or deliver reports to a preconfigured recipient.

Use supported read-only data access and honor source access policies. Do not bypass paywalls, authentication, or source throttling. A periodic poll only finds news exposed by its configured sources; do not claim real-time injury monitoring from the ESPN API alone. Mark coverage and stale/unavailable sources in the report.

Snapshot records need collection timestamps, stable player IDs, relevant source references, and canonical hashes for rules, own roster/lineup, pending claims/budget, and affected market availability. Retain the snapshot used for every published recommendation.

## Scheduler semantics

Interpret config.yaml cron expressions in America/Mexico_City inside the application using an IANA-aware time implementation. Do not rely on CRON_TZ portability. The system crontab runs only the one-minute dispatcher. Do not implement kickoff jobs with fixed Sunday/Thursday times.

Fetch actual kickoff timestamps, convert them for display, and rebuild event jobs when schedules change. Include every relevant rostered player, bench alternative, shortlisted acquisition, and the earliest lock of a contingency. Handle international, Wednesday, Friday, Saturday, Sunday, and Monday games identically. Use verified per-player/league lock rules rather than assuming kickoffs are the only deadlines.

Use Tuesday/Wednesday waiver clock runs only as normal review anchors. Verified claim deadlines and actual processing events override them. Never assume processing succeeded because a time passed. If a claim cutoff cannot be read or derived from verified rules, block deadline-dependent actions while still reporting useful research.

At simultaneous schedules coalesce the daily checklist into the deeper job. Persist a unique key from league, team, season, period, job type, event ID, and scheduled occurrence. Acquire leases, recover abandoned jobs, and do not resend completed work on restart. Coalesce bursty news updates, but never suppress a newly material injury due to a routine cooldown.

After downtime, discard jobs past their safe action cutoff, alert on missed critical decisions, and schedule the next still-actionable window. Bootstrap should research the current upcoming week immediately rather than waiting until Friday. Do not retain old-season hard-coded jobs. Stop regular jobs when the user's fantasy competition is no longer active unless an operator explicitly enables off-season monitoring.

## Research execution

Use Responses API web_search for sourced current research and allowlisted custom read functions for private league data. Assemble instructions from 00_shared.md plus the role prompt, verified current context, event scope, and relevant previous decisions/receipts. Capture tool sources, web citation annotations, retrieval times, and response status. Do not trust model-written source URLs without provenance.

Model outputs that refuse, time out, exceed token limits, or fail schema validation cannot be silently treated as a clean NO_ACTION. Use bounded retries and clear BLOCKED output. Enforce all retries and output repairs through the same Luna xhigh client. Research may be broad for weekly passes and narrow for a game-time check; model/effort remains identical.

The final editor should use strict structured output for the ReportPayload definition in report.schema.json. The host creates the publication envelope and derived deadlines. Check current documentation for tool/structured-output support; a two-call research-then-structured-editor flow is acceptable. Do not imitate citations with fabricated links.

## Decision and publication contract

Publish immutable reports under reports/<season>/<period>/<report_id>.json and .md. Maintain an atomic latest.json pointer and a serial sequence per league/team/period. Render human Markdown from the same validated JSON to avoid conflicting versions. A new report is a COMPLETE manifest: merge surviving unexpired decisions, retire obsolete ones, and explicitly supersede the previous report. A narrow injury update must not accidentally erase a pending waiver recommendation.

Use stable decision keys independent of report UUID/timestamp so the executor can deduplicate repeated advice. On substantive changes to an action's parameters, retire its old key and create a new revision. Distinguish mutually exclusive alternatives and dependent actions, including multiple claims using one drop. Do not publish all fallback options as independent READY acquisitions.

Per recommendation include exact type/players/slots, conditions, supporting evidence, timeframe, confidence, expected impact where actually supportable, counterargument, exact deadline, valid alternatives, and any unresolved issue. READY means researched, not authorized. Keep budgets/permissions out of the analyst's control.

Derive each action_by as the earliest relevant verified lock/claim/substitute deadline minus the configured 15-minute buffer. Publication expires no later than the earliest included recommendation expiry. Default age cap is 120 minutes for ordinary actionable reports and 30 minutes for pregame actionable reports; these are conservative design defaults, not ESPN rules. Long-range findings can remain in research history, but executable advice must be revalidated before reissue. If a high-effort run finishes too late, emit ALERT_ONLY, not a backdated fresh action report.

Refresh live state after long research and before publication. Reject or recompute advice if its relevant state changed. Publication-time snapshots must meet the configured freshness limit. Old jobs must not overwrite newer state simply because they finished later. Serialize report commit and validate under the same state revision.

Implement both JSON Schema validation and semantic checks: legal resulting lineup, exact IDs, source IDs existing in the registry, no unsupported actionable claims, time ordering, current scoring period, no locked moves, available targets, valid drop pairings, known acquisition mechanics, affordable proposals, protected-player policy, consistent recommendation groups, and no completed action duplication.

## Delivery and external executor

Delivery starts disabled. Configure an email adapter with an explicitly allowlisted sender and recipient. Send only a reviewed material report or a critical blocked/deadline alert. Subject: FANTASY_RESEARCH_READY | league=125290435 | team=2 | period=<period> | report=<id>.

Include the human summary and complete structured report in the message body; do not rely on ChatGPT reading a server-local file or an unavailable attachment. Do not include cookies, API keys, or confidential opponent account information. Keep delivery idempotent; only flag as sent after confirmed provider acceptance. Record transport status independently from research completion. The model cannot choose a recipient or compose instructions that expand executor authority.

Where supported, the user can create a ChatGPT Work Gmail-triggered task using CHATGPT_EXECUTION_TASK.md. This service must not assume that event-triggered tasks, browsing, ESPN login, or write permissions exist. Gate production notifications on a no-change integration test and report capability problems explicitly. Task delivery and action timing are not guaranteed real-time.

Persist/report execution receipts when a supported bridge is configured. Otherwise reconcile through fresh ESPN reads and explicitly retain unknown action status rather than inventing receipts. Do not process the executor's acknowledgement as a new research trigger email.

## Acceptance tests

1. Every AI call, including nested reviewers/retries, is exactly Luna xhigh; override/fallback attempts fail.
2. A tool-injection attempt to submit a claim, call an arbitrary URL, invoke a shell, or extract cookies is blocked outside the model.
3. Unknown scoring/waiver/lock rules block the dependent recommendation, not the entire unrelated research history.
4. Clock triggers run at Mexico City local time; kickoff conversion works across a US DST change and for international or non-Sunday games.
5. A healthy-appearing starter unexpectedly on official inactives is caught; missing official news is not treated as confirmed active.
6. A Sunday-night questionable starter cannot use an already-locked early-game player as fallback; the earlier decision deadline is scheduled.
7. Continuous waivers do not produce an impossible immediate free-agent pickup. Unprocessed claims remain pending.
8. Duplicate scheduler ticks, process restarts, out-of-order completions, and repeated delivery never create duplicate decisions/executions.
9. The final consolidated report preserves still-valid decisions and retires executed/stale alternatives.
10. A changed roster, expired report, newly unavailable target, undroppable player, conflicting claims, or insufficient budget fails semantic validation.
11. Final kickoff research that finishes after its action buffer produces ALERT_ONLY rather than an actionable report.
12. Incomplete/refused output and API failures are BLOCKED, not NO_ACTION; quiet successful scans do not notify the executor.
13. Markdown and JSON show identical decisions and clickable evidence references; fabricated source IDs fail validation.
14. The publication example in this kit validates, and unexpected fields are rejected.
15. Delivery/authentication/approval failures notify the user clearly; no ESPN write occurs anywhere in the research service.

Return code, tests, a passing test summary, and deployment instructions. State which integrations were tested live and which remain unverified. Never claim the bot is deployed or connected just because the implementation exists.
