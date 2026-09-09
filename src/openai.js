import { isoUtc } from "./time.js";
import { MODEL, REASONING_EFFORT } from "./constants.js";
import { sha256 } from "./hash.js";

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
    const { input, purpose, structuredSchema = null, webSearch = true, overrides = {}, model, reasoning, reasoning_effort, max_output_tokens } = options;
    if (model || reasoning || reasoning_effort || max_output_tokens || overrides.model || overrides.reasoning || overrides.reasoning_effort || overrides.max_output_tokens) throw new LunaError("Request-level model, reasoning, or output overrides are blocked");
    if (!this.apiKey) throw new LunaError("OPENAI_API_KEY is not configured");
    const requestedAt = isoUtc();
    const outputBudget = purpose?.startsWith("specialist:")
      ? Math.min(this.maxOutputTokens, 6_000)
      : purpose === "research_editor"
        ? Math.min(this.maxOutputTokens, 12_000)
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
          reject(new LunaError(`OpenAI ${purpose || "request"} timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });
      await Promise.race([request, timeoutPromise]);
    } catch (error) {
      if (error?.name === "AbortError") throw new LunaError(`OpenAI ${purpose || "request"} timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    let json;
    try { json = JSON.parse(text); } catch { json = { error: { message: text } }; }
    if (!response.ok) throw new LunaError(`OpenAI ${purpose || "request"} failed with HTTP ${response.status}: ${json.error?.message || "unknown error"}`);
    if (json.status === "incomplete" || json.incomplete_details) throw new LunaError(`OpenAI ${purpose || "request"} returned incomplete output`);
    if ((json.output || []).some((item) => (item.content || []).some((content) => content.type === "refusal"))) throw new LunaRefusalError(`OpenAI ${purpose || "request"} refused the task`);
    const outputText = responseText(json);
    if (!outputText) throw new LunaError(`OpenAI ${purpose || "request"} returned no usable output`);
    return { text: outputText, raw: json, sources: extractSources(json, requestedAt), request: this.requestLog.at(-1) };
  }
}
