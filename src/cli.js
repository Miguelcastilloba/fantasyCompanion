#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { EspnReadAdapter, normalizeLeagueResponse } from "./espn.js";
import { LunaClient } from "./openai.js";
import { ReportPublisher, DiscordPublisher } from "./publisher.js";
import { enqueueDueJobs, bootstrapJob } from "./scheduler.js";
import { validateReportFile } from "./validation.js";
import { loadFixture, workerOnce } from "./orchestrator.js";

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) result._.push(item);
    else if (item.includes("=")) { const [key, ...rest] = item.slice(2).split("="); result[key] = rest.join("="); }
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) result[item.slice(2)] = argv[++i];
    else result[item.slice(2)] = true;
  }
  return result;
}

function services(config) {
  const store = new Store(config.paths.database);
  const adapter = new EspnReadAdapter({ config });
  const luna = config.llm.apiKey ? new LunaClient({ apiKey: config.llm.apiKey, endpoint: config.llm.endpoint, maxOutputTokens: config.llm.max_output_tokens, timeoutMs: config.llm.timeoutMs }) : null;
  const delivery = new DiscordPublisher({ store, config });
  const publisher = new ReportPublisher({ store, config, delivery });
  return { store, adapter, luna, publisher };
}

async function readSnapshot(config, fixturePath, adapter) {
  return fixturePath ? loadFixture(fixturePath, { normalize: normalizeLeagueResponse }) : adapter.readSnapshot();
}

async function main(argv) {
  const parsed = args(argv);
  const command = parsed._[0];
  if (!command) throw new Error("Usage: fantasy-research <tick|bootstrap|worker|dry-run|validate-report> --config config.yaml");
  if (command === "validate-report") {
    const reportPath = parsed._[1];
    if (!reportPath) throw new Error("validate-report requires a report path");
    const config = loadConfig(parsed.config || "config.yaml");
    const result = validateReportFile(reportPath, { schemaPath: config.paths.schema, config });
    if (!result.valid) { console.error(result.errors.join("\n")); process.exitCode = 1; } else console.log("VALID");
    return;
  }
  const config = loadConfig(parsed.config || "config.yaml");
  const { store, adapter, luna, publisher } = services(config);
  try {
    if (command === "tick") {
      const snapshot = store.latestSnapshot();
      const result = enqueueDueJobs({ store, config, snapshot, now: parsed.now || new Date().toISOString() });
      console.log(JSON.stringify({ command, ...result }, null, 2));
    } else if (command === "bootstrap") {
      const snapshot = await readSnapshot(config, parsed.fixture, adapter);
      store.saveSnapshot(snapshot);
      const job = bootstrapJob({ store, config, scoringPeriodId: snapshot.league.scoringPeriodId, now: parsed.now || new Date().toISOString() });
      console.log(JSON.stringify({ command, snapshotId: snapshot.snapshotId, scoringPeriodId: snapshot.league.scoringPeriodId, missingFields: snapshot.missingFields, job }, null, 2));
    } else if (command === "dry-run") {
      const snapshot = await readSnapshot(config, parsed.fixture || path.resolve("fixtures/sample-league.json"), adapter);
      store.saveSnapshot(snapshot);
      const job = bootstrapJob({ store, config, scoringPeriodId: snapshot.league.scoringPeriodId, now: parsed.now || new Date().toISOString() });
      if (parsed.live_llm) console.log(JSON.stringify(await workerOnce({ store, config, adapter, luna, publisher, fixture: parsed.fixture, now: parsed.now || new Date().toISOString() }), null, 2));
      else console.log(JSON.stringify({ command, delivery: "disabled", llm: "not called", snapshotId: snapshot.snapshotId, missingFields: snapshot.missingFields, job }, null, 2));
    } else if (command === "worker") {
      const once = Boolean(parsed.once);
      do {
        const result = await workerOnce({ store, config, adapter, luna, publisher, fixture: parsed.fixture, now: parsed.now || new Date().toISOString() });
        console.log(JSON.stringify({ command, ...result }, null, 2));
        if (once) break;
        await new Promise((resolve) => setTimeout(resolve, Number(config.schedule.scheduler_tick_seconds || 60) * 1000));
      } while (true);
    } else throw new Error(`Unknown command: ${command}`);
  } finally { store.close(); }
}

main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
