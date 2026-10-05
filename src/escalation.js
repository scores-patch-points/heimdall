// escalation.js — when remote compute is used, and why (2026-10, docs/ESCALATION.md).
//
// Heimdall does not "ask a bigger model whenever something is uncertain". It
// routes a defined job:
//
//   1. DEFINE    the job states its task, what may leave (disclosure), the
//                capabilities required, a deadline, and typed local acceptance
//                checks (job.js, acceptance.js).
//   2. FILTER    `eligible(job, routes)` — a route is a candidate only if its
//                exposure does not exceed the job's disclosure and it holds
//                every required capability. Nothing is scored before this.
//   3. CHOOSE    `choose(job, routes, stats)` — estimated time-to-ACCEPTED:
//                       score = (Q + N + S) / P  [+ exposurePenaltyMs]
//                Q queue wait · N network/TTFT · S processing · P the route's
//                measured accept rate for this task class (route-stats.js).
//   4. ESCALATE  `escalate(job, attempt, …)` — ONLY on an observable failure:
//                check_failed · contradiction · unresolved · capability_missing ·
//                deadline_risk · route_error. A model's self-reported
//                confidence is not an input anywhere in this file. A gate that
//                could not run (a typed gap) is not a failure and is not
//                escalated: more compute cannot supply a missing oracle or
//                missing evidence.
//   5. VALIDATE  every result, from every route, returns as a PROPOSAL and
//                becomes `accepted` only when the job's local checks pass.
//
// Escalation can never relax the privacy boundary: the job is frozen on entry,
// the next route is chosen from `eligible()` under the SAME disclosure, and an
// escalation with no eligible route ends in a typed gap, not a looser route.
//
// Pure and node-testable: routes, stats, execution, acceptance and the clock
// are all injected. `runJob` is the orchestrator the bridge and the simulator
// share.

import { DISCLOSURE, FAILURE_KINDS, disclosureOf, disclosureRank, capabilitiesOf, satisfies } from "./job.js";
import { runAcceptance } from "./acceptance.js";

/** Where a route lives: its trust domain. */
export const ROUTE_TRUST = Object.freeze(["local", "private-fleet", "external"]);
/** The route kinds the router weighs (the four lanes of the design). */
export const ROUTE_KINDS = Object.freeze(["local-tool", "local-model", "device", "remote"]);

/** What the route sees when it serves a job. Explicit on the route when it knows
 *  (a remote route that only ever receives a rendered capsule says
 *  "abstract-capsule-only"); otherwise the CONSERVATIVE default for its trust
 *  domain: local sees nothing leave, a consented device is another party's
 *  hardware (capsule at most), an external service is assumed to receive text. */
export function exposureOf(route) {
  if (route.exposure) return route.exposure;
  if (route.trust === "local") return "none";
  if (route.trust === "private-fleet") return "abstract-capsule-only";
  return "sealed-external-text";
}

/** True iff using `route` for `job` stays inside what the job permits to leave. */
export function withinDisclosure(route, job) {
  const have = disclosureRank(exposureOf(route));
  const may = disclosureRank(disclosureOf(job));
  return have >= 0 && may >= 0 && have <= may;
}

/** The capabilities a route holds (an inference lane is presumed able at the base set only when it says so). */
const caps = (route) => route.capabilities ?? [];

/** STEP 2 — the eligibility wall. Returns { eligible, excluded:[{route, reasons}] }. Never scores. */
export function eligible(job, routes, { exclude = new Set() } = {}) {
  const ok = [], excluded = [];
  for (const route of routes || []) {
    const reasons = [];
    if (exclude.has(route.id)) reasons.push("already_tried");
    if (route.reachable === false) reasons.push("unreachable");
    if (!ROUTE_TRUST.includes(route.trust)) reasons.push("unknown_trust_domain");
    if (!withinDisclosure(route, job)) reasons.push(`disclosure: route sees ${exposureOf(route)}, job permits ${disclosureOf(job)}`);
    if (!satisfies(job, caps(route))) reasons.push(`capability_missing: needs ${capabilitiesOf(job).filter((c) => !caps(route).includes(c)).join(",")}`);
    if (job.model && route.model && route.model !== job.model) reasons.push("model_pin");
    if (job.model && !route.model) reasons.push("model_pin");
    (reasons.length ? excluded.push({ route: route.id, reasons }) : ok.push(route));
  }
  return { eligible: ok, excluded };
}

const num = (v, d) => (Number.isFinite(v) ? v : d);

/** The three time terms for one route on one job (ms). Everything here is a measurement the caller injected
 *  on the route record, or a labelled default — never a model's say-so. */
export function timeTerms(route, job) {
  const S = num(route.serviceByClass?.[job.taskClass], num(route.serviceMs, route.tokensPerSecond ? ((job.output?.maxTokens ?? 500) * 1000) / route.tokensPerSecond : 1000));
  const N = num(route.networkMs, num(route.ttft, 0));
  const Q = num(route.queueMs, (num(route.queue, 0) + num(route.inflight, 0)) * S);
  return { Q, N, S, raw: Q + N + S };
}

