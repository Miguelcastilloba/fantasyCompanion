import { isoUtc } from "./time.js";
import { MODEL, REASONING_EFFORT } from "./constants.js";
import { sha256 } from "./hash.js";
import { DeadlineError, remainingMs } from "./deadline.js";

export class LunaError extends Error {}
export class LunaRefusalError extends LunaError {}

function responseText(response) {
  if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
  const chunks = [];
  for (const item of response.output || []) for (const content of item.content || []) if (content.type === "output_text" && content.text) chunks.push(content.text);
  return chunks.join("\n").trim();
}

function extractSources(response, retrievedAt) {
  const sources = [];
  for (const item of response.output || []) for (const content of item.content || []) for (const annotation of content.annotations || []) {
    if (annotation.type !== "url_citation" || !annotation.url) continue;
    const sourceId = `WEB_${sha256(annotation.url).slice(0, 12)}`;
    sources.push({ source_id: sourceId, kind: "ORIGINAL_REPORTING", title: annotation.title || annotation.url, url: annotation.url, published_at: null, retrieved_at: retrievedAt, snapshot_reference: null });
  }
  return sources;
}

export class LunaClient {
  constructor({ apiKey, endpoint = "https://api.openai.com/v1/responses", fetchImpl = globalThis.fetch, maxOutputTokens = 24_000, timeoutMs = 180_000 } = {}) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.requestLog = [];
  }

  async call(options = {}) {
    const { input, purpose, structuredSchema = null, webSearch = true, overrides = {}, model, reasoning, reasoning_effort, max_output_tokens, deadlineAt } = options;
    if (model || reasoning || reasoning_effort || max_output_tokens || overrides.model || overrides.reasoning || overrides.reasoning_effort || overrides.max_output_tokens) throw new LunaError("Request-level model, reasoning, or output overrides are blocked");
    if (!this.apiKey) throw new LunaError("OPENAI_API_KEY is not configured");
    const requestedAt = isoUtc();
    const outputBudget = purpose?.startsWith("specialist:")
      ? Math.min(this.maxOutputTokens, 20_000)
      : purpose === "research_editor"
        ? Math.min(this.maxOutputTokens, 24_000)
        : this.maxOutputTokens;
    const body = {
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      input,
      max_output_tokens: outputBudget,
      store: false
    };
    if (webSearch) body.tools = [{ type: "web_search" }];
    if (structuredSchema) body.text = { format: { type: "json_schema", name: "report_payload", strict: true, schema: structuredSchema } };
    this.requestLog.push({ requestedAt, purpose, model: body.model, reasoning_effort: body.reasoning.effort, max_output_tokens: outputBudget });
    const controller = new AbortController();
    const remaining = remainingMs(deadlineAt);
    const requestTimeoutMs = remaining === null ? this.timeoutMs : Math.min(this.timeoutMs, remaining);
    if (requestTimeoutMs <= 0) throw new DeadlineError(`OpenAI ${purpose || "request"}`, deadlineAt);
    let timeout;
    let response;
    let text;
    try {
      const request = (async () => {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        text = await response.text();
        return response;
      })();
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          const error = new LunaError(`OpenAI ${purpose || "request"} timed out after ${requestTimeoutMs}ms`);
          error.code = "TIMEOUT";
          reject(error);
        }, requestTimeoutMs);
      });
      await Promise.race([request, timeoutPromise]);
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new LunaError(`OpenAI ${purpose || "request"} timed out after ${requestTimeoutMs}ms`);
        timeoutError.code = "TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { error: { message: text } }; }
    if (!response.ok) {
      const message = `OpenAI ${purpose || "request"} failed with HTTP ${response.status}: ${json.error?.message || "unknown error"}`;
      if (response.status === 429) {
        const retryAfterMsHeader = Number(response.headers.get("retry-after-ms"));
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        const retryAfterMs = Number.isFinite(retryAfterMsHeader) && retryAfterMsHeader > 0
          ? retryAfterMsHeader
          : Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 15_000;
        const error = new LunaError(message);
        error.code = "RATE_LIMITED";
        error.retryAfterMs = Math.min(Math.max(retryAfterMs, 1_000), 120_000);
        throw error;
      }
      throw new LunaError(message);
    }
    if (json.status === "incomplete" || json.incomplete_details) {
      const detail = typeof json.incomplete_details === "string"
        ? json.incomplete_details
        : json.incomplete_details?.reason || null;
      throw new LunaError(`OpenAI ${purpose || "request"} returned incomplete output${detail ? ` (${detail})` : ""}`);
    }
    if ((json.output || []).some((item) => (item.content || []).some((content) => content.type === "refusal"))) throw new LunaRefusalError(`OpenAI ${purpose || "request"} refused the task`);
    const outputText = responseText(json);
    if (!outputText) throw new LunaError(`OpenAI ${purpose || "request"} returned no usable output`);
    return { text: outputText, raw: json, sources: extractSources(json, requestedAt), request: this.requestLog.at(-1) };
  }
}
