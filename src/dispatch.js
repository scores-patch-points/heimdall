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
      ? { ms: actual.ms ?? null, inputTokens: actual.inputTokens ?? 0, outputTokens: actual.outputTokens ?? 0, accepted: actual.accepted ?? true }
      : null,
  };
}

/** The savings meter: counts per lane kind, exact external tokens, and the two
 *  ESTIMATES (frontier-everything, conventional raw-context) marked as such. */
export function meter(entries, { frontierCost = null, rawContextCost = null } = {}) {
  const counts = { "deterministic/local": 0, "open remote": 0, frontier: 0 };
  let externalTokens = 0;
  for (const e of entries) {
    const lane = e._lane || laneOf(e);
    if (counts[lane] == null) counts[lane] = 0;
    counts[lane]++;
    if (lane !== "deterministic/local") externalTokens += e.actual?.outputTokens ?? 0;
  }
  const frontierEstimated = frontierCost != null ? Math.round(externalTokens * frontierCost) : null;
  const rawEstimated = rawContextCost != null ? Math.round(externalTokens * rawContextCost) : null;
  return {
    counts,
    externalTokens, // exact — measured, not an estimate
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
  if (/groq|openrouter|mistral|cohere|google|cloudflare|huggingface|puter|together|cerebras/.test(s)) return "open remote";
  return "deterministic/local";
}

/** Default costs for the meter's estimates: how many frontier tokens a job
 *  would have cost, and how many raw-context tokens a conventional agent
 *  would have shipped. Both are callers' estimates, never measured. */
export const ESTIMATE_COSTS = Object.freeze({
  frontierCost: 1, // 1× the external tokens (same output), for the estimate
  rawContextCost: 22.7, // conventional agents carry ~22.7× raw context (measured proxy, not a promise)
});