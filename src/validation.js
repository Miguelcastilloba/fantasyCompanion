import fs from "node:fs";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { IDENTITY, MODEL, REASONING_EFFORT } from "./constants.js";
import { actionByFromDeadline, asUtc, isoUtc } from "./time.js";

export function createValidator(schemaPath) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return { schema, validate };
}

function sourceIdsInRecommendation(recommendation) {
  const ids = [...(recommendation.source_ids || [])];
  for (const precondition of recommendation.preconditions || []) ids.push(...(precondition.source_ids || []));
  for (const alternative of recommendation.alternatives || []) ids.push(...(alternative.source_ids || []));
  return ids;
}

function playerMap(snapshot) {
  const map = new Map();
  for (const player of snapshot?.ownTeam?.roster || []) if (Number.isInteger(player.playerId)) map.set(player.playerId, { ...player, rosteredBy: IDENTITY.teamId });
  for (const team of snapshot?.opponents || []) for (const player of team.roster || []) if (Number.isInteger(player.playerId)) map.set(player.playerId, { ...player, rosteredBy: team.teamId });
  for (const [key, player] of Object.entries(snapshot?.playerById || {})) if (!map.has(Number(key))) map.set(Number(key), { ...player, playerId: Number(key), rosteredBy: player.rosteredBy ?? null });
  for (const player of snapshot?.availablePlayers || []) if (Number.isInteger(player.playerId ?? player.id)) map.set(Number(player.playerId ?? player.id), { ...player, playerId: Number(player.playerId ?? player.id), rosteredBy: null });
  return map;
}

