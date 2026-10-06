// remote.js — the remote-lane client: one wire for every executor (2026-10).
//
// A remote executor is an endpoint with an auth class; this module is the
// single place a job becomes bytes on that wire. It speaks:
//   - OpenAI wire  (/v1/chat/completions)  — Groq, OpenRouter, LM Studio, llama.cpp, vLLM, LocalAI, …
//   - Ollama wire  (/api/chat)             — Ollama
//   - Puter SDK    (puter.ai)              — user-pays, in a browser
//
// Every call returns live observations — wall time, TTFT, tokens/sec, status,
// timeout — so executors.js can learn capacity instead of assuming it. A 429
// is learned as capacity, never as model failure. Timeouts are measured, never
// guessed.
//
// Pure-ish: network crossings take an injected fetch so tests can fake a lane.

import { probeInferenceAuth } from "./discovery.js";
import { joinBase } from "./url.js";
import { isHostedOpen } from "./hosted.js";
import { VERTEX_PATH, resolveKey } from "./vertex.js";

/** One completion on an OpenAI-compatible lane. Resolves
 *  { text, ms, ttft, tokens, status } or rejects { status, message, timedOut }.
 *  Streaming is optional; both paths measure. */

/** Normalize a provider's usage object to { input, output, cacheRead, cacheCreation } (all numbers or null). */
export function normUsage(u) {
  if (!u || typeof u !== "object") return null;
  const n = (v) => (Number.isFinite(+v) ? +v : null);
  const input = n(u.input_tokens ?? u.prompt_tokens);
  const output = n(u.output_tokens ?? u.completion_tokens);
  const cacheRead = n(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens);
  const cacheCreation = n(u.cache_creation_input_tokens);
  if (input == null && output == null) return null;
  return { input, output, cacheRead, cacheCreation };
}

/** Retry-After (seconds or an HTTP date) as milliseconds, or null. */
export function retryAfterMs(r) {
  const v = r?.headers?.get?.("retry-after");
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/** A non-2xx from a provider is a FAILURE the caller's ladder must see, never a
 *  returned empty success: it throws with the status, before the first token. */
async function refused(r, label = "provider") {
  const text = await r.text?.().catch(() => "") ?? "";
  return Object.assign(new Error(`${label} ${r.status}: ${String(text).slice(0, 200)}`), { status: r.status, timedOut: false, beforeFirstToken: true, retryAfterMs: retryAfterMs(r), bodyText: String(text) });
}

/** The total timeout joined with a FIRST-BYTE bound: `firstByte()` disarms the
 *  bound once the provider has answered. A provider that accepts and never
 *  speaks is cut at firstByteMs, not at the total. */
function boundSignal(timeoutMs, firstByteMs) {
  const total = AbortSignal.timeout(timeoutMs);
  if (!firstByteMs) return { signal: total, firstByte() {} };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new DOMException(`no first byte in ${firstByteMs}ms`, "TimeoutError")), firstByteMs);
  timer.unref?.();
  return { signal: AbortSignal.any([total, ac.signal]), firstByte() { clearTimeout(timer); } };
}

/** Models known to reject `temperature` (Anthropic: claude-sonnet-5 / 5-5, measured). Learned at runtime from the 400. */
const NO_TEMPERATURE = new Set();
const NO_TEMPERATURE_RE = /^claude-sonnet-5(-5)?(-|$)/;
export const rejectsTemperature = (model) => NO_TEMPERATURE.has(model) || NO_TEMPERATURE_RE.test(String(model));
export async function chatOpenAI({ base, model, key = null, messages = [], temperature = 0.7, maxTokens = 1024, stream = true, onToken = null, fetchImpl = fetch, timeoutMs = 120_000, firstByteMs = 0, signal = null, includeUsage = false, path = "/v1/chat/completions" } = {}) {
  const url = joinBase(base, path);
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const body = { model, messages, temperature, max_tokens: maxTokens, stream, ...(stream && includeUsage ? { stream_options: { include_usage: true } } : {}) };
  const t0 = Date.now();
  let ttft = null;
  let text = "";
  let tokens = 0;
  let buf = "";
  let status = null;
  let usage = null;
  const bound = boundSignal(timeoutMs, firstByteMs);
  try {
    const r = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([bound.signal, signal]) : bound.signal });
    status = r.status;
    if (!r.ok) throw await refused(r);
    if (!r.body) throw Object.assign(new Error(`${status}: empty body`), { status, timedOut: false, beforeFirstToken: true });
    if (!stream) {
      const j = await r.json();
      bound.firstByte();
      text = j.choices?.[0]?.message?.content ?? "";
      ttft = Date.now() - t0;
      return { text, ms: Date.now() - t0, ttft, tokens: j.usage?.completion_tokens ?? 0, status: 200, usage: normUsage(j.usage) };
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      bound.firstByte();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.usage) usage = normUsage(j.usage) || usage;
        const delta = j.choices?.[0]?.delta?.content;
        if (ttft == null) ttft = Date.now() - t0;
        if (typeof delta === "string" && delta) {
          text += delta;
          tokens++;
          onToken?.(delta);
        }
      }
    }
    return { text, ms: Date.now() - t0, ttft: ttft ?? Date.now() - t0, tokens, status: 200, usage };
  } catch (e) {
    // the CALLER cancelled (a race that was won elsewhere, a closed tab): not a timeout and not the lane's fault
    const aborted = !!signal?.aborted;
    const timedOut = !aborted && (e?.name === "TimeoutError" || /timed out|AbortError/i.test(String(e?.message || e?.name || "")));
    const err = Object.assign(new Error(aborted ? "cancelled by the caller" : (e?.message || "remote lane error")), { status, timedOut, aborted, beforeFirstToken: tokens === 0, retryAfterMs: e?.retryAfterMs ?? null });
    throw err;
  } finally { bound.firstByte(); }
}

