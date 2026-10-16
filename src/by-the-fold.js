// by-the-fold.js — "Heimdall By The Fold": a selectable model id that routes each call through the
// void loop (src/void.js) / composite cut (src/compose.js) instead of a fixed model. Any
// OpenAI/Ollama/Anthropic client — opencode included — can pick `heimdall-by-the-fold`.
//
// The honest shape: a plain chat carries no ground-truth check, so the call is routed by MEASURED
// QUALITY (competence: who is good at what) behind a STRUCTURAL gate (the completion is non-empty).
// A caller who wants strict cheapest-per-ACCEPTED sets heimdall_routing:"cheapest" and strengthens
// the gate with `heimdall_acceptance`; a caller who gives no check still gets competence routing,
// never a silent weak pass. Privacy defaults to LOCAL (disclosure none): the alias never leaks to a
// frontier without the caller's sealed label, exactly like the chat doors' own gate.
import { registerCheck } from "./acceptance.js";
import { taskClassFor } from "./job.js";

export const BY_THE_FOLD = "heimdall-by-the-fold";
export const isByTheFold = (model) => String(model ?? "").toLowerCase() === BY_THE_FOLD;

/** The completion as text, whatever shape the gate left it in. */
export function proposalText(proposal) {
  if (typeof proposal === "string") return proposal;
  if (proposal && typeof proposal.text === "string") return proposal.text;
  if (proposal == null) return "";
  return JSON.stringify(proposal);
}

/** The structural gate: the completion is not empty. Deliberately weak — it catches a broken call,
 *  not a wrong answer — and named so, never passed off as a real acceptance. */
export const STRUCTURAL_CHECK = { id: "completion", type: "custom", fn: "by-the-fold-completion" };
registerCheck("by-the-fold-completion", (proposal) => {
  const text = proposalText(proposal).trim();
  return text.length > 0 ? { ok: true, detail: "non-empty completion" } : { ok: false, kind: "empty_completion", detail: "the completion is empty" };
});

const normalize = (m) => ({
  role: m?.role === "assistant" ? "assistant" : m?.role === "system" ? "system" : "user",
  content: typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p?.text ?? "").join("") : String(m?.content ?? ""),
});

/**
 * Build the HeimdallJob@1 for one wire call (makeJob-ready; the lane fills id/schema).
 *   privacy: the caller's heimdall_privacy. Sealed → the job may leave to a frontier; absent → LOCAL.
 *   acceptance: the caller's `heimdall_acceptance` checks, else the structural gate.
 *   routing: the caller's `heimdall_routing`/`routing` ("cheapest" opts into cost-per-accepted).
 */
export function byTheFoldJob({ messages = [], model = null, privacy = null, routing = null, objective = null, acceptance = null, maxTokens = 1024, task = null, maxAttempts = 3 } = {}) {
  const ask = [...messages].reverse().find((m) => m.role === "user" && String(m.content ?? "").trim())?.content ?? "";
  const sealed = privacy === "sealed-external" || privacy === "explicit";
  return {
    taskClass: taskClassFor(ask) ?? "formal.summarize",
    objective: objective ?? "interactive",
    privacy: sealed ? "sealed-external" : "local-raw",
    effects: ["observe"],
    requires: [],
    inputs: [],
    output: { kind: "text", maxTokens: Math.max(1, Number(maxTokens) || 1024) },
    protocols: ["door-text"],
    model,
    disclosure: sealed ? "sealed-external-text" : "none",
    acceptance: Array.isArray(acceptance) && acceptance.length ? acceptance : [STRUCTURAL_CHECK],
    maxAttempts,
    routing,
    task,
  };
}

/** What the caller is told about who actually answered — never silent. */
export const disclosureOf = (trace) => ({
  served_by: trace.route ?? null,
  state: trace.state,
  attempts: Array.isArray(trace.attempts) ? trace.attempts.length : 0,
  composite: trace.composite ?? false,
  routing: trace.routing ?? null,
  satisfaction: trace.void?.satisfaction ?? null,
  gap: trace.gap ?? null,
});

/** Normalize any wire's body to the messages the job lane expects. */
export function messagesOf(body = {}) {
  const out = [];
  if (body.system) out.push({ role: "system", content: String(body.system) });
  if (Array.isArray(body.messages)) for (const m of body.messages) out.push(normalize(m));
  if (!out.length && body.prompt != null) out.push({ role: "user", content: String(body.prompt) });
  return out;
}

function sendJson(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
export function byTheFoldOpenAI(res, b, text, meta) {
  const id = "chatcmpl-" + Math.random().toString(36).slice(2);
  const created = Math.floor(Date.now() / 1000);
  if (!b.stream) return sendJson(res, 200, { id, object: "chat.completion", created, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], heimdall: meta });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish) => ({ id, created, model: b.model, choices: [{ index: 0, delta, finish_reason: finish || null }], heimdall: meta });
  res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "" })) + "\n\n");
  res.write("data: " + JSON.stringify(chunk({ content: text })) + "\n\n");
  res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
  res.end("data:");
}

export function byTheFoldAnthropic(res, b, text, meta) {
  const id = "msg_" + Math.random().toString(36).slice(2);
  if (b.stream !== true) return sendJson(res, 200, { id, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: {}, heimdall: meta });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null } }) + "\n\n");
  res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + "\n\n");
  res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) + "\n\n");
  res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n\n");
  res.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }) + "\n\n");
  res.end("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
}

export function byTheFoldOllama(res, b, text, meta) {
  const kind = Array.isArray(b.messages) ? "chat" : "generate";
  const base = { model: b.model, created_at: new Date().toISOString(), heimdall: meta };
  const body = kind === "chat" ? { message: { role: "assistant", content: text } } : { response: text };
  if (b.stream === false) return sendJson(res, 200, { ...base, ...body, done: true, done_reason: "stop" });
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.write(JSON.stringify({ ...base, ...body, done: false }) + "\n");
  const doneBody = kind === "chat" ? { message: { role: "assistant", content: "" } } : { response: "" };
  res.end(JSON.stringify({ ...base, ...doneBody, done: true, done_reason: "stop" }) + "\n");
}
