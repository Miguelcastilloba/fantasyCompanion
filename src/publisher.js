import fs from "node:fs/promises";
import path from "node:path";
import { validateReport } from "./validation.js";
import { renderMarkdown, writeJsonAndMarkdown } from "./report.js";
import { DeadlineError, remainingMs } from "./deadline.js";

async function atomicWrite(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, contents, "utf8");
  await fs.rename(temporary, filePath);
}

function chunk(text, max = 1900) {
  const parts = [];
  for (let offset = 0; offset < text.length; offset += max) parts.push(text.slice(offset, offset + max));
  return parts;
}

export class DiscordPublisher {
  constructor({ store, config, fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) { this.store = store; this.config = config; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; }

  async deliver(report, { deadlineAt } = {}) {
    if (report.payload.status === "NO_ACTION") return { status: "suppressed", reason: "quiet NO_ACTION" };
    if (!this.config.publication.delivery.enabled) return { status: "disabled", reason: "delivery is disabled" };
    const webhook = this.config.publication.delivery.webhook;
    if (!webhook) throw new Error("DISCORD_WEBHOOK is required when delivery is enabled");
    const previous = this.store.delivery(report.report_id);
    if (previous?.status === "sent") return { status: "already_sent", providerReference: previous.provider_reference };
    const subject = `${this.config.publication.delivery.subject_prefix} | league=${report.league_id} | team=${report.team_id} | period=${report.scoring_period_id ?? "unknown"} | report=${report.report_id}`;
    const body = `${subject}\n\n${report.payload.human_summary}\n\n${JSON.stringify(report, null, 2)}`;
    this.store.setDelivery(report.report_id, { status: "sending", transport: "discord_webhook" });
    try {
      let response;
      for (const part of chunk(body)) {
        const remaining = remainingMs(deadlineAt);
        const requestTimeoutMs = remaining === null ? this.timeoutMs : Math.min(this.timeoutMs, remaining);
        if (requestTimeoutMs <= 0) throw new DeadlineError("Discord delivery", deadlineAt);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          response = await this.fetchImpl(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: part }), signal: controller.signal });
        } catch (error) {
          if (error?.name === "AbortError") {
            if (deadlineAt && Date.now() >= Number(deadlineAt)) throw new DeadlineError("Discord delivery", deadlineAt);
            throw new Error(`Discord delivery timed out after ${requestTimeoutMs}ms`);
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) throw new Error(`Discord webhook failed with HTTP ${response.status}`);
      }
      this.store.setDelivery(report.report_id, { status: "sent", transport: "discord_webhook", providerReference: response?.headers?.get?.("x-ratelimit-global") || "accepted" });
      return { status: "sent" };
    } catch (error) {
      this.store.setDelivery(report.report_id, { status: "failed", transport: "discord_webhook", error: error.message });
      throw error;
    }
  }
}

export class ReportPublisher {
  constructor({ store, config, delivery = null } = {}) { this.store = store; this.config = config; this.delivery = delivery; }

  async publish(report, snapshot = null, { now, deadlineAt } = {}) {
    const validation = validateReport(report, { schemaPath: this.config.paths.schema, snapshot, config: this.config, now });
    if (!validation.valid) throw new Error(`Report validation failed: ${validation.errors.join("; ")}`);
    const files = writeJsonAndMarkdown(report, this.config.paths.reports);
    await fs.mkdir(files.directory, { recursive: true });
    await atomicWrite(files.jsonPath, files.json);
    await atomicWrite(files.markdownPath, files.markdown);
    await atomicWrite(files.latestPath, files.json);
    this.store.insertReport(report);
    let delivery = { status: "not_configured" };
    if (this.delivery) {
      try { delivery = await this.delivery.deliver(report, { deadlineAt }); } catch (error) { delivery = { status: "failed", error: error.message }; }
    }
    return { report, files, delivery };
  }
}

export function reportFilePaths(report, reportsRoot) {
  const period = report.scoring_period_id ?? "unknown";
  return { json: path.join(reportsRoot, String(report.season), String(period), `${report.report_id}.json`), markdown: path.join(reportsRoot, String(report.season), String(period), `${report.report_id}.md`), latest: path.join(reportsRoot, String(report.season), String(period), "latest.json") };
}

export { renderMarkdown };
