import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { assertAllowedReadUrl, normalizeLeagueResponse, ReadOnlyToolRegistry } from "../src/espn.js";
import { LunaClient, LunaError } from "../src/openai.js";
import { blockedReport, createEnvelope, mergeReportPayload, renderMarkdown } from "../src/report.js";
import { DiscordPublisher } from "../src/publisher.js";
import { workerOnce } from "../src/orchestrator.js";
import { enqueueDueJobs } from "../src/scheduler.js";
import { actionByFromDeadline, cronMatches, displayTime } from "../src/time.js";
import { semanticErrors, validateReport } from "../src/validation.js";

const root = path.resolve(".");
const config = loadConfig(path.join(root, "config.yaml"), { envPath: path.join(root, "nonexistent-test.env") });
const rawFixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/sample-league.json"), "utf8"));
const snapshot = normalizeLeagueResponse(rawFixture, { collectedAt: "2026-09-08T20:00:00Z", schedule: rawFixture.scheduleFixture });

function recommendation(overrides = {}) {
  return {
    decision_key: "late-test",
    type: "ADD_DROP",
    research_state: "READY",
    priority: "URGENT",
    player_ids: [201, 102],
    add_player_id: 201,
    drop_player_id: 102,
    lineup_changes: [],
    summary: "test",
    rationale: "test",
    counterargument: "test",
    horizon: "THIS_WEEK",
    expected_points_delta: null,
    confidence: "MEDIUM",
    source_ids: ["ESPN_LEAGUE_READ"],
    preconditions: [],
    invalidated_by: [],
    relevant_deadline_utc: null,
    action_by_utc: null,
    expires_at: null,
    suggested_bid: null,
    bid_policy_reference: null,
    alternative_group_id: null,
    alternative_rank: null,
    depends_on_decision_keys: [],
    alternatives: [],
    unresolved_requirements: [],
    authorization_granted_by_report: false,
    ...overrides
  };
}

test("configuration is fixed to Luna xhigh and Mexico City", () => {
  assert.equal(config.llm.model, "gpt-5.6-luna");
  assert.equal(config.llm.reasoning.effort, "xhigh");
  assert.equal(config.timezone, "America/Mexico_City");
  assert.equal(config.identity.league_id, 125290435);
});

test("Luna client rejects every request-level model or effort override", async () => {
  const client = new LunaClient({ apiKey: "test", fetchImpl: async () => { throw new Error("must not be called"); } });
  await assert.rejects(client.call({ input: "x", purpose: "test", overrides: { model: "gpt-4o" } }), LunaError);
  await assert.rejects(client.call({ input: "x", purpose: "test", overrides: { reasoning: { effort: "low" } } }), LunaError);
  await assert.rejects(client.call({ input: "x", purpose: "test", model: "gpt-4o" }), LunaError);
});

test("Luna client sends exactly the required model and effort", async () => {
  let request;
  const client = new LunaClient({ apiKey: "test", maxOutputTokens: 200, fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return new Response(JSON.stringify({ status: "completed", output_text: "ok", output: [] }), { status: 200 }); } });
  await client.call({ input: "x", purpose: "test", webSearch: false });
  assert.deepEqual(request.model, "gpt-5.6-luna");
  assert.deepEqual(request.reasoning, { effort: "xhigh" });
  assert.equal(request.max_output_tokens, 200);
  assert.equal(client.requestLog[0].model, "gpt-5.6-luna");
  assert.equal(client.requestLog[0].reasoning_effort, "xhigh");
});

