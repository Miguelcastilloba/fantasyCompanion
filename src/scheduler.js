import { IDENTITY, PRIORITY } from "./constants.js";
import { asUtc, dueClockJobs, isoUtc } from "./time.js";

function key(config, period, jobType, eventId, occurrence) {
  return [config.identity.league_id, config.identity.team_id, config.identity.season, period ?? "unknown", jobType, eventId ?? "clock", occurrence].join(":");
}

export function eventJobs(snapshot, config, now = new Date().toISOString()) {
  if (config.schedule.fantasy_active_periods_only && snapshot?.league?.fantasyActive === false) return [];
  const nowDt = asUtc(now);
  const buffer = config.freshness.action_buffer_minutes;
  const jobs = [];
  for (const event of snapshot?.schedule || []) {
    const relevantTeamIds = new Set([
      ...(snapshot.ownTeam?.roster || []).map((player) => String(player.proTeamId ?? "")),
      ...(snapshot.availablePlayers || []).map((player) => String(player.proTeamId ?? player.proTeam ?? ""))
    ]);
    if (event.teams?.length && !event.teams.some((team) => relevantTeamIds.has(String(team.teamId)))) continue;
    const kickoff = asUtc(event.kickoffAtUtc);
    const offsets = [
      ["pregame_coach", config.schedule.event_jobs.pregame_coach.offset_minutes],
      ["inactive_watch", config.schedule.event_jobs.inactive_watch.offset_minutes],
      ["inactive_followup", config.schedule.event_jobs.inactive_followup.offset_minutes]
    ];
    for (const [jobType, offset] of offsets) {
      if (jobType === "inactive_followup" && event.unresolvedStatus !== true && event.materialChange !== true) continue;
      const scheduled = kickoff.plus({ minutes: Number(offset) });
      const safeCutoff = kickoff.minus({ minutes: buffer });
      if (scheduled <= nowDt && nowDt < safeCutoff) jobs.push({ jobType, eventId: event.eventId, scheduledAtUtc: isoUtc(scheduled), priority: PRIORITY[jobType] || 5, payload: { eventId: event.eventId, kickoffAtUtc: event.kickoffAtUtc, scope: jobType === "inactive_followup" ? "unresolved status or material change" : "relevant kickoff window" } });
    }
  }
  return jobs;
}

export function enqueueDueJobs({ store, config, snapshot = null, now = new Date().toISOString() } = {}) {
  if (snapshot && config.schedule.fantasy_active_periods_only && snapshot.league?.fantasyActive === false) return { considered: [], results: [], inserted: 0 };
  const period = snapshot?.league?.scoringPeriodId ?? null;
  const clock = dueClockJobs(config.schedule, now, config.schedule.timezone);
  const chosenClock = [];
  if (clock.length) {
    const preferred = ["weekly_lineup", "waiver_followup", "waiver_planner", "daily_scout"];
    const active = new Set(clock.map((item) => item.jobType));
    const chosen = preferred.find((jobType) => active.has(jobType)) || clock[0].jobType;
    chosenClock.push({ jobType: chosen, scheduledAtUtc: clock[0].scheduledAtUtc, eventId: null, priority: PRIORITY[chosen] || 5, payload: { localOccurrence: clock[0].localOccurrence, coalescedFrom: clock.map((item) => item.jobType) } });
  }
  const all = [...chosenClock, ...eventJobs(snapshot, config, now)];
  const results = all.map((job) => store.enqueueJob({ jobKey: key(config, period, job.jobType, job.eventId, job.scheduledAtUtc), jobType: job.jobType, payload: { ...job.payload, priority: job.priority }, availableAt: job.scheduledAtUtc }));
  return { considered: all, results, inserted: results.filter((item) => item.inserted).length };
}

export function bootstrapJob({ store, config, scoringPeriodId, now = new Date().toISOString() }) {
  const jobType = "bootstrap";
  const occurrence = isoUtc(now);
  return store.enqueueJob({ jobKey: key(config, scoringPeriodId, jobType, null, occurrence), jobType, payload: { scope: "current upcoming scoring period baseline" }, availableAt: occurrence });
}