export function semanticErrors(report, snapshot, config, { now = new Date().toISOString() } = {}) {
  const errors = [];
  if (report.league_id !== IDENTITY.leagueId || report.team_id !== IDENTITY.teamId || report.season !== IDENTITY.season) errors.push("report identity does not match the configured league/team/season");
  if (report.model !== MODEL || report.reasoning_effort !== REASONING_EFFORT) errors.push("report model metadata is not Luna xhigh");
  if (report.display_timezone !== "America/Mexico_City") errors.push("report display timezone is invalid");
  if (asUtc(report.expires_at) <= asUtc(report.generated_at)) errors.push("report expires_at must be after generated_at");
  const sourceIds = new Set();
  for (const source of report.sources) {
    if (sourceIds.has(source.source_id)) errors.push(`duplicate source_id: ${source.source_id}`);
    sourceIds.add(source.source_id);
  }
  const snapshotHash = snapshot?.hashes?.combined ?? null;
  if (snapshot && report.relevant_state_hash !== snapshotHash) errors.push("report relevant_state_hash does not match the publication snapshot");
  if (snapshot && report.source_snapshot_at !== snapshot.collectedAt) errors.push("report source_snapshot_at does not match the publication snapshot");
  if (snapshot && report.scoring_period_id !== snapshot.league.scoringPeriodId) errors.push("report scoring_period_id is not the current ESPN scoring period");
  const available = new Set((snapshot?.availablePlayers || []).map((p) => Number(p.playerId ?? p.id)).filter(Number.isInteger));
  const rostered = new Set((snapshot?.ownTeam?.roster || []).map((p) => Number(p.playerId)).filter(Number.isInteger));
  const players = playerMap(snapshot);
  const decisions = new Set();
  for (const recommendation of report.payload.recommendations) {
    if (decisions.has(recommendation.decision_key)) errors.push(`duplicate decision_key: ${recommendation.decision_key}`);
    decisions.add(recommendation.decision_key);
    if (recommendation.authorization_granted_by_report !== false) errors.push(`${recommendation.decision_key} grants authorization`);
    for (const sourceId of sourceIdsInRecommendation(recommendation)) if (!sourceIds.has(sourceId)) errors.push(`${recommendation.decision_key} references unknown source ${sourceId}`);
    for (const playerId of recommendation.player_ids) if (snapshot && !players.has(playerId)) errors.push(`${recommendation.decision_key} references unknown player ${playerId}`);
    if (recommendation.add_player_id !== null) {
      if (snapshot && !available.has(recommendation.add_player_id)) errors.push(`${recommendation.decision_key} add target is not verified available`);
      if (recommendation.type !== "ADD_DROP" && recommendation.type !== "WAIVER_CLAIM") errors.push(`${recommendation.decision_key} has an add target but incompatible type`);
    }
    if (recommendation.drop_player_id !== null && snapshot && !rostered.has(recommendation.drop_player_id)) errors.push(`${recommendation.decision_key} drop target is not on the configured roster`);
    if (recommendation.type === "ADD_DROP" || recommendation.type === "WAIVER_CLAIM") {
      if (!snapshot?.rules?.known) errors.push(`${recommendation.decision_key} depends on unknown waiver/acquisition rules`);
      if (recommendation.add_player_id === null || recommendation.drop_player_id === null) errors.push(`${recommendation.decision_key} needs an exact add/drop pairing`);
      if (recommendation.type === "WAIVER_CLAIM" && !snapshot?.rules?.claimDeadlineKnown && !recommendation.relevant_deadline_utc) errors.push(`${recommendation.decision_key} has no verified claim deadline`);
    }
    if ((recommendation.type === "SET_LINEUP" || recommendation.lineup_changes.length > 0) && snapshot && !snapshot.rules.lockRulesKnown) errors.push(`${recommendation.decision_key} depends on unknown player lock rules`);
    if (recommendation.relevant_deadline_utc && recommendation.action_by_utc !== actionByFromDeadline(recommendation.relevant_deadline_utc, config.freshness.action_buffer_minutes)) errors.push(`${recommendation.decision_key} action_by_utc is not deadline minus the configured buffer`);
    if (recommendation.action_by_utc && asUtc(recommendation.action_by_utc) <= asUtc(now) && report.payload.status === "ACTIONABLE") errors.push(`${recommendation.decision_key} is actionable after its cutoff`);
    if (recommendation.expires_at && asUtc(recommendation.expires_at) > asUtc(report.expires_at)) errors.push(`${recommendation.decision_key} expires after the report`);
    if (recommendation.suggested_bid !== null && snapshot?.rules?.waiver) {
      const budget = snapshot.rules.waiver.remainingBudget ?? snapshot.rules.waiver.budgetRemaining;
      if (Number.isFinite(Number(budget)) && recommendation.suggested_bid > Number(budget)) errors.push(`${recommendation.decision_key} suggested bid exceeds remaining budget`);
    }
    for (const change of recommendation.lineup_changes) {
      const player = players.get(change.player_id);
      if (snapshot && !rostered.has(change.player_id)) errors.push(`${recommendation.decision_key} lineup player is not rostered`);
      if (player?.slotId !== undefined && player.slotId !== null && player.slotId !== change.from_slot_id) errors.push(`${recommendation.decision_key} lineup source slot is stale for player ${change.player_id}`);
      if (player?.eligibleSlotIds?.length && !player.eligibleSlotIds.includes(change.to_slot_id)) errors.push(`${recommendation.decision_key} lineup destination slot is not eligible for player ${change.player_id}`);
      if (player?.lockAtUtc && asUtc(player.lockAtUtc) <= asUtc(now) && change.from_slot_id !== change.to_slot_id) errors.push(`${recommendation.decision_key} moves a locked player ${change.player_id}`);
    }
    for (const alternative of recommendation.alternatives) if (alternative.player_id !== null && snapshot && !players.has(alternative.player_id)) errors.push(`${recommendation.decision_key} alternative references unknown player ${alternative.player_id}`);
  }
  for (const finding of report.payload.findings) for (const sourceId of finding.source_ids || []) if (!sourceIds.has(sourceId)) errors.push(`finding references unknown source ${sourceId}`);
  if (report.payload.status === "ACTIONABLE" && report.payload.recommendations.some((rec) => rec.research_state === "READY") && !report.source_snapshot_at) errors.push("actionable READY advice needs a source snapshot");
  if (new Set(report.payload.retired_decision_keys).size !== report.payload.retired_decision_keys.length) errors.push("retired_decision_keys contains duplicates");
  const allDecisionKeys = new Set(report.payload.recommendations.map((rec) => rec.decision_key));
  for (const recommendation of report.payload.recommendations) for (const dependency of recommendation.depends_on_decision_keys) if (!allDecisionKeys.has(dependency)) errors.push(`${recommendation.decision_key} depends on missing decision ${dependency}`);
  return errors;
}

export function validateReport(report, { schemaPath, snapshot = null, config = null, now } = {}) {
  const { validate } = createValidator(schemaPath);
  const validSchema = validate(report);
  const errors = validSchema ? [] : (validate.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  if (validSchema && config) errors.push(...semanticErrors(report, snapshot, config, { now }));
  return { valid: errors.length === 0, errors };
}

export function validateReportFile(reportPath, options) {
  return validateReport(JSON.parse(fs.readFileSync(reportPath, "utf8")), options);
}
