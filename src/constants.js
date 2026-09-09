export const MODEL = "gpt-5.6-luna";
export const REASONING_EFFORT = "xhigh";
export const DISPLAY_TIMEZONE = "America/Mexico_City";
export const STORAGE_TIMEZONE = "UTC";
export const IDENTITY = Object.freeze({ leagueId: 125290435, teamId: 2, season: 2026 });

export const READ_TOOL_NAMES = Object.freeze([
  "get_league_settings",
  "get_team_roster",
  "get_opponent_roster",
  "get_available_players",
  "get_player_usage_and_projections",
  "get_nfl_schedule",
  "get_injury_and_inactive_reports",
  "get_waiver_state",
  "get_recent_activity",
  "get_previous_reports",
  "get_execution_receipts"
]);

export const ROLE_FOR_JOB = Object.freeze({
  daily_scout: "01_daily_scout.md",
  waiver_planner: "02_waiver_planner.md",
  waiver_followup: "03_waiver_followup.md",
  weekly_lineup: "04_weekly_lineup.md",
  pregame_coach: "05_pregame_coach.md",
  inactive_watch: "06_inactive_watch.md",
  inactive_followup: "06_inactive_watch.md",
  research_editor: "07_research_editor.md",
  bootstrap: "04_weekly_lineup.md"
});

export const PRIORITY = Object.freeze({ inactive_watch: 1, inactive_followup: 1, pregame_coach: 2, waiver_planner: 3, waiver_followup: 3, weekly_lineup: 4, daily_scout: 5, bootstrap: 2 });