/** One completion on an Ollama lane. */
export async function chatOllama({ base, model, key = null, messages = [], temperature = 0.7, maxTokens = 1024, onToken = null, fetchImpl = fetch, timeoutMs = 120_000, firstByteMs = 0 } = {}) {
  const url = `${String(base).replace(/\/+$/, "")}/api/chat`;
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const body = { model, messages, stream: true, options: { temperature, num_predict: maxTokens } };
  const t0 = Date.now();
  let ttft = null;
  let text = "";
  let tokens = 0;
  let buf = "";
  let status = null;
  const bound = boundSignal(timeoutMs, firstByteMs);
  try {
    const r = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: bound.signal });
    status = r.status;
    if (!r.ok) throw await refused(r, "ollama");
    if (!r.body) throw Object.assign(new Error(`${status}: empty body`), { status, timedOut: false, beforeFirstToken: true });
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      bound.firstByte();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.error) throw Object.assign(new Error(j.error), { status, timedOut: false });
        const delta = j.message?.content ?? j.response;
        if (ttft == null) ttft = Date.now() - t0;
        if (typeof delta === "string" && delta) {
          text += delta;
          tokens++;
          onToken?.(delta);
        }
      }
    }
    return { text, ms: Date.now() - t0, ttft: ttft ?? Date.now() - t0, tokens, status: 200 };
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || /timed out|AbortError/i.test(String(e?.message || e?.name || ""));
    const err = Object.assign(new Error(e?.message || "ollama lane error"), { status, timedOut, beforeFirstToken: tokens === 0, retryAfterMs: e?.retryAfterMs ?? null });
    throw err;
  } finally { bound.firstByte(); }
}

/** One completion on the Puter lane (browser only). The user's session pays;
 *  no developer key is ever provisioned. */
export async function chatPuter({ model, messages = [], temperature = 0.7, maxTokens = 1024, onToken = null, puter = null } = {}) {
  const p = puter ?? (typeof window !== "undefined" ? window.puter : null);
  if (!p?.ai?.chat) throw new Error("puter.ai not available in this context");
  const t0 = Date.now();
  let ttft = null;
  let text = "";
  let tokens = 0;
  try {
    const stream = p.ai.chat(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })), { model, temperature, max_tokens: maxTokens });
    for await (const piece of stream) {
      if (ttft == null) ttft = Date.now() - t0;
      const chunk = typeof piece === "string" ? piece : piece?.text ?? "";
      if (chunk) {
        text += chunk;
        tokens++;
        onToken?.(chunk);
      }
    }
    return { text, ms: Date.now() - t0, ttft: ttft ?? Date.now() - t0, tokens, status: 200 };
  } catch (e) {
    const err = Object.assign(new Error(e?.message || "puter lane error"), { beforeFirstToken: tokens === 0, timedOut: false });
    throw err;
  }
}

/** One completion on the Anthropic Messages lane (/v1/messages). Anthropic
 *  carries the system prompt in a top-level `system` field (never a message),
 *  authenticates with `x-api-key` + `anthropic-version`, and returns text in
 *  `content[].text`. Same { text, ms, ttft, tokens, status } shape as the
 *  other lanes, so executors.js learns capacity identically. Streaming parses
 *  the `content_block_delta` events. */
