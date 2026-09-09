import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { DISPLAY_TIMEZONE, IDENTITY, MODEL, REASONING_EFFORT, STORAGE_TIMEZONE } from "./constants.js";

const DEFAULT_LEAGUE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/125290435?view=mTeam&view=mRoster";
const MAX_JOB_RUNTIME_MS = 900_000;
const MAX_LLM_REQUEST_MS = 300_000;
const MAX_ESPN_REQUEST_MS = 60_000;

function booleanEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function boundedMs(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function loadConfig(configPath = "config.yaml", { envPath = path.resolve(process.cwd(), ".env") } = {}) {
  dotenv.config({ path: envPath });
  const absoluteConfigPath = path.resolve(configPath);
  const raw = YAML.parse(fs.readFileSync(absoluteConfigPath, "utf8"));
  assertFixedConfiguration(raw);
  const root = path.dirname(absoluteConfigPath);
  const env = process.env;

  const config = {
    ...raw,
    paths: {
      database: path.resolve(root, env.FANTASY_DB_PATH || "data/fantasy-research.sqlite"),
      reports: path.resolve(root, raw.publication?.local_archive || "reports"),
      schema: path.resolve(root, "report.schema.json"),
      prompts: path.resolve(root, "prompts")
    },
    espn: {
      leagueUrl: env.ESPN_LEAGUE_URL || DEFAULT_LEAGUE_URL,
      scheduleUrl: env.ESPN_SCHEDULE_URL || null,
      s2: env.ESPN_S2 || env.espn_s2 || null,
      swid: env.ESPN_SWID || env.SWID || null,
      timeoutMs: boundedMs(env.FANTASY_ESPN_TIMEOUT_MS || raw.espn?.request_timeout_ms, 60_000, MAX_ESPN_REQUEST_MS)
    },
    llm: {
      ...raw.llm,
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      apiKey: booleanEnv(env.FANTASY_DISABLE_LLM, false) ? null : (env.OPENAI_API_KEY || null),
      endpoint: env.OPENAI_API_ENDPOINT || "https://api.openai.com/v1/responses",
      timeoutMs: boundedMs(env.FANTASY_LLM_TIMEOUT_MS || raw.llm.request_timeout_ms, 300_000, MAX_LLM_REQUEST_MS)
    },
    publication: {
      ...raw.publication,
      delivery: {
        ...raw.publication?.delivery,
        enabled: Boolean(raw.publication?.delivery?.enabled) && booleanEnv(env.DELIVERY_ENABLED, false),
        webhook: env.DISCORD_WEBHOOK || null
      }
    },
    orchestration: {
      ...raw.orchestration,
      jobTimeoutMs: boundedMs(env.FANTASY_JOB_TIMEOUT_MS || (Number(raw.orchestration?.max_job_runtime_seconds || 900) * 1000), MAX_JOB_RUNTIME_MS, MAX_JOB_RUNTIME_MS)
    },
    timezone: DISPLAY_TIMEZONE,
    storageTimezone: STORAGE_TIMEZONE
  };
  return config;
}

export function assertFixedConfiguration(config) {
  const identity = config?.identity;
  if (!identity || Number(identity.league_id) !== IDENTITY.leagueId || Number(identity.team_id) !== IDENTITY.teamId || Number(identity.season) !== IDENTITY.season) {
    throw new Error(`Configuration must target league=${IDENTITY.leagueId}, team=${IDENTITY.teamId}, season=${IDENTITY.season}`);
  }
  if (config?.llm?.model !== MODEL || config?.llm?.reasoning?.effort !== REASONING_EFFORT) {
    throw new Error(`Only ${MODEL} with reasoning effort ${REASONING_EFFORT} is supported`);
  }
  if (config?.llm?.allow_model_fallback !== false || config?.llm?.allow_effort_downgrade !== false) {
    throw new Error("Model fallback and reasoning-effort downgrade must remain disabled");
  }
  if (config?.permissions?.espn_mode !== "read_only" || config?.permissions?.generic_http_tool !== false || config?.permissions?.shell_tool !== false || config?.permissions?.espn_mutation_tools !== false) {
    throw new Error("Unsafe source or model permissions are not supported");
  }
  if (config?.schedule?.timezone !== DISPLAY_TIMEZONE || config?.identity?.display_timezone !== DISPLAY_TIMEZONE) {
    throw new Error(`Scheduler and display timezone must be ${DISPLAY_TIMEZONE}`);
  }
}

export { DEFAULT_LEAGUE_URL };
