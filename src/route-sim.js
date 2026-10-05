// route-sim.js — fake routes for PROVING the escalation design (2026-10).
//
// Four routes with the shapes the design names — local-idle, local-saturated,
// device (a consented phone/laptop), remote — and an executor whose proposals
// are right or wrong with a per-route, per-task-class probability. Nothing here
// touches a network or a clock: time is virtual (the route's Q+N+S plus jitter),
// randomness is a seeded generator, so every scenario is reproducible.
//
// The simulator does NOT show that these routes exist or perform like this; it
// shows that, GIVEN routes with these measured numbers, the router behaves as
// the design claims — and where it does not (lock-in, scripts/route-sim.mjs).
// Every number below is an ASSUMED parameter of a scenario, labelled as such.

import { makeJob } from "./job.js";
import { createRouteStats } from "./route-stats.js";
import { choose, runJob } from "./escalation.js";

/** mulberry32 — the same tiny seeded generator the Fold's seal audit uses. */
export function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const BASE_CAPS = ["reasoning", "classification", "composition", "extraction", "verification", "compute", "retrieval", "structured-output"];

/** The four design routes. `sim.quality` is the ASSUMED probability its proposal passes the local checks. */
export function simRoutes(over = {}) {
  const routes = [
    { id: "local-idle", kind: "local-model", trust: "local", capabilities: BASE_CAPS, queue: 0, inflight: 0, networkMs: 0, serviceMs: 900, sim: { quality: 0.9 } },
    { id: "local-saturated", kind: "local-model", trust: "local", capabilities: BASE_CAPS, queue: 8, inflight: 2, networkMs: 0, serviceMs: 900, sim: { quality: 0.9 } },
    { id: "device", kind: "device", trust: "private-fleet", capabilities: BASE_CAPS, queue: 1, inflight: 0, networkMs: 120, serviceMs: 3000, sim: { quality: 0.8 } },
    { id: "remote", kind: "remote", trust: "external", exposure: "abstract-capsule-only", capabilities: [...BASE_CAPS, "native-tools", "long-context"], queue: 0, inflight: 0, networkMs: 450, serviceMs: 700, sim: { quality: 0.95 } },
  ];
  return routes.map((r) => ({ ...r, ...(over[r.id] || {}), sim: { ...r.sim, ...(over[r.id]?.sim || {}) } }));
}

/** A job whose proposal is `{ value: <int> }` and whose truth is `truth`: two LOCAL checks, a schema and an equality
 *  constraint. A wrong value fails the constraint (check_failed); it is the falsifier the gate is shown to reject. */
export function simJob(over = {}, truth = 42) {
  return makeJob({
    taskClass: "formal.check",
    disclosure: "abstract-capsule-only",
    privacy: "sealed-external",
    maxAttempts: 3,
    acceptance: [
      { type: "schema", schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } } },
      { type: "constraint", constraints: [{ path: "value", op: "eq", value: truth }] },
    ],
    ...over,
  });
}

/** An executor over `routes`: right with `route.sim.quality[taskClass] ?? route.sim.quality`, and ALWAYS attaching a
 *  self-reported confidence that is independent of correctness (so a router that read it would be misled). */