export async function chatAnthropic({ base, model, key = null, messages = [], temperature = 0.7, maxTokens = 1024, stream = true, onToken = null, fetchImpl = fetch, timeoutMs = 120_000, firstByteMs = 0 } = {}) {
  const url = `${String(base).replace(/\/+$/, "")}/v1/messages`;
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (key) headers["x-api-key"] = key;
  const system = messages.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n\n") || undefined;
  // temperature is omitted for models that reject it (claude-sonnet-5 / 5-5): learned once from the 400 and remembered.
  const bodyFor = () => ({ model, max_tokens: maxTokens, ...(rejectsTemperature(model) ? {} : { temperature }), ...(system ? { system } : {}), messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: String(m.content ?? "") })), stream });
  const t0 = Date.now();
  let ttft = null;
  let text = "";
  let tokens = 0;
  let buf = "";
  let status = null;
  let usage = null;
  const bound = boundSignal(timeoutMs, firstByteMs);
  try {
    const send = () => fetchImpl(url, { method: "POST", headers, body: JSON.stringify(bodyFor()), signal: bound.signal });
    let r = await send();
    if (r.status === 400 && !rejectsTemperature(model)) {
      status = 400;
      const err = await refused(r, "anthropic");
      if (!/temperature/i.test(err.bodyText)) throw err;
      NO_TEMPERATURE.add(model); // that specific 400: retry once without it
      r = await send();
    }
    status = r.status;
    if (!r.ok) throw await refused(r, "anthropic");
    if (!r.body) throw Object.assign(new Error(`${status}: empty body`), { status, timedOut: false, beforeFirstToken: true });
    if (!stream) {
      const j = await r.json();
      bound.firstByte();
      text = (j.content ?? []).map((c) => c.text ?? "").join("");
      ttft = Date.now() - t0;
      return { text, ms: Date.now() - t0, ttft, tokens: j.usage?.output_tokens ?? 0, status: 200, usage: normUsage(j.usage) };
    }
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      bound.firstByte();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "").trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        if (ttft == null) ttft = Date.now() - t0;
        // exact usage: message_start carries the input side (incl. cache), message_delta the final output count
        if (j.type === "message_start" && j.message?.usage) usage = normUsage(j.message.usage) || usage;
        if (j.type === "message_delta" && j.usage) usage = { input: usage?.input ?? null, cacheRead: usage?.cacheRead ?? null, cacheCreation: usage?.cacheCreation ?? null, output: j.usage.output_tokens ?? usage?.output ?? null };
        const delta = j.type === "content_block_delta" ? j.delta?.text : null;
        if (typeof delta === "string" && delta) {
          text += delta;
          tokens++;
          onToken?.(delta);
        }
      }
    }
    return { text, ms: Date.now() - t0, ttft: ttft ?? Date.now() - t0, tokens, status: 200, usage };
  } catch (e) {
    const timedOut = e?.name === "TimeoutError" || /timed out|AbortError/i.test(String(e?.message || e?.name || ""));
    const err = Object.assign(new Error(e?.message || "anthropic lane error"), { status, timedOut, beforeFirstToken: tokens === 0, retryAfterMs: e?.retryAfterMs ?? null });
    throw err;
  } finally { bound.firstByte(); }
}

/** Dispatch one job to an executor record, on the wire its provider speaks.
 *  Returns the chat result; throws with { timedOut, status, beforeFirstToken }
 *  on failure so executors.js can learn capacity. */
export async function inferOn(exec, { messages = [], temperature = 0.7, maxTokens = 1024, onToken = null, fetchImpl = fetch, firstByteMs = 0, timeoutMs, signal = null } = {}) {
  const auth = exec.auth;
  const bound = { firstByteMs, ...(timeoutMs ? { timeoutMs } : {}) };
  const key = auth?.apiKey ?? auth?.bearerKey ?? exec.apiKey ?? null;
  switch (exec.provider) {
    case "puter":
      return chatPuter({ model: exec.model, messages, temperature, maxTokens, onToken });
    case "ollama":
      return chatOllama({ base: exec.endpoint, model: exec.model, key, messages, temperature, maxTokens, onToken, fetchImpl, ...bound });
    case "anthropic":
      // The anthropic endpoint base is the API root (…/v1); the Messages lane
      // appends its own /v1/messages. Strip a trailing /v1 so the base never
      // doubles (measured: discovery's PROVIDER_ENDPOINTS carries …/v1).
      return chatAnthropic({ base: String(exec.endpoint).replace(/\/+$/, "").replace(/\/v1$/, ""), model: exec.model, key, messages, temperature, maxTokens, onToken, fetchImpl, ...bound });
    case "vertex":
      // The same OpenAI wire, but the base is per-project, the path has no /v1, and the credential is a token minted now (it expires hourly).
      return chatOpenAI({ base: exec.endpoint, path: VERTEX_PATH, model: exec.model, key: await resolveKey("vertex", null), messages, temperature, maxTokens, onToken, fetchImpl, ...bound });
    default:
      if (exec.authClass === "api_key" && !key) {
        const err = new Error("api_key lane without a configured key");
        err.status = 401;
        err.timedOut = false;
        err.beforeFirstToken = true;
        throw err;
      }
      // hosted open-model providers are asked to report usage on the stream, so the token meter is exact, not counted by chunks
      return chatOpenAI({ base: exec.endpoint, model: exec.model, key, messages, temperature, maxTokens, onToken, fetchImpl, signal, includeUsage: isHostedOpen(exec.provider), ...bound });
  }
}

/** The auth probe, re-exported so the bridge's link-tester and the page share
 *  one assay. */
export { probeInferenceAuth };