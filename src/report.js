import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MODEL, REASONING_EFFORT } from "./constants.js";
import { actionByFromDeadline, asUtc, isoUtc, minIso } from "./time.js";

const STATUS = new Set(["ACTIONABLE", "NO_ACTION", "BLOCKED", "ALERT_ONLY"]);

function deepCopy(value) { return JSON.parse(JSON.stringify(value)); }

function emptyPayload(status, summary, scope, risks = []) {
  return { status, human_summary: summary, scope, findings: [], recommendations: [], retired_decision_keys: [], risks_and_unknowns: risks, next_check_at: null };
}

function makeSources(snapshot, extraSources = []) {
  const base = snapshot?.sources || [];
  const all = [...base, ...extraSources];
  const seen = new Set();
  return all.filter((source) => {
    if (seen.has(source.source_id ?? source.sourceId)) return false;
    seen.add(source.source_id ?? source.sourceId);
    return true;
  }).map((source) => ({
    source_id: source.source_id ?? source.sourceId,
    kind: source.kind,
    title: source.title,
    url: source.url ?? null,
    published_at: source.published_at ?? source.publishedAt ?? null,
    retrieved_at: source.retrieved_at ?? source.retrievedAt,
    snapshot_reference: source.snapshot_reference ?? source.snapshotReference ?? snapshot?.snapshotId ?? null
  }));
}

function normalizeRecommendation(rec, bufferMinutes = 15) {
  const result = deepCopy(rec);
  result.authorization_granted_by_report = false;
  if (result.relevant_deadline_utc) result.action_by_utc = actionByFromDeadline(result.relevant_deadline_utc, bufferMinutes);
  return result;
}

export function mergeReportPayload(newPayload, previousReport, { now = new Date().toISOString(), bufferMinutes = 15 } = {}) {
  const payload = deepCopy(newPayload);
  const existing = new Map((payload.recommendations || []).map((rec) => [rec.decision_key, normalizeRecommendation(rec, bufferMinutes)]));
  const retired = new Set(payload.retired_decision_keys || []);
  for (const previous of previousReport?.payload?.recommendations || []) {
    const expired = previous.expires_at && asUtc(previous.expires_at) <= asUtc(now);
    if (!expired && !retired.has(previous.decision_key) && !existing.has(previous.decision_key)) existing.set(previous.decision_key, normalizeRecommendation(previous, bufferMinutes));
  }
  payload.recommendations = [...existing.values()];
  payload.retired_decision_keys = [...retired];
  return payload;
}

export function createEnvelope(payload, { config, snapshot = null, sequence, supersedesReportId = null, now = new Date().toISOString(), jobType = "research" , extraSources = [] } = {}) {
  if (!STATUS.has(payload.status)) throw new Error(`Unsupported report status: ${payload.status}`);
  const generatedAt = isoUtc(now);
  const ageMinutes = ["pregame_coach", "inactive_watch", "inactive_followup"].includes(jobType) ? config.freshness.pregame_max_report_age_minutes : config.freshness.analyst_max_report_age_minutes;
  const generatedExpiry = isoUtc(asUtc(generatedAt).plus({ minutes: ageMinutes }));
  const recommendations = (payload.recommendations || []).map((rec) => normalizeRecommendation(rec, config.freshness.action_buffer_minutes));
  const deadlineExpiry = recommendations.flatMap((rec) => [rec.action_by_utc, rec.expires_at]).filter((value) => value && asUtc(value) > asUtc(generatedAt));
  const reportExpiry = minIso(generatedExpiry, ...deadlineExpiry) || generatedExpiry;
  const late = recommendations.some((rec) => rec.action_by_utc && asUtc(rec.action_by_utc) <= asUtc(generatedAt));
  const finalPayload = deepCopy({ ...payload, recommendations });
  if (late && finalPayload.status === "ACTIONABLE") {
    finalPayload.status = "ALERT_ONLY";
    finalPayload.human_summary = `Action window passed before publication. ${finalPayload.human_summary}`;
  }
  for (const rec of finalPayload.recommendations) if (!rec.expires_at || asUtc(rec.expires_at) > asUtc(reportExpiry)) rec.expires_at = reportExpiry;
  return {
    schema_version: "1.0",
    report_id: `report-${randomUUID()}`,
    sequence,
    supersedes_report_id: supersedesReportId,
    league_id: config.identity.league_id,
    team_id: config.identity.team_id,
    season: config.identity.season,
    scoring_period_id: snapshot?.league?.scoringPeriodId ?? null,
    generated_at: generatedAt,
    expires_at: reportExpiry,
    source_snapshot_at: snapshot?.collectedAt ?? null,
    relevant_state_hash: snapshot?.hashes?.combined ?? null,
    display_timezone: "America/Mexico_City",
    model: MODEL,
    reasoning_effort: REASONING_EFFORT,
    sources: makeSources(snapshot, extraSources),
    payload: finalPayload
  };
}