export function simExecutor({ rng, truth = 42, calls = null, confidence = null } = {}) {
  return async (route, job, { remainingMs } = {}) => {
    calls?.push({ route: route.id, taskClass: job.taskClass });
    const q = route.sim?.quality?.[job.taskClass] ?? (typeof route.sim?.quality === "number" ? route.sim.quality : 0.8);
    const raw = (route.queueMs ?? ((route.queue || 0) + (route.inflight || 0)) * (route.serviceMs ?? 1000)) + (route.networkMs ?? 0) + (route.serviceMs ?? 1000);
    const ms = Math.round(raw * (0.9 + 0.2 * rng()));
    const cf = confidence ?? (() => +(0.5 + 0.5 * rng()).toFixed(2));
    const selfReported = { confidence: typeof cf === "function" ? cf() : cf };
    if (route.sim?.fail === "error") return { error: { code: "http_503", message: "simulated 5xx" }, ms: Math.min(ms, 300) };
    if (route.sim?.stall && remainingMs != null) return { error: { code: "deadline", message: "simulated stall: the route was predicted fast and was not" }, ms: Math.round(remainingMs * 0.6) };
    if (remainingMs != null && ms > remainingMs * 0.6) return { error: { code: "deadline", message: "attempt watchdog: would miss the deadline" }, ms: Math.round(remainingMs * 0.6) };
    const right = rng() < q;
    return { proposal: { value: right ? truth : truth + 1 + Math.floor(rng() * 5) }, ms, tokens: 40, selfReported };
  };
}

/** Run one job on a fresh stats table; returns { trace, stats, calls }. */
export async function simulate({ jobOver = {}, routesOver = {}, seed = 1, stats = null, exposurePenaltyMs = 0, explore = "greedy", confidence = null } = {}) {
  const rng = rng32(seed);
  const routes = simRoutes(routesOver);
  const st = stats ?? createRouteStats({});
  const calls = [];
  const trace = await runJob(simJob(jobOver), { routes, stats: st, execute: simExecutor({ rng, calls, confidence }), exposurePenaltyMs, explore, rng });
  return { trace, stats: st, calls, routes };
}

/** How many consecutive REJECTED proposals does it take before the router stops choosing `routeId` first? */
export function rejectionsToFlip({ routeId = "local-idle", jobOver = {}, routesOver = {}, max = 50 } = {}) {
  const stats = createRouteStats({});
  const routes = simRoutes(routesOver);
  const job = simJob(jobOver);
  const first = choose(job, routes, stats).route?.id;
  if (first !== routeId) return { startsWith: first, flippedAfter: 0 };
  for (let k = 1; k <= max; k++) {
    stats.record(routeId, job.taskClass, "rejected");
    const now = choose(job, routes, stats).route?.id;
    if (now !== routeId) return { startsWith: first, flippedAfter: k, flippedTo: now, P: stats.acceptRate(routeId, job.taskClass).p };
  }
  return { startsWith: first, flippedAfter: null };
}

/** Long-run dynamics: local degrades for a phase then recovers. Returns the aggregate per policy. */
export async function nonstationary({ policy, seed = 1, phases = [[150, 0.9], [150, 0.1], [300, 0.9]], remoteQuality = 0.8 }) {
  const rng = rng32(seed);
  const stats = createRouteStats({ halfLife: policy.halfLife ?? null });
  const routes = simRoutes({ "local-idle": { sim: { quality: 0.9 } }, remote: { sim: { quality: remoteQuality } } })
    .filter((r) => r.id === "local-idle" || r.id === "remote");
  let i = 0, acceptedN = 0, ms = 0, switches = 0, prev = null;
  const phaseLocalShare = [];
  for (const [len, q] of phases) {
    const local = routes.find((r) => r.id === "local-idle"); local.sim.quality = q;
    let localFirst = 0;
    for (let k = 0; k < len; k++, i++) {
      const trace = await runJob(simJob({ disclosure: "abstract-capsule-only" }), { routes, stats, execute: simExecutor({ rng }), explore: policy.explore ?? "greedy", rng });
      const first = trace.attempts[0]?.route;
      if (first === "local-idle") localFirst++;
      if (prev && first !== prev) switches++;
      prev = first;
      if (trace.final.state === "accepted") acceptedN++;
      ms += trace.final.elapsedMs ?? trace.attempts.reduce((s, a) => s + a.ms, 0);
    }
    phaseLocalShare.push(localFirst / len);
  }
  return { n: i, acceptedRate: acceptedN / i, meanMsPerJob: ms / i, switches, phaseLocalShare };
}
