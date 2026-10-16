// void.js — the void loop for heimdall's job routing (2026-10).
//
// A job is a VOID to fill: something the Fold needs and does not yet hold.
// Following the Fold's own doctrine ("defining the void, recursively"): a void
// is never stated directly — it is defined by its CLOSURE (the set of checks
// that would fill it) — and the recursion stops only at the three floors:
// the GIVEN (a real check that runs — a test, a byte), the RECEIVED (a named
// giver — a model pin), or a typed WALL.
//
//   DEF  defVoid(job)          name the slot and its closure (the acceptance
//                              checks). NO closure → the void is undefined: a
//                              typed gap, a statement about the reader, never
//                              about the world.
//   EVA  eva(void, proposal)   run the closure → the SATISFACTION, three-valued:
//                              satisfied / refuted / gap (a gap is never a yes).
//   REC  recVoid(void, ...)    on a refutation re-cut the DEF onto new ground
//                              (exclude the refuted giver, narrow the slot); a
//                              check no giver can satisfy is a WALL — disclosed,
//                              never a silent fill.
//
// Every EVA is also EVIDENCE: it teaches the competence table WHO IS GOOD AT
// WHAT — (model, taskClass, size) → accepted — so the next void's DEF starts
// from what was MEASURED, not from a name. This is the join between the job
// lane (which learned only per-route accept rates) and competence.js.
import { runAcceptance } from "./acceptance.js";
import { runJob } from "./escalation.js";
import { bucketLabel, bucketOf } from "./competence.js";
import { capabilitiesOf } from "./job.js";

export const SATISFACTION = Object.freeze({ satisfied: "satisfied", refuted: "refuted", gap: "gap" });

/**
 * DEF the void. The definition IS the closure: the typed acceptance checks that
 * would fill it. A job with no acceptance checks defines no void — there is
 * nothing that could say it is filled — so it is a typed gap (`no-closure`),
 * the doctrine's "a statement about the reader, never the world."
 */
export function defVoid(job, { ctxTokens = 0 } = {}) {
  const closure = (job?.acceptance ?? []).slice();
  const defined = closure.length > 0;
  return {
    schema: "HeimdallVoid@1",
    slot: {
      taskClass: job?.taskClass ?? null,
      capability: capabilitiesOf(job ?? {}),
      output: job?.output ?? null,
      ctxTokens,
      bucket: bucketLabel(bucketOf(ctxTokens)),
    },
    closure,
    closureTypes: closure.map((c, i) => ({ id: c.id ?? `a${i + 1}`, type: c.type })),
    // the floors the recursion may stop at
    floors: {
      given: defined, // a real check that runs (a real test/byte)
      received: job?.model ?? null, // a named giver (a model pin)
    },
    defined,
    gap: defined
      ? null
      : { kind: "no-closure", about: "the void cannot be filled: no acceptance check defines a good answer" },
  };
}

/** EVA's naming: the three-valued satisfaction of one proposal. A gap is never a yes. */
export function satisfactionOf(acceptance) {
  if (!acceptance) return SATISFACTION.gap;
  if (acceptance.state === "accepted") return SATISFACTION.satisfied;
  if (acceptance.state === "rejected") return SATISFACTION.refuted;
  return SATISFACTION.gap; // unverified / unresolved — evidence neither way
}

/** EVA one proposal against the void's closure. Never throws: a throwing check is a gap. */
export async function eva(voidObj, proposal, ctx = {}) {
  const acceptance = await runAcceptance(voidObj.closure, proposal, ctx);
  return { satisfaction: satisfactionOf(acceptance), acceptance };
}

/**
 * REC — re-cut the DEF onto new ground, narrower by this finding. The refuted
 * giver joins the void's `tried` set; when no giver remains the void is a WALL
 * (a typed gap), never a silent fill. HUNT-FIRST: a check that survives every
 * giver is a wall, not a reason to redraw the same thing.
 */
export function recVoid(voidObj, { refutedBy = null, tried = [], remaining = [] } = {}) {
  const nextTried = [...new Set([...(voidObj.tried ?? []), ...tried, refutedBy].filter(Boolean))];
  const wall = remaining.length === 0 && nextTried.length > 0
    ? { kind: "wall", about: `no giver fills the void for ${voidObj.slot.taskClass} at ${voidObj.slot.bucket}`, tried: nextTried }
    : null;
  return { ...voidObj, tried: nextTried, wall };
}