/**
 * STEP 3 — choose by measured performance.
 *   score = (Q + N + S) / P  +  exposurePenaltyMs · rank(exposure)
 * `stats` is a route-stats object; P is its Laplace-smoothed accept rate for
 * (route, job.taskClass). `explore: "thompson"` draws P from the Beta posterior
 * instead (the lock-in cure, measured in scripts/route-sim.mjs).
 * Deadline: with `job.deadlineMs` and `elapsedMs`, routes whose RAW time cannot
 * fit the remaining budget are set aside unless every route is at risk.
 * Returns { route|null, reason, scores[], excluded[], atRisk }.
 */
export function choose(job, routes, stats, { exclude = new Set(), elapsedMs = 0, exposurePenaltyMs = 0, explore = "greedy", rng = Math.random } = {}) {
  const { eligible: cands, excluded } = eligible(job, routes, { exclude });
  if (!cands.length) return { route: null, reason: "no_eligible_route", scores: [], excluded, atRisk: false };
  const remaining = job.deadlineMs != null ? job.deadlineMs - elapsedMs : Infinity;
  const scores = cands.map((route) => {
    const t = timeTerms(route, job);
    const rate = stats.acceptRate(route.id, job.taskClass);
    const P = explore === "thompson" ? stats.sampleRate(route.id, job.taskClass, rng) : rate.p;
    const exp = disclosureRank(exposureOf(route));
    return { route: route.id, trust: route.trust, exposure: exposureOf(route), ...t, P: +P.toFixed(4), measured: rate.n, score: Math.round(t.raw / Math.max(P, 0.01) + exposurePenaltyMs * exp), fitsDeadline: t.raw <= remaining };
  });
  const order = (a, b) => a.score - b.score || disclosureRank(a.exposure) - disclosureRank(b.exposure) || (a.route < b.route ? -1 : 1);
  scores.sort(order);
  const fits = scores.filter((s) => s.fitsDeadline);
  const pool = fits.length ? fits : [...scores].sort((a, b) => a.raw - b.raw || order(a, b)); // all at risk → the fastest raw time
  const best = pool[0];
  return {
    route: cands.find((r) => r.id === best.route),
    reason: !fits.length ? "deadline_risk_all_routes" : (job.model ? "pinned_model" : "expected_time_to_accepted"),
    scores, excluded, atRisk: !fits.length,
  };
}

/** The kind an attempt's outcome maps to, or null when it is not an observable failure.
 *  `outcome` is { error?:{code}, acceptance?:{state,failures}, kind? }. Only observable things are read. */
export function failureKindOf(outcome) {
  if (!outcome) return null;
  if (outcome.kind) return FAILURE_KINDS.includes(outcome.kind) ? outcome.kind : null;
  if (outcome.error) {
    const c = outcome.error.code;
    if (c === "capability" || c === "capability_missing" || c === "context_overflow" || c === "tools_unsupported") return "capability_missing";
    if (c === "deadline" || c === "timeout_deadline") return "deadline_risk";
    return "route_error";
  }
  const a = outcome.acceptance;
  if (!a) return null;
  if (a.state === "unresolved") return "unresolved";
  if (a.state === "rejected") return a.failures.includes("contradiction") ? "contradiction" : "check_failed";
  return null; // accepted, or unverified (a gap) — neither is escalated
}

/**
 * STEP 4 — escalate on observable failure only.
 * attempt = { route:id, outcome, n, tried:[ids], elapsedMs }. Anything on the
 * attempt that is not an observable outcome (selfReported confidence, a model's
 * "I'm unsure") is NOT read. Returns { escalate, kind, reason, next?, gap? }.
 */
export function escalate(job, attempt, routes, stats, opts = {}) {
  const kind = failureKindOf(attempt?.outcome);
  if (!kind) return { escalate: false, kind: null, reason: attempt?.outcome?.acceptance?.state === "unverified" ? "gate_gap_not_a_failure" : "not_an_observable_failure" };
  const max = job.maxAttempts ?? 3;
  if ((attempt.n ?? 1) >= max) return { escalate: false, kind, reason: "attempts_exhausted" };
  const tried = new Set([...(attempt.tried ?? []), attempt.route]);
  const next = choose(job, routes, stats, { ...opts, exclude: tried, elapsedMs: attempt.elapsedMs ?? 0 });
  if (!next.route) {
    return { escalate: false, kind, reason: "no_eligible_route", excluded: next.excluded, gap: { kind: "not-present", about: `no other route may serve this job under disclosure ${disclosureOf(job)}`, tried: [...tried] } };
  }
  // Belt and braces: the choice came from eligible(), but the invariant is the point, so it is asserted.
  if (!withinDisclosure(next.route, job)) throw new Error("escalation attempted to relax the disclosure boundary");
  return { escalate: true, kind, reason: kind, from: attempt.route, next };
}

const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

