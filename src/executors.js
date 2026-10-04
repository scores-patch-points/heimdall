// executors.js — HeimdallExecutorRegistry: remote providers and local horses,
// ONE inventory (2026-10).
//
// The common representation is the point. A phone (executor "heimdall:phone-7")
// and Groq's gpt-oss (executor "groq:gpt-oss-120b") are the same shape: an
// endpoint, a model, a provider, a location, an auth class, a privacy class,
// advertised capabilities, observed doorbench evidence, live load. Heimdall
// does not keep a separate intellectual architecture for "cloud AI."
//
//   live:      reachable · inflight · queue · TTFT · tokens/sec
//   advertised: tools · structured · context
//   observed:  doorbench per taskClass · mean TTFT · tokens/sec · 429s · 5xx
//   cost:      provider · user-pays · free/local
//
// Pure and node-testable; the router (route.js), discovery (discovery.js),
// and the page wire live values into it.

import { AUTH_CLASS, canInfer } from "./auth-class.js";
import { mayLeave, satisfies } from "./job.js";

/** Where the executor lives — determines which privacy classes it may hold. */
export const LOCATIONS = Object.freeze([
  "local",        // this browser/device, in-process
  "local/LAN",    // our machine or the user's LAN
  "private-fleet",// heimdall peers / trusted private servers
  "external",     // hosted open model or frontier API
]);

/** A sealed-external provider may only ever see the permitted projection. */
export const PRIVACY_CLASS = Object.freeze(["local-raw", "sealed-only"]);

export const EWMA_ALPHA = 0.4;

/** A fresh, empty executor record. Nothing here is assumed; every field a
 *  probe or a doorbench fills is null/0 until measured. */
export function emptyExecutor({ executor, endpoint, model, provider, location, authClass, privacyClass, advertised = null }) {
  return {
    executor, // "groq:gpt-oss-120b" or "heimdall:phone-7"
    endpoint: endpoint ?? null,
    model: model ?? null,
    provider: provider ?? null,
    location: location ?? "external",
    authClass: authClass ?? "api_key",
    privacyClass: privacyClass ?? "sealed-only",
    // live (measured, never guessed)
    live: { reachable: false, inflight: 0, queue: 0, ttft: null, tokensPerSecond: null, lastHeard: null },
    // advertised (what the endpoint claims / was probed to support)
    advertised: advertised ?? { tools: false, structured: false, context: null },
    // observed (doorbench evidence, keyed per task class)
    observed: { taskClasses: {}, meanTTFT: null, tokensPerSecond: null, recent429: 0, recent5xx: 0, timeouts: 0 },
    // cost shape
    cost: { kind: "provider", freeLocal: false },
  };
}

/** The success rate on one task class: observed wins / total. Unmeasured is
 *  not zero and not 1 — it is null, and routing treats null with a floor so
 *  an unproven executor is tried, never preferred on a rumor. */
export function successRate(exec, taskClass) {
  const rec = exec?.observed?.taskClasses?.[taskClass];
  if (!rec) return null;
  const total = (rec.successes || 0) + (rec.failures || 0);
  if (!total) return null;
  return rec.successes / total;
}

/** Doorbench truth: how many times this executor has actually been seen to
 *  complete taskClass. Zero observed wins is not a measured failure. */
export function doorbenchTotals(exec, taskClass) {
  const rec = exec?.observed?.taskClasses?.[taskClass];
  return { successes: rec?.successes ?? 0, failures: rec?.failures ?? 0 };
}

/** Land one completed job observation. Returns a new record (never mutates).
 *  A 429/5xx/timeout is a failure of capacity, recorded separately so the
 *  router can avoid the lane without convicting the model. */
export function observe(exec, { taskClass, ok, ms = null, ttft = null, tokens = null, status = null, timeout = false }) {
  const next = {
    ...exec,
    live: { ...exec.live },
    observed: {
      ...exec.observed,
      taskClasses: { ...exec.observed.taskClasses },
      meanTTFT: exec.observed.meanTTFT,
      tokensPerSecond: exec.observed.tokensPerSecond,
      recent429: exec.observed.recent429,
      recent5xx: exec.observed.recent5xx,
      timeouts: exec.observed.timeouts,
    },
  };
  next.live.inflight = Math.max(0, next.live.inflight - 1);

  if (timeout) {
    next.observed.timeouts++;
    next.live.lastHeard = Date.now();
    return next;
  }
  if (status === 429) next.observed.recent429++;
  else if (status && status >= 500) next.observed.recent5xx++;
  if (taskClass) {
    const base = next.observed.taskClasses[taskClass] || { successes: 0, failures: 0 };
    const cur = ok ? { ...base, successes: base.successes + 1 } : { ...base, failures: base.failures + 1 };
    next.observed.taskClasses[taskClass] = cur;
  }
  if (Number.isFinite(ms) && ms > 0 && (ok || !taskClass)) {
    // wall time is only a success measurement; a failure's duration is not a
    // service-time signal.
  }
  if (Number.isFinite(ttft) && ttft >= 0) {
    const prev = next.observed.meanTTFT;
    next.observed.meanTTFT = prev == null ? Math.round(ttft) : Math.round((1 - EWMA_ALPHA) * prev + EWMA_ALPHA * ttft);
    next.live.ttft = next.observed.meanTTFT;
  }
  if (Number.isFinite(tokens) && Number.isFinite(ms) && ms > 0) {
    const tps = Math.round((tokens * 1000) / ms);
    const prev = next.observed.tokensPerSecond;
    next.observed.tokensPerSecond = prev == null ? tps : Math.round((1 - EWMA_ALPHA) * prev + EWMA_ALPHA * tps);
    next.live.tokensPerSecond = next.observed.tokensPerSecond;
  }
  next.live.lastHeard = Date.now();
  return next;
}

