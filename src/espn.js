import { randomUUID } from "node:crypto";
import { DISPLAY_TIMEZONE, IDENTITY } from "./constants.js";
import { displayTime, isoUtc } from "./time.js";
import { sha256 } from "./hash.js";
import { DeadlineError, remainingMs } from "./deadline.js";

const LEAGUE_HOST = "lm-api-reads.fantasy.espn.com";
const SCHEDULE_HOSTS = new Set(["site.api.espn.com", "site.web.api.espn.com"]);
const LEAGUE_PATH = /^\/apis\/v3\/games\/ffl\/seasons\/(\d+)\/segments\/0\/leagues\/(\d+)$/;

export function assertAllowedReadUrl(rawUrl, kind = "league") {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("ESPN URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("ESPN adapter only permits HTTPS");
  if (kind === "league") {
    if (url.hostname !== LEAGUE_HOST) throw new Error("ESPN league host is not allowlisted");
    const match = url.pathname.match(LEAGUE_PATH);
    if (!match || Number(match[1]) !== IDENTITY.season || Number(match[2]) !== IDENTITY.leagueId) throw new Error("ESPN league path is not allowlisted");
    for (const view of url.searchParams.getAll("view")) {
      if (!new Set(["mTeam", "mRoster", "mSettings", "mSchedule", "kona_player_info"]).has(view)) throw new Error(`ESPN view is not allowlisted: ${view}`);
    }
  } else if (kind === "schedule") {
    if (!SCHEDULE_HOSTS.has(url.hostname) || !url.pathname.startsWith("/apis/site/v2/sports/football/nfl/scoreboard")) throw new Error("ESPN schedule endpoint is not allowlisted");
  } else {
    throw new Error(`Unknown ESPN read kind: ${kind}`);
  }
  return url;
}

function numberOrNull(value) {
  const result = Number(value);
  return Number.isInteger(result) ? result : null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.length ? value : null;
}

function normalizeTeam(team, { own = false } = {}) {
  const rosterEntries = team?.roster?.entries;
  const roster = Array.isArray(rosterEntries) ? rosterEntries.map((entry) => {
    const player = entry?.playerPoolEntry?.player || entry?.player || {};
    const playerId = numberOrNull(player.id ?? entry.playerId);
    return {
      playerId,
      name: stringOrNull(player.fullName ?? player.name) || (playerId === null ? "Unknown player" : `Player ${playerId}`),
      positionId: numberOrNull(player.defaultPositionId),
      proTeamId: numberOrNull(player.proTeamId),
      slotId: numberOrNull(entry.lineupSlotId),
      eligibleSlotIds: Array.isArray(player.eligibleSlots) ? player.eligibleSlots.map(Number).filter(Number.isInteger) : [],
      injuryStatus: stringOrNull(player.injuryStatus),
      injured: player.injured === true,
      ownership: player.ownership ? { percentOwned: player.ownership.percentOwned ?? null } : null,
      acquisitionType: stringOrNull(entry.acquisitionType),
      lockAtUtc: stringOrNull(entry.lockAtUtc ?? player.lockAtUtc),
      kickoffAtUtc: stringOrNull(entry.kickoffAtUtc ?? player.kickoffAtUtc)
    };
  }) : null;
  return {
    teamId: numberOrNull(team?.id),
    teamName: stringOrNull(team?.name ?? team?.location ?? team?.abbrev) || `Team ${team?.id ?? "unknown"}`,
    isOwn: own,
    roster
  };
}

export function normalizeSchedule(raw, collectedAt = isoUtc()) {
  const events = Array.isArray(raw?.events) ? raw.events : Array.isArray(raw) ? raw : null;
  if (!events) return { events: [], missingFields: ["schedule.events"] };
  const normalized = [];
  for (const event of events) {
    const competition = event?.competitions?.[0] || event?.competition || event;
    const kickoff = event?.date ?? competition?.date ?? event?.kickoffAtUtc;
    if (!kickoff) continue;
    const kickoffAtUtc = isoUtc(kickoff);
    const teams = Array.isArray(competition?.competitors) ? competition.competitors.map((item) => ({ teamId: stringOrNull(item?.team?.id ?? item?.id), abbreviation: stringOrNull(item?.team?.abbreviation ?? item?.abbreviation) })) : [];
    normalized.push({
      eventId: String(event?.id ?? competition?.id ?? sha256(`${kickoffAtUtc}:${JSON.stringify(teams)}`).slice(0, 16)),
      kickoffAtUtc,
      kickoffDisplay: displayTime(kickoffAtUtc, DISPLAY_TIMEZONE),
      lockAtUtc: stringOrNull(event?.lockAtUtc ?? competition?.lockAtUtc),
      teams,
      sourceRetrievedAt: collectedAt
    });
  }
  return { events: normalized, missingFields: normalized.length ? [] : ["schedule.events"] };
}

function getScoringPeriod(status, raw) {
  return numberOrNull(status?.currentScoringPeriod ?? status?.currentMatchupPeriod ?? status?.currentPeriod ?? raw?.scoringPeriodId);
}

export function normalizeAvailablePlayers(rawPlayers) {
  if (!Array.isArray(rawPlayers)) return null;
  return rawPlayers.filter((entry) => entry?.onTeamId === null || entry?.onTeamId === undefined).map((entry) => {
    const player = entry.player || {};
    return {
      playerId: numberOrNull(entry.id ?? player.id),
      name: stringOrNull(player.fullName ?? player.name) || `Player ${entry.id ?? player.id ?? "unknown"}`,
      positionId: numberOrNull(player.defaultPositionId),
      proTeamId: numberOrNull(player.proTeamId),
      eligibleSlotIds: Array.isArray(player.eligibleSlots) ? player.eligibleSlots.map(Number).filter(Number.isInteger) : [],
      injuryStatus: stringOrNull(player.injuryStatus),
      injured: player.injured === true,
      stats: player.stats ?? null,
      droppable: entry.droppable ?? player.droppable ?? null,
      lineupLocked: entry.lineupLocked ?? null,
      rosterLocked: entry.rosterLocked ?? null,
      lockAtUtc: stringOrNull(entry.lockAtUtc ?? player.lockAtUtc),
      rosteredBy: null
    };
  }).filter((player) => player.playerId !== null);
}

export function normalizeLeagueResponse(raw, { collectedAt = isoUtc(), schedule = null, leagueUrl = null } = {}) {
  const missingFields = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ESPN response is not a JSON object");
  const status = raw.status;
  if (!status || typeof status !== "object") missingFields.push("league.status");
  const scoringPeriodId = getScoringPeriod(status, raw);
  if (scoringPeriodId === null) missingFields.push("scoring_period_id");
  const teams = raw.teams;
  if (!Array.isArray(teams)) missingFields.push("teams");
  const ownRaw = Array.isArray(teams) ? teams.find((team) => numberOrNull(team?.id) === IDENTITY.teamId) : null;
  if (!ownRaw) missingFields.push("own_team");
  const ownTeam = normalizeTeam(ownRaw, { own: true });
  if (!Array.isArray(ownTeam.roster)) missingFields.push("own_roster");
  const settings = raw.settings;
  if (!settings || typeof settings !== "object") missingFields.push("league.settings");
  const rosterSettings = settings?.rosterSettings;
  const scoringSettings = settings?.scoringSettings;
  if (!rosterSettings || typeof rosterSettings !== "object") missingFields.push("roster_rules");
  if (!scoringSettings || typeof scoringSettings !== "object") missingFields.push("scoring_rules");
  const acquisitionSettings = settings?.acquisitionSettings;
  if (!acquisitionSettings || typeof acquisitionSettings !== "object") missingFields.push("waiver_rules");
  const normalizedSchedule = schedule ? normalizeSchedule(schedule, collectedAt) : { events: [], missingFields: ["schedule.events"] };
  missingFields.push(...normalizedSchedule.missingFields);
  const opponents = Array.isArray(teams) ? teams.filter((team) => numberOrNull(team?.id) !== IDENTITY.teamId).map((team) => normalizeTeam(team)) : [];
  const availablePlayers = Array.isArray(raw.availablePlayers) ? raw.availablePlayers : null;
  if (!availablePlayers) missingFields.push("available_players");
  const waiverState = raw.waiverState ?? settings?.waiverSettings ?? null;
  if (!waiverState) missingFields.push("waiver_state");
  const injuries = Array.isArray(raw.injuryReports) ? raw.injuryReports : [];
  if (!injuries.length) missingFields.push("official_injury_and_inactive_reports");
  const lockRulesKnown = Boolean((ownTeam.roster || []).some((player) => player.lockAtUtc) || normalizedSchedule.events.some((event) => event.lockAtUtc));
  if (!lockRulesKnown) missingFields.push("verified_lock_rules");

  const allRostered = [ownTeam, ...opponents].flatMap((team) => team.roster || []);
  const allPlayers = [...allRostered, ...(availablePlayers || [])];
  const playerById = Object.fromEntries(allPlayers.filter((player) => numberOrNull(player.playerId ?? player.id) !== null).map((player) => {
    const playerId = numberOrNull(player.playerId ?? player.id);
    return [playerId, player.playerId === undefined ? { ...player, playerId } : player];
  }));

  const rules = {
    scoring: scoringSettings || null,
    roster: rosterSettings || null,
    acquisition: acquisitionSettings || null,
    waiver: waiverState,
    protectedPlayers: raw.protectedPlayers ?? null,
    known: missingFields.every((field) => !["roster_rules", "scoring_rules", "waiver_rules", "waiver_state"].includes(field))
  };
  const snapshotId = `snapshot-${randomUUID()}`;
  const normalized = {
    snapshotId,
    collectedAt: isoUtc(collectedAt),
    displayTimezone: DISPLAY_TIMEZONE,
    league: {
      leagueId: numberOrNull(raw.id) ?? IDENTITY.leagueId,
      season: numberOrNull(raw.seasonId) ?? IDENTITY.season,
      scoringPeriodId,
      matchupPeriodId: numberOrNull(status?.currentMatchupPeriod),
      fantasyActive: status?.isActive !== false && status?.finalScoringPeriod !== scoringPeriodId,
      status: {
        isActive: status?.isActive ?? null,
        currentScoringPeriod: scoringPeriodId,
        currentMatchupPeriod: numberOrNull(status?.currentMatchupPeriod)
      }
    },
    rules,
    ownTeam,
    opponents,
    availablePlayers: availablePlayers || [],
    schedule: normalizedSchedule.events,
    injuries,
    recentActivity: Array.isArray(raw.recentActivity) ? raw.recentActivity : [],
    pendingClaims: Array.isArray(raw.pendingClaims) ? raw.pendingClaims : [],
    playerById,
    missingFields: [...new Set(missingFields)],
    sources: [{ sourceId: "ESPN_LEAGUE_READ", kind: "ESPN_READ", title: "ESPN fantasy league read", url: leagueUrl, publishedAt: null, retrievedAt: isoUtc(collectedAt), snapshotReference: snapshotId }]
  };
  normalized.rules.lockRulesKnown = lockRulesKnown;
  normalized.rules.claimDeadlineKnown = Boolean(waiverState?.claimDeadlineUtc ?? waiverState?.claimDeadline ?? waiverState?.deadlineUtc);
  const rulesMaterial = { league: normalized.league, rules: normalized.rules };
  normalized.hashes = {
    rules: sha256(rulesMaterial),
    ownRoster: sha256(normalized.ownTeam.roster || []),
    pendingClaimsBudget: sha256({ pendingClaims: normalized.pendingClaims, waiver: normalized.rules.waiver }),
    affectedAvailability: sha256(normalized.availablePlayers),
    combined: sha256({ rules: rulesMaterial, ownRoster: normalized.ownTeam.roster || [], pendingClaims: normalized.pendingClaims, available: normalized.availablePlayers })
  };
  normalized.criticalMissing = normalized.missingFields.filter((field) => ["scoring_period_id", "own_team", "own_roster", "roster_rules", "scoring_rules"].includes(field));
  return normalized;
}

export class EspnReadAdapter {
  constructor({ config, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async getJson(rawUrl, kind, { deadlineAt } = {}) {
    const url = assertAllowedReadUrl(rawUrl, kind);
    const controller = new AbortController();
    const remaining = remainingMs(deadlineAt);
    const requestTimeoutMs = remaining === null ? this.timeoutMs : Math.min(this.timeoutMs, remaining);
    if (requestTimeoutMs <= 0) throw new DeadlineError(`ESPN ${kind} read`, deadlineAt);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const headers = { Accept: "application/json", "User-Agent": "fantasy-companion/1.0 read-only" };
      if (this.config.espn.s2 && this.config.espn.swid) headers.Cookie = `espn_s2=${this.config.espn.s2}; SWID=${this.config.espn.swid}`;
      const response = await this.fetchImpl(url, { method: "GET", headers, signal: controller.signal });
      if (!response.ok) throw new Error(`ESPN ${kind} read failed with HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError" && deadlineAt && Date.now() >= Number(deadlineAt)) throw new DeadlineError(`ESPN ${kind} read`, deadlineAt);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async readSnapshot({ deadlineAt } = {}) {
    const collectedAt = isoUtc();
    let league = await this.getJson(this.config.espn.leagueUrl, "league", { deadlineAt });
    if (!league.settings?.rosterSettings || !league.settings?.scoringSettings) {
      const settingsUrl = new URL(this.config.espn.leagueUrl);
      settingsUrl.searchParams.delete("view");
      settingsUrl.searchParams.append("view", "mSettings");
      const settingsResponse = await this.getJson(settingsUrl.toString(), "league", { deadlineAt });
      league = { ...league, settings: settingsResponse.settings || league.settings };
    }
    if (!Array.isArray(league.availablePlayers)) {
      try {
        const playersUrl = new URL(this.config.espn.leagueUrl);
        playersUrl.searchParams.delete("view");
        playersUrl.searchParams.append("view", "kona_player_info");
        const playersResponse = await this.getJson(playersUrl.toString(), "league", { deadlineAt });
        league = { ...league, availablePlayers: normalizeAvailablePlayers(playersResponse.players) };
      } catch (error) {
        if (error?.code === "DEADLINE_EXCEEDED") throw error;
        // Availability remains explicitly missing; the worker will block dependent acquisitions.
      }
    }
    const schedule = this.config.espn.scheduleUrl ? await this.getJson(this.config.espn.scheduleUrl, "schedule", { deadlineAt }) : null;
    return normalizeLeagueResponse(league, { collectedAt, schedule, leagueUrl: this.config.espn.leagueUrl });
  }
}

export class ReadOnlyToolRegistry {
  constructor({ adapter, snapshot }) {
    this.adapter = adapter;
    this.snapshot = snapshot;
  }

  list() {
    return ["get_league_settings", "get_team_roster", "get_opponent_roster", "get_available_players", "get_player_usage_and_projections", "get_nfl_schedule", "get_injury_and_inactive_reports", "get_waiver_state", "get_recent_activity", "get_previous_reports", "get_execution_receipts"];
  }

  invoke(name) {
    if (!this.list().includes(name)) throw new Error(`Read-only tool blocked: ${name}`);
    const source = {
      get_league_settings: () => this.snapshot.rules,
      get_team_roster: () => this.snapshot.ownTeam,
      get_opponent_roster: () => this.snapshot.opponents,
      get_available_players: () => this.snapshot.availablePlayers,
      get_player_usage_and_projections: () => this.snapshot.playerById,
      get_nfl_schedule: () => this.snapshot.schedule,
      get_injury_and_inactive_reports: () => this.snapshot.injuries,
      get_waiver_state: () => this.snapshot.rules.waiver,
      get_recent_activity: () => this.snapshot.recentActivity,
      get_previous_reports: () => [],
      get_execution_receipts: () => []
    }[name];
    return source();
  }
}
