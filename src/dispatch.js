// dispatch.js — the dispatch ledger: every choice, and why (2026-10).
//
// Every time Heimdall resolves a job to an executor, the decision enters the
// ledger with the candidates, the reason, and the actual outcome. That is how
// Heimdall learns from being wrong: a lane predicted at 940ms that repeatedly
// takes 4s stops getting work. The ledger also powers the savings meter —
// exact external-token counts, with the frontier-everything and
// raw-context estimates clearly marked as estimates.
//
// Pure and node-testable; the page and bridge append to it.

export const LANE_KIND = Object.freeze({
  deterministic: "deterministic/local",
  local: "deterministic/local", // local model (WebLLM, Ollama, peers) — free
  openRemote: "open remote",
  frontier: "frontier",
});

/** One ledger entry. `selected`, `candidates`, and `actual` mirror the design:
 *  candidates carries the predicted E[T_accepted] per eligible lane. `lane`
 *  (optional) pins the lane kind explicitly — a selected id that the name
 *  regex would misclassify (e.g. "groq:…" is open remote, "anthropic:…" is
 *  frontier) is tagged by the caller who knows the truth. */
export function record({ job, selected, reason, candidates = [], actual = null, lane = null }) {
  return {
    job: job.id,
    taskClass: job.taskClass,
    at: new Date().toISOString(),
    selected,
    reason,
    candidates,
    ...(lane ? { _lane: lane } : {}),
    actual: actual
      ? { ms: actual.ms ?? null, inputTokens: actual.inputTokens ?? 0, outputTokens: actual.outputTokens ?? 0, accepted: actual.accepted ?? true, exact: actual.exact ?? null }
      : null,
  };
}

/** The savings meter: counts per lane kind, exact external tokens, and the two
 *  ESTIMATES (frontier-everything, conventional raw-context) marked as such. */
/** What "saved" is measured against: the frontier model the person would otherwise have paid for. A stated reference, never a guess. */
export const REFERENCE_FRONTIER = Object.freeze({ model: "claude-sonnet-5", usdInPerM: 3, usdOutPerM: 15 });

const LOCAL_LANES = new Set(["deterministic/local", "native", "fleet"]);
const laneKey = (e) => { const l = e._lane || laneOf(e); return LOCAL_LANES.has(l) ? "local" : l === "open remote" ? "hosted" : "frontier"; };

/** TOKENS USED AND SAVED, from the ledger alone.
 *    used    exact tokens sent to and received from outside providers (and, apart, served on this machine / fleet), per model, with the
 *            cost at `price(model, lane)`.
 *    saved   tokens that open-remote and local lanes served INSTEAD OF the reference frontier model, and what that would have cost on it
 *            minus what it did cost. The token counts are measured; the reference price is stated, so the dollars are an estimate.
 *    cancelled  calls that were stopped before they finished (a race won elsewhere): their tokens are not in any total, because
 *            nothing reports them.
 *  `exact` is the share of served calls whose token counts the provider reported (the rest were counted by chunks). */
export function tokenLedger(entries, { price = null, reference = REFERENCE_FRONTIER } = {}) {
  const by = new Map();
  const used = { input: 0, output: 0, usd: 0 }, local = { input: 0, output: 0, calls: 0 }, saved = { tokens: 0, usd: 0, calls: 0 };
  let cancelled = 0, served = 0, exact = 0;
  const usdOf = (m, lane, i, o) => { const p = price ? price(m, lane) : null; return p ? (i * (p.usdInPerM ?? 0) + o * (p.usdOutPerM ?? 0)) / 1e6 : 0; };
  for (const e of entries || []) {
    if (e.reason === "rung-failed") continue;
    if (e.reason === "cancelled") { cancelled++; continue; }
    const i = e.actual?.inputTokens ?? 0, o = e.actual?.outputTokens ?? 0, k = laneKey(e);
    served++; if (e.actual?.exact) exact++;
    if (k === "local") { local.input += i; local.output += o; local.calls++; }
    else {
      const m = String(e.selected ?? "?"), cost = usdOf(m, k === "hosted" ? "open remote" : "frontier", i, o);
      used.input += i; used.output += o; used.usd += cost;
      const row = by.get(m) || { model: m, lane: k, calls: 0, input: 0, output: 0, usd: 0 };
      row.calls++; row.input += i; row.output += o; row.usd += cost; by.set(m, row);
    }
    if (k !== "frontier") {
      const would = (i * reference.usdInPerM + o * reference.usdOutPerM) / 1e6;
      const did = k === "local" ? 0 : usdOf(String(e.selected ?? "?"), "open remote", i, o);
      saved.tokens += i + o; saved.usd += would - did; saved.calls++;
    }
  }
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return {
    used: { input: used.input, output: used.output, usd: r6(used.usd), byModel: [...by.values()].map((r) => ({ ...r, usd: r6(r.usd) })).sort((a, b) => b.usd - a.usd || (b.input + b.output) - (a.input + a.output)) },
    local,
    saved: { tokens: saved.tokens, usd: r6(saved.usd), calls: saved.calls, versus: `${reference.model} at $${reference.usdInPerM}/$${reference.usdOutPerM} per million tokens (in/out)` },
    cancelled,
    exact: served ? Math.round((exact / served) * 100) / 100 : null,
    note: "token counts are what providers reported (exact) or chunk counts (see `exact`); dollars use stated prices, so they are estimates.",
  };
}

export function meter(entries, { frontierCost = null, rawContextCost = null, price = null, reference = REFERENCE_FRONTIER } = {}) {
  const counts = { "deterministic/local": 0, "open remote": 0, frontier: 0 };
  let externalTokens = 0;
  let externalInputTokens = 0;
  let rungFailed = 0;
  for (const e of entries) {
    // A rung that failed before its first token served nothing: it is on the record, never in a lane's count or token total.
    if (e.reason === "rung-failed") { rungFailed++; continue; }
    const lane = e._lane || laneOf(e);
    if (counts[lane] == null) counts[lane] = 0;
    counts[lane]++;
    if (lane !== "deterministic/local") { externalTokens += e.actual?.outputTokens ?? 0; externalInputTokens += e.actual?.inputTokens ?? 0; }
  }
  const frontierEstimated = frontierCost != null ? Math.round(externalTokens * frontierCost) : null;
  const rawEstimated = rawContextCost != null ? Math.round(externalTokens * rawContextCost) : null;
  return {
    counts,
    externalTokens, // exact — measured, not an estimate
    externalInputTokens, // exact when the provider reported usage; 0 where it did not
    rungFailed, // failed rungs on the record (steps down), never counted as served
    tokens: tokenLedger(entries, { price, reference }),
    estimated: {
      frontierEverything: frontierEstimated,
      conventionalRawContext: rawEstimated,
      note: "frontier-everything and raw-context are estimates; externalTokens is exact.",
    },
  };
}

function laneOf(e) {
  if (e._lane) return e._lane;
  const s = String(e.selected ?? "");
  if (/anthropic|openai|claude/.test(s)) return "frontier";
  if (/groq|openrouter|mistral|cohere|google|cloudflare|huggingface|puter|together|fireworks|deepinfra|cerebras|vertex/.test(s)) return "open remote";
  return "deterministic/local";
}

/** Default costs for the meter's estimates: how many frontier tokens a job
 *  would have cost, and how many raw-context tokens a conventional agent
 *  would have shipped. Both are callers' estimates, never measured. */
export const ESTIMATE_COSTS = Object.freeze({
  frontierCost: 1, // 1× the external tokens (same output), for the estimate
  rawContextCost: 22.7, // conventional agents carry ~22.7× raw context (measured proxy, not a promise)
});