export function blockedReport({ config, snapshot = null, sequence, supersedesReportId = null, reason, scope = "research worker", now, extraSources = [] }) {
  const payload = emptyPayload("BLOCKED", `Research blocked: ${reason}`, scope, [reason]);
  return createEnvelope(payload, { config, snapshot, sequence, supersedesReportId, now, extraSources });
}

function markdown(value) { return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " "); }

export function renderMarkdown(report) {
  const lines = [
    `# Fantasy research report ${report.report_id}`,
    `- Status: **${report.payload.status}**`,
    `- League/team/period: ${report.league_id}/${report.team_id}/${report.scoring_period_id ?? "unknown"}`,
    `- Generated: ${report.generated_at} (${report.display_timezone})`,
    `- Expires: ${report.expires_at}`,
    `- Model: ${report.model} (${report.reasoning_effort})`,
    "",
    report.payload.human_summary,
    "",
    `## Scope\n${report.payload.scope}`,
    "",
    "## Decisions"
  ];
  if (!report.payload.recommendations.length) lines.push("No executable decisions in this report.");
  for (const rec of report.payload.recommendations) {
    lines.push(`### ${markdown(rec.decision_key)} — ${rec.type} / ${rec.research_state}`);
    lines.push(`- Priority: ${rec.priority}; confidence: ${rec.confidence}; horizon: ${rec.horizon}`);
    lines.push(`- ${markdown(rec.summary)}`);
    lines.push(`- Rationale: ${markdown(rec.rationale)}`);
    lines.push(`- Counterargument: ${markdown(rec.counterargument)}`);
    lines.push(`- Action by: ${rec.action_by_utc ?? "none"}; expires: ${rec.expires_at ?? "none"}`);
    if (rec.lineup_changes.length) lines.push(`- Lineup changes: ${rec.lineup_changes.map((change) => `${change.player_name} (${change.player_id}) ${change.from_slot_id}→${change.to_slot_id}`).join(", ")}`);
    if (rec.add_player_id !== null || rec.drop_player_id !== null) lines.push(`- Add/drop: ${rec.add_player_id ?? "none"} / ${rec.drop_player_id ?? "none"}`);
    if (rec.source_ids.length) lines.push(`- Evidence: ${rec.source_ids.map((sourceId) => `[${sourceId}](#source-${encodeURIComponent(sourceId)})`).join(", ")}`);
  }
  lines.push("", "## Findings");
  for (const finding of report.payload.findings) lines.push(`- ${markdown(finding.summary)}${finding.source_ids.length ? ` — ${finding.source_ids.join(", ")}` : ""}`);
  lines.push("", "## Risks and unknowns");
  for (const risk of report.payload.risks_and_unknowns) lines.push(`- ${markdown(risk)}`);
  lines.push("", "## Sources");
  for (const source of report.sources) {
    const href = source.url ? `[${markdown(source.title)}](${source.url})` : markdown(source.title);
    lines.push(`<a id="source-${encodeURIComponent(source.source_id)}"></a>`, `- **${source.source_id}** — ${href}; retrieved ${source.retrieved_at}`);
  }
  lines.push("", "## Complete JSON", "```json", JSON.stringify(report, null, 2), "```");
  return `${lines.join("\n")}\n`;
}

export function writeJsonAndMarkdown(report, reportsRoot) {
  const period = report.scoring_period_id ?? "unknown";
  const directory = path.join(reportsRoot, String(report.season), String(period));
  fs.mkdirSync(directory, { recursive: true });
  const jsonPath = path.join(directory, `${report.report_id}.json`);
  const markdownPath = path.join(directory, `${report.report_id}.md`);
  const latestPath = path.join(directory, "latest.json");
  return { directory, jsonPath, markdownPath, latestPath, json: JSON.stringify(report, null, 2), markdown: renderMarkdown(report) };
}