/**
 * LEARN — an EVA is evidence: record one attempt's satisfaction against the
 * GIVER's model (not the route id) and the void's SIZE, so "who is good at
 * what" is measured per (model, taskClass, size). Only a real verdict — accepted
 * or rejected — is evidence; an error or a gap (unverified/unresolved) teaches
 * nothing and is not recorded (a gap is not a "no").
 */
export function learnSatisfaction(comp, { voidObj, route, attempt }) {
  const model = route?.model ?? route?.id;
  if (!comp || !model || !attempt || !attempt.acceptance) return null;
  if (attempt.verdict !== "accepted" && attempt.verdict !== "rejected") return null;
  return comp.observe({
    model,
    taskClass: voidObj.slot.taskClass,
    ctxTokens: voidObj.slot.ctxTokens,
    ok: attempt.verdict === "accepted",
    ms: attempt.ms ?? null,
    usd: null,
    outTokens: attempt.tokens ?? null,
  });
}

/** A competence-informed view of a route-stats table: routing P is read from
 *  WHO IS GOOD AT WHAT when it has evidence, and from the route table otherwise. */
export function routedStats(base, comp, byId, ctxTokens) {
  const modelOf = (id) => byId.get(id)?.model ?? id;
  return {
    acceptRate(routeId, taskClass) {
      const b = base.acceptRate(routeId, taskClass);
      const e = comp.estimate(modelOf(routeId), taskClass, ctxTokens);
      return e && e.n > 0 ? { ...b, p: e.mean, n: e.n, measured: true, source: "competence" } : { ...b, source: "route-stats" };
    },
    sampleRate: (routeId, taskClass, rng) => base.sampleRate(routeId, taskClass, rng),
    record: (routeId, taskClass, outcome) => base.record(routeId, taskClass, outcome),
    snapshot: () => base.snapshot(),
  };
}

/**
 * CHASE the void: DEF → EVA → REC until it is satisfied or walled. Built on
 * `runJob` (eligibility, disclosure, deadline, escalation), plus:
 *   · an undefined void never reaches a route (no closure → typed gap);
 *   · routing P is read from the competence table ("who is good at what" at
 *     this size) when it has evidence;
 *   · every EVA is fed back into the competence table (learning);
 *   · the returned `void` names the satisfaction and the givers tried.
 * Returns runJob's trace plus `void`.
 */
export async function chaseVoid(job, { routes, stats, comp = null, execute, ctx = {}, record = () => {}, ctxTokens = 0, ...opts } = {}) {
  const voidObj = defVoid(job, { ctxTokens });
  if (!voidObj.defined)
    return { jobId: job.id, void: voidObj, attempts: [], final: { state: "void-undefined", gap: voidObj.gap, reason: "no closure: the void is undefined" } };

  const byId = new Map((routes || []).map((r) => [r.id, r]));
  const routed = comp ? routedStats(stats, comp, byId, ctxTokens) : stats;
  const trace = await runJob(job, {
    routes, stats: routed, execute, ctx, ...opts,
    record: (entry) => { learnSatisfaction(comp, { voidObj, route: entry.route, attempt: entry.attempt }); record(entry); },
  });
  const last = trace.attempts.at(-1);
  const narrowed = recVoid(voidObj, { tried: trace.attempts.map((a) => a.route), remaining: [] });
  return { ...trace, void: { ...voidObj, satisfaction: last ? satisfactionOf(last.acceptance) : SATISFACTION.gap, tried: narrowed.tried, wall: trace.final.state === "accepted" ? null : narrowed.wall } };
}

/** WHO IS GOOD AT WHAT: the measured standing of each candidate model at a task
 *  class and size, best (lower confidence bound) first. Unmeasured models sort
 *  last, never assumed good. */
export function whoIsGoodAt(comp, { taskClass, ctxTokens = 0, candidates = [] } = {}) {
  return candidates
    .map((model) => ({ model, ...comp.estimate(model, taskClass, ctxTokens) }))
    .sort((a, b) => b.lcb - a.lcb || (b.mean ?? 0) - (a.mean ?? 0) || (a.model < b.model ? -1 : 1));
}