/** Mark one job in-flight (or a failed probe that must free its slot). */
export function markSent(exec) {
  return { ...exec, live: { ...exec.live, inflight: (exec.live.inflight || 0) + 1 } };
}

export function markQueue(exec, n) {
  return { ...exec, live: { ...exec.live, queue: Math.max(0, Number.isFinite(n) ? n : exec.live.queue) } };
}

/** An executor is reachable when its live probe has seen it. A never-heard
 *  executor is never routed to, no matter how the catalog described it. */
export function isReachable(exec) {
  return !!exec?.live?.reachable;
}

/** ELIGIBILITY — the wall before any scoring. A local-raw job may only go to
 *  executors inside the trust domain (location local/LAN/private-fleet, never
 *  external) that are willing to see raw state (privacyClass local-raw). A
 *  sealed-external job carries nothing raw — it may go anywhere, including a
 *  sealed external provider. Privacy is never traded for speed. */
export function privacyAllowed(exec, job) {
  if (job.privacy === "local-raw") {
    return exec.location !== "external" && exec.privacyClass === "local-raw";
  }
  return true;
}

/** The set of capabilities an executor's advertised flags actually prove.
 *  Reasoning/classification/composition/extraction/verification/compute/
 *  retrieval are not advertised flags — any inference lane is presumed able;
 *  structured-output and native-tools are flags that must be proven. */
function advertisedCapabilities(exec) {
  const a = exec.advertised || {};
  const base = ["reasoning", "classification", "composition", "extraction", "verification", "compute", "retrieval"];
  const out = [...base];
  if (a.structured) out.push("structured-output");
  if (a.tools) out.push("native-tools");
  return out;
}

export function isEligible(exec, job) {
  if (!isReachable(exec)) return false;
  if (!canInfer(exec.authClass)) return false;
  if (!privacyAllowed(exec, job)) return false;
  if (!satisfies(job, advertisedCapabilities(exec))) return false;
  // A model pin is an override: if the person named a model, only executors
  // holding it are candidates, and an unpinned executor never answers a pin.
  if (job.model && exec.model !== job.model) return false;
  return true;
}

/** Time-to-accepted-result for one executor on one job:
 *    T_e = Q + N + S          Q = wait behind existing work
 *                             N = startup/network/TTFT
 *                             S = expected service time for this task
 *    E[T_accepted] ≈ T_e / P_e   P_e = observed success on the task class
 *  A 400ms model that succeeds 50% of the time is an 800ms solution, not a
 *  400ms one. Unmeasured executors are tried, never preferred: their P and S
 *  use the fleet's measured medians, and an unproven P of 0.5 keeps a rumor
 *  from winning the lane. */
export function expectedTime(exec, taskClass, { networkMs = null, serviceMs = null } = {}) {
  const P = successRate(exec, taskClass) ?? 0.5;
  const queue = (exec.live?.queue || 0) + (exec.live?.inflight || 0);
  const S = Number.isFinite(serviceMs) && serviceMs > 0 ? serviceMs : null;
  const N = Number.isFinite(networkMs) ? networkMs : (exec.observed?.meanTTFT ?? 200);
  const base = queue * (S ?? N ?? 300) + (S ?? N ?? 300);
  return { ms: Math.round(base / Math.max(P, 0.01)), P, queue, S, N };
}

/** The full registry: executor records keyed by executor id, with the pure
 *  helpers the router needs. */
export function createRegistry() {
  const execs = new Map(); // executor id -> record
  return {
    /** Upsert a record (by executor id). Returns the stored record. */
    put(rec) {
      if (!rec?.executor) throw new Error("executor id required");
      const prev = execs.get(rec.executor) || null;
      const merged = prev ? { ...prev, ...rec, live: { ...prev.live, ...(rec.live || {}) }, observed: { ...prev.observed, ...(rec.observed || {}) }, advertised: { ...prev.advertised, ...(rec.advertised || {}) } } : rec;
      execs.set(rec.executor, merged);
      return merged;
    },
    get(id) {
      return execs.get(id) ?? null;
    },
    has(id) {
      return execs.has(id);
    },
    /** All records (live and not), as an array. */
    all() {
      return [...execs.values()];
    },
    /** Only records whose live probe has seen them. */
    reachable() {
      return this.all().filter(isReachable);
    },
    remove(id) {
      execs.delete(id);
    },
    /** Records eligible for a job, ordered by expected time-to-accepted. */
    pick(job, opts = {}) {
      const cands = this.all()
        .filter((e) => isEligible(e, job))
        .map((e) => ({ e, t: expectedTime(e, job.taskClass, opts) }));
      if (!cands.length) return { executor: null, candidates: [], reason: "no_eligible_executor" };
      cands.sort((a, b) => a.t.ms - b.t.ms || (a.e.executor < b.e.executor ? -1 : 1));
      const best = cands[0];
      return {
        executor: best.e.executor,
        candidates: cands.map(({ e, t }) => ({ executor: e.executor, model: e.model, provider: e.provider, expectedMs: t.ms, P: t.P, queue: t.queue })),
        reason: job.model ? "pinned_model" : "expected_time",
      };
    },
    /** All records, as plain JSON (for the bridge/UI). */
    snapshot() {
      return this.all().map((e) => ({
        executor: e.executor,
        endpoint: e.endpoint,
        model: e.model,
        provider: e.provider,
        location: e.location,
        authClass: e.authClass,
        privacyClass: e.privacyClass,
        live: { ...e.live },
        advertised: { ...e.advertised },
        observed: { ...e.observed, taskClasses: { ...e.observed.taskClasses } },
        cost: { ...e.cost },
      }));
    },
  };
}