// opencode-lane.js — OpenCode behind Heimdall: the machine door for coding.
//
// Per the Fold's architecture, EVERYTHING routes through Heimdall — chat and
// code alike — so routing can pick the best/safest/cheapest executor under the
// same privacy rule. OpenCode is an execution substrate (spec §1/§12), never
// the epistemic architecture: it inspects trees, reads and edits files, runs
// commands. This module is the pure client heimdall uses to dispatch a coding
// job to a running `opencode serve` and bring back what it did.
//
// Wire (OpenCode server):
//   POST /session                      create  -> { id, ... }
//   POST /session/:id/message          prompt  -> a message with parts
//   GET  /session/:id/message          history
//   GET  /event                        SSE stream of live events
//
// Pure-ish: network crossings take an injected fetch. Node-testable.

export const DEFAULT_OPENCODE = "http://127.0.0.1:4096";

export function opencodeBase(override = null) {
  return String(override || DEFAULT_OPENCODE).replace(/\/+$/, "");
}

/** A model reference the server understands: { providerID, modelID }. */
export function modelRef(providerID, modelID) {
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

/** Normalize an OpenCode message/parts payload into { text, activity }.
 *  Defensive: the server returns `{ info, parts }`, `{ parts }`, or a bare
 *  array depending on route. Tool parts become activity rows; text parts
 *  become the answer. */
export function partsOf(message) {
  const parts = Array.isArray(message) ? message : (message?.parts ?? message?.info?.parts ?? []);
  let text = "";
  const activity = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") text += (text ? "\n" : "") + p.text;
    else if (p.type === "tool") {
      const state = p.state || {};
      activity.push({ tool: p.tool || p.name || "tool", status: state.status || p.status || "done", title: state.title || state.input?.command || state.input?.filePath || null });
    } else if (p.type === "reasoning" && typeof p.text === "string") {
      activity.push({ tool: "reasoning", status: "done", title: null });
    } else if (p.type === "agent" || p.type === "agentStart" || p.type === "agentEnd") {
      // opencode's sub-agent spans: the build agent delegates to explore /
      // general / named sub-agents. Surfaced as activity so the fold shows the
      // agentic composition, not just the final answer.
      activity.push({ tool: "subagent", status: "done", title: p.title || p.name || p.subagent || p.mode || null });
    }
  }
  return { text: text.trim(), activity };
}

async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
}

/** Create a session. `create` = { title?, agent?, model?, directory? }.
 *  Returns { id, raw }. */
export async function createSession(base, { title = null, agent = null, model = null, directory = null } = {}, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const body = {};
  if (title) body.title = title;
  if (agent) body.agent = agent;
  if (model) body.model = model;
  // `directory` binds the session to a project folder. The conductor reads the
  // seeds its own workspace unless told otherwise; a raw opencode server uses
  // it as the working directory. Sent only when given, so the default is
  // unchanged.
  if (directory) body.directory = directory;
  const r = await fetchImpl(opencodeBase(base) + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error("opencode session " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 200));
  const j = await readJson(r);
  const id = j?.id ?? j?.info?.id ?? j?.session?.id ?? null;
  if (!id) throw new Error("opencode session create returned no id");
  return { id, raw: j };
}

/** Send one prompt to a session. Returns { text, activity, raw }. */
export async function prompt(base, sessionID, text, { model = null, agent = null, system = null } = {}, { fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  const body = { parts: [{ type: "text", text: String(text ?? "") }] };
  if (model) body.model = model;
  if (agent) body.agent = agent;
  if (system) body.system = system;
  const r = await fetchImpl(opencodeBase(base) + `/session/${encodeURIComponent(sessionID)}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error("opencode prompt " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 200));
  const j = await readJson(r);
  return { ...partsOf(j), raw: j };
}

/** The session's message history (each normalized). */
export async function messages(base, sessionID, { fetchImpl = fetch, limit = 50, timeoutMs = 15000 } = {}) {
  const r = await fetchImpl(opencodeBase(base) + `/session/${encodeURIComponent(sessionID)}/message?limit=${limit}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error("opencode messages " + r.status);
  const j = await readJson(r);
  const arr = Array.isArray(j) ? j : (j?.messages ?? j?.data ?? []);
  return arr.map(partsOf);
}

/** One coding job, end to end: create a session (or CONTINUE one, so the loop
 *  iterates via the record — the opencode session is the EOT ledger for code),
 *  prompt it, return what it did. `sessionId` continues an existing session:
 *  the same session id means the next turn builds on the retained record. */
export async function code(base, { prompt: text, title = null, model = null, agent = null, system = null, sessionId = null, cwd = null } = {}, { fetchImpl = fetch, timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  // Create the session WITHOUT a model (CreateInput.model is a different
  // shape and rejects a ModelRef); the model rides the prompt, where
  // PromptInput.model is the ModelRef the server expects. When a sessionId is
  // given, continue that session — iteration via the EOT ledger. `cwd` binds a
  // NEW session to the project's folder (ignored when continuing).
  const id = sessionId || (await createSession(base, { title: title || "fold code", directory: cwd || null }, { fetchImpl })).id;
  const out = await prompt(base, id, text, { model, agent, system }, { fetchImpl, timeoutMs });
  return { sessionId: id, text: out.text, activity: out.activity, ms: Date.now() - t0, iterated: !!sessionId };
}