/**
 * Run a job end to end across routes. Injected:
 *   execute(route, job, { attempt, remainingMs }) → { proposal, ms, tokens?, error?:{code,message}, selfReported? }
 *   ctx      acceptance context (fns, sources, witnessed, khoraUrl, fetchImpl)
 *   stats    route-stats object (updated from each attempt's LOCAL verdict)
 *   record   (entry) → void — the dispatch ledger hook; called once per attempt
 *   clock    virtual time for simulators: { advance(ms) } (default: real elapsed from ms reported)
 * Returns the decision trace: { jobId, disclosure, attempts[], final }.
 */
export async function runJob(inputJob, { routes, stats, execute, ctx = {}, record = () => {}, exposurePenaltyMs = 0, explore = "greedy", rng = Math.random, accept = runAcceptance } = {}) {
  const job = deepFreeze(structuredClone(inputJob)); // escalation can never edit what the job permits
  const disclosure = disclosureOf(job);
  const attempts = [];
  const tried = [];
  let elapsedMs = 0;
  let nextRoute = null;
  let because = null;

  for (let n = 1; n <= (job.maxAttempts ?? 3); n++) {
    const decision = nextRoute ?? choose(job, routes, stats, { exclude: new Set(tried), elapsedMs, exposurePenaltyMs, explore, rng });
    nextRoute = null;
    if (!decision.route) {
      const gap = { kind: "not-present", about: `no eligible route under disclosure ${disclosure}`, excluded: decision.excluded };
      return { jobId: job.id, disclosure, attempts, final: { state: n === 1 ? "no_route" : "exhausted", gap, reason: decision.reason } };
    }
    const route = decision.route;
    tried.push(route.id);
    const remainingMs = job.deadlineMs != null ? Math.max(0, job.deadlineMs - elapsedMs) : null;
    let out;
    try { out = await execute(route, job, { attempt: n, remainingMs }); } catch (e) { out = { error: { code: "exception", message: String(e?.message || e) }, ms: 0 }; }
    const ms = num(out?.ms, 0);
    elapsedMs += ms;
    const overDeadline = job.deadlineMs != null && elapsedMs > job.deadlineMs;
    // The proposal and ONLY the proposal goes to the local gate; selfReported is recorded as ignored.
    let acceptance = null, outcome;
    if (out?.error) outcome = { error: out.error };
    else {
      acceptance = await accept(job, out?.proposal, ctx);
      outcome = { acceptance };
    }
    // A result that arrives after the deadline is observable lateness: it still gets judged, and if the checks pass it stands.
    const kind = failureKindOf(outcome) ?? (overDeadline && !(acceptance?.accepted) ? "deadline_risk" : null);
    const verdict = out?.error ? "error" : acceptance.state === "accepted" ? "accepted" : acceptance.state === "unverified" ? "unverified" : "rejected";
    stats.record(route.id, job.taskClass, verdict);
    const entry = {
      n, route: route.id, trust: route.trust, exposure: exposureOf(route), chosenBy: because ? `escalation:${because}` : decision.reason,
      candidates: (decision.scores || []).map((s) => ({ route: s.route, score: s.score, P: s.P, Q: s.Q, N: s.N, S: s.S, raw: s.raw })),
      excluded: decision.excluded || [], ms, tokens: out?.tokens ?? null, error: out?.error ?? null,
      proposal: out?.error ? null : { proposal: out?.proposal, route: route.id, checksToRun: (job.acceptance || []).map((c, i) => ({ id: c.id ?? `a${i + 1}`, type: c.type })) },
      acceptance: acceptance ? { state: acceptance.state, accepted: acceptance.accepted, failures: acceptance.failures, gaps: acceptance.gaps, verdicts: acceptance.verdicts } : null,
      selfReported: out?.selfReported !== undefined ? { value: out.selfReported, used: false } : undefined,
      failureKind: kind, verdict,
    };
    attempts.push(entry);
    try { record({ job, attempt: entry, route, elapsedMs }); } catch { /* the ledger never blocks a job */ }

    if (acceptance?.accepted) return { jobId: job.id, disclosure, attempts, final: { state: "accepted", route: route.id, proposal: out.proposal, elapsedMs } };
    if (acceptance?.state === "unverified") return { jobId: job.id, disclosure, attempts, final: { state: "unverified", route: route.id, proposal: out.proposal, elapsedMs, gap: { kind: "not-computed", about: "a check could not run; the proposal is shown, not accepted", verdicts: acceptance.verdicts.filter((v) => v.verdict === "gap") } } };

    const esc = escalate(job, { route: route.id, outcome: kind && !failureKindOf(outcome) ? { kind } : outcome, n, tried, elapsedMs }, routes, stats, { exposurePenaltyMs, explore, rng });
    entry.escalation = { escalate: esc.escalate, kind: esc.kind, reason: esc.reason, to: esc.next?.route?.id ?? null };
    if (!esc.escalate) return { jobId: job.id, disclosure, attempts, final: { state: acceptance?.state === "rejected" || acceptance?.state === "unresolved" ? "rejected" : "failed", route: route.id, reason: esc.reason, gap: esc.gap ?? null, elapsedMs } };
    nextRoute = esc.next;
    because = esc.kind;
  }
  return { jobId: job.id, disclosure, attempts, final: { state: "exhausted", reason: "attempts_exhausted", elapsedMs } };
}

export { DISCLOSURE };
