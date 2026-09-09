import fs from "node:fs/promises";
import { normalizeLeagueResponse } from "./espn.js";
import { LunaError } from "./openai.js";
import { buildEditorInput, buildSpecialistInput } from "./prompts.js";
import { blockedReport, createEnvelope, mergeReportPayload } from "./report.js";
import { validateReport } from "./validation.js";
import { DeadlineError, withDeadline } from "./deadline.js";

async function retry(label, attempts, operation, { deadlineAt } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(attempt); } catch (error) {
      lastError = error;
      if (error?.code === "TIMEOUT" || error?.code === "DEADLINE_EXCEEDED" || (deadlineAt && Date.now() >= Number(deadlineAt))) throw error;
    }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastError?.message || lastError}`);
}

export async function loadFixture(fixturePath, { normalize } = {}) {
  const raw = JSON.parse(await fs.readFile(fixturePath, "utf8"));
  if (raw.snapshotId && raw.hashes) return raw;
  if (!normalize) throw new Error("Fixture is raw ESPN JSON and no normalizer was supplied");
  return normalize(raw, { collectedAt: new Date().toISOString(), schedule: raw.scheduleFixture || null });
}

function reportIdentity(snapshot) { return { leagueId: snapshot?.league?.leagueId, teamId: 2, season: 2026, scoringPeriodId: snapshot?.league?.scoringPeriodId ?? null }; }

async function publishBlocked({ store, publisher, config, snapshot, reason, job, now, deadlineAt }) {
  const identity = reportIdentity(snapshot);
  const previous = store.latestReport(identity);
  const report = blockedReport({ config, snapshot, sequence: store.nextSequence(identity), supersedesReportId: previous?.report_id ?? null, reason, scope: `${job.job_type} research`, now });
  const result = await withDeadline("blocked report publication", deadlineAt, () => publisher.publish(report, snapshot, { now, deadlineAt }));
  store.completeJob(job.id, now);
  return result;
}

export async function processJob({ job, store, config, adapter, luna, publisher, fixture = null, now = new Date().toISOString(), deadlineAt = Date.now() + Number(config.orchestration.jobTimeoutMs || 165_000) } = {}) {
  let snapshot;
  try {
    snapshot = fixture
      ? await withDeadline("fixture snapshot read", deadlineAt, () => loadFixture(fixture, { normalize: normalizeLeagueResponse }))
      : await withDeadline("ESPN snapshot read", deadlineAt, () => adapter.readSnapshot({ deadlineAt }));
    store.saveSnapshot(snapshot);
  } catch (error) {
    if (error?.code === "DEADLINE_EXCEEDED") throw error;
    store.failJob(job.id, error.message, { retry: false });
    return { status: "failed", error: error.message };
  }
  if (snapshot.criticalMissing.length) return publishBlocked({ store, publisher, config, snapshot, reason: `critical ESPN fields are missing: ${snapshot.criticalMissing.join(", ")}`, job, now, deadlineAt });
  if (!luna) return publishBlocked({ store, publisher, config, snapshot, reason: "OpenAI client is not configured for this worker", job, now, deadlineAt });

  const previous = store.latestReport(reportIdentity(snapshot));
  const attempts = 1 + Number(config.orchestration.bounded_retries || 0);
  let specialist;
  try {
    specialist = await retry("specialist research", attempts, () => withDeadline("specialist research", deadlineAt, () => luna.call({ input: buildSpecialistInput({ config, job, snapshot, previousReports: previous ? [previous] : [] }), purpose: `specialist:${job.job_type}`, webSearch: true, deadlineAt })), { deadlineAt });
  } catch (error) {
    if (error?.code === "DEADLINE_EXCEEDED") throw error;
    return publishBlocked({ store, publisher, config, snapshot, reason: error.message, job, now, deadlineAt });
  }
  const specialistResults = [{ job_type: job.job_type, output: specialist.text, sources: specialist.sources, request: specialist.request }];
  const editorSchema = JSON.parse(await fs.readFile(config.paths.schema, "utf8"));
  let editor;
  try {
    editor = await retry("research editor", attempts, async () => {
      const response = await withDeadline("research editor", deadlineAt, () => luna.call({ input: buildEditorInput({ config, job, snapshot, specialistResults, previousReports: previous ? [previous] : [] }), purpose: "research_editor", structuredSchema: editorSchema.$defs.ReportPayload, webSearch: true, deadlineAt }));
      try { return { ...response, payload: JSON.parse(response.text) }; } catch (error) { throw new LunaError(`structured editor output was not JSON: ${error.message}`); }
    }, { deadlineAt });
  } catch (error) {
    if (error?.code === "DEADLINE_EXCEEDED") throw error;
    return publishBlocked({ store, publisher, config, snapshot, reason: error.message, job, now, deadlineAt });
  }
  const payload = editor.payload;
  const mergedPayload = mergeReportPayload(payload, previous, { now });
  const identity = reportIdentity(snapshot);
  const report = createEnvelope(mergedPayload, { config, snapshot, sequence: store.nextSequence(identity), supersedesReportId: previous?.report_id ?? null, now, jobType: job.job_type, extraSources: editor.sources });
  const validation = validateReport(report, { schemaPath: config.paths.schema, snapshot, config, now });
  if (!validation.valid) return publishBlocked({ store, publisher, config, snapshot, reason: `editor report failed deterministic validation: ${validation.errors.join("; ")}`, job, now, deadlineAt });
  const result = await withDeadline("report publication", deadlineAt, () => publisher.publish(report, snapshot, { now, deadlineAt }));
  store.completeJob(job.id, now);
  return result;
}

export async function workerOnce({ store, config, adapter, luna, publisher, fixture = null, workerId = `worker-${process.pid}`, now = new Date().toISOString() } = {}) {
  const job = store.leaseNextJob({ workerId, now });
  if (!job) return { status: "idle" };
  const deadlineAt = Date.now() + Number(config.orchestration.jobTimeoutMs || 165_000);
  try { return await processJob({ job, store, config, adapter, luna, publisher, fixture, now, deadlineAt }); } catch (error) {
    const timedOut = error instanceof DeadlineError || error?.code === "DEADLINE_EXCEEDED";
    store.failJob(job.id, error.message, { retry: timedOut ? false : job.attempts < 1 + Number(config.orchestration.bounded_retries || 0) });
    return { status: timedOut ? "timed_out" : "failed", error: error.message };
  }
}

export function mockBlockedLuna() { return null; }