test("Luna client bounds a provider stream that never resolves", async () => {
  const client = new LunaClient({ apiKey: "test", timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(client.call({ input: "x", purpose: "timeout-test", webSearch: false }), /timed out/);
});

test("worker enforces a hard end-to-end deadline and does not retry a timed-out job", async () => {
  const store = new Store(":memory:");
  store.enqueueJob({ jobKey: "deadline-test", jobType: "daily_scout", availableAt: "2026-09-08T20:00:00Z" });
  const boundedConfig = { ...config, orchestration: { ...config.orchestration, jobTimeoutMs: 25, bounded_retries: 2 } };
  const startedAt = Date.now();
  const result = await workerOnce({
    store,
    config: boundedConfig,
    adapter: { readSnapshot: async () => snapshot },
    luna: { call: async () => new Promise(() => {}) },
    publisher: { publish: async () => ({ status: "sent" }) },
    now: "2026-09-08T20:00:00Z"
  });
  assert.equal(result.status, "timed_out");
  assert.ok(Date.now() - startedAt < 500, `deadline test exceeded 500ms: ${Date.now() - startedAt}ms`);
  assert.equal(store.listJobs()[0].status, "failed");
  assert.equal(store.listJobs()[0].attempts, 1);
  store.close();
});

test("ESPN adapter allowlist blocks arbitrary URLs and mutations", () => {
  assert.doesNotThrow(() => assertAllowedReadUrl(config.espn.leagueUrl, "league"));
  assert.throws(() => assertAllowedReadUrl("https://example.com/claim", "league"));
  const tools = new ReadOnlyToolRegistry({ snapshot });
  assert.throws(() => tools.invoke("submit_claim"), /blocked/);
  assert.throws(() => tools.invoke("get_arbitrary_url"), /blocked/);
});

test("ESPN parsing fails closed when scoring or roster shape changes", () => {
  const changed = normalizeLeagueResponse({ ...rawFixture, status: {}, teams: [] }, { collectedAt: "2026-09-08T20:00:00Z", schedule: rawFixture.scheduleFixture });
  assert.ok(changed.criticalMissing.includes("scoring_period_id"));
  assert.ok(changed.criticalMissing.includes("own_team"));
  assert.ok(changed.criticalMissing.includes("own_roster"));
});

test("local cron matching uses Mexico City and converts UTC kickoff display", () => {
  assert.equal(cronMatches("0 8 * * *", "2026-09-08T14:00:00Z", "America/Mexico_City"), true);
  assert.equal(cronMatches("0 8 * * *", "2026-09-08T15:00:00Z", "America/Mexico_City"), false);
  assert.match(displayTime("2026-09-10T00:20:00Z"), /2026-09-09 18:20/);
});

test("event scheduling supports a Thursday game and safe action cutoff", () => {
  const store = new Store(":memory:");
  const jobs = enqueueDueJobs({ store, config, snapshot, now: "2026-09-09T23:00:00Z" });
  assert.ok(jobs.considered.some((job) => job.jobType === "pregame_coach"));
  assert.ok(jobs.considered.some((job) => job.jobType === "inactive_watch"));
  const duplicate = enqueueDueJobs({ store, config, snapshot, now: "2026-09-09T23:00:00Z" });
  assert.equal(duplicate.inserted, 0);
  store.close();
});

test("unknown rules block only waiver recommendations", () => {
  const waiver = createEnvelope({ status: "ACTIONABLE", human_summary: "waiver", scope: "test", findings: [], recommendations: [{ decision_key: "w1", type: "WAIVER_CLAIM", research_state: "READY", priority: "BEFORE_DEADLINE", player_ids: [201], add_player_id: 201, drop_player_id: 102, lineup_changes: [], summary: "add", rationale: "r", counterargument: "c", horizon: "THIS_WEEK", expected_points_delta: null, confidence: "MEDIUM", source_ids: ["ESPN_LEAGUE_READ"], preconditions: [], invalidated_by: [], relevant_deadline_utc: "2026-09-09T05:00:00Z", action_by_utc: null, expires_at: null, suggested_bid: null, bid_policy_reference: null, alternative_group_id: null, alternative_rank: null, depends_on_decision_keys: [], alternatives: [], unresolved_requirements: [], authorization_granted_by_report: false }], retired_decision_keys: [], risks_and_unknowns: [], next_check_at: null }, { config, snapshot, sequence: 1, now: "2026-09-08T20:00:00Z" });
  const unknown = { ...snapshot, rules: { ...snapshot.rules, known: false } };
  const errors = semanticErrors(waiver, unknown, config, { now: "2026-09-08T20:00:00Z" });
  assert.ok(errors.some((error) => error.includes("unknown waiver")));
});

test("schema rejects unexpected top-level fields and accepts the kit example", () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, "example_blocked_report.json"), "utf8"));
  assert.equal(validateReport(example, { schemaPath: config.paths.schema }).valid, true);
  assert.equal(validateReport({ ...example, extra: true }, { schemaPath: config.paths.schema }).valid, false);
});

test("action_by is deterministic and stale action becomes ALERT_ONLY", () => {
  assert.equal(actionByFromDeadline("2026-09-10T00:20:00Z"), "2026-09-10T00:05:00.000Z");
  const report = createEnvelope({ status: "ACTIONABLE", human_summary: "late", scope: "test", findings: [], recommendations: [recommendation({ relevant_deadline_utc: "2026-09-10T00:20:00Z" })], retired_decision_keys: [], risks_and_unknowns: [], next_check_at: null }, { config, snapshot, sequence: 1, now: "2026-09-10T00:06:00Z", jobType: "pregame_coach" });
  assert.equal(report.payload.status, "ALERT_ONLY");
  assert.equal(report.payload.recommendations[0].action_by_utc, "2026-09-10T00:05:00.000Z");
  assert.ok(new Date(report.expires_at) > new Date(report.generated_at));
});

test("merge preserves unexpired decisions but retires explicit keys", () => {
  const previous = { payload: { recommendations: [{ decision_key: "keep", expires_at: "2026-09-10T00:00:00Z", authorization_granted_by_report: false }, { decision_key: "retire", expires_at: "2026-09-10T00:00:00Z", authorization_granted_by_report: false }] } };
  const merged = mergeReportPayload({ status: "NO_ACTION", human_summary: "quiet", scope: "test", findings: [], recommendations: [], retired_decision_keys: ["retire"], risks_and_unknowns: [], next_check_at: null }, previous, { now: "2026-09-08T20:00:00Z" });
  assert.deepEqual(merged.recommendations.map((item) => item.decision_key), ["keep"]);
  assert.deepEqual(merged.retired_decision_keys, ["retire"]);
});

test("markdown is rendered from the same decision manifest", () => {
  const report = blockedReport({ config, snapshot, sequence: 1, reason: "fixture test", now: "2026-09-08T20:00:00Z" });
  const md = renderMarkdown(report);
  assert.match(md, new RegExp(report.report_id));
  assert.match(md, /No executable decisions/);
  assert.match(md, /ESPN_LEAGUE_READ/);
});

test("disabled Discord delivery never calls the webhook", async () => {
  const store = new Store(":memory:");
  const calls = [];
  const delivery = new DiscordPublisher({ store, config: { ...config, publication: { ...config.publication, delivery: { ...config.publication.delivery, enabled: false, webhook: "https://discord.invalid" } } }, fetchImpl: async () => { calls.push(true); return new Response("ok", { status: 204 }); } });
  const report = blockedReport({ config, snapshot, sequence: 1, reason: "delivery test", now: "2026-09-08T20:00:00Z" });
  const result = await delivery.deliver(report);
  assert.equal(result.status, "disabled");
  assert.equal(calls.length, 0);
  store.close();
});
