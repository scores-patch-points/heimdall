// route-stats.js — how often has each ROUTE produced an ACCEPTED result, per task class.
//
// The router divides its time estimate by this number (src/escalation.js
// `choose`), so a 400 ms route that is accepted half the time is an 800 ms
// route. What counts is acceptance by the Fold's own local checks
// (src/acceptance.js) — never the route's own confidence, never "it answered".
//
// The estimate is a Laplace-smoothed Beta posterior mean:
//
//     P = (accepted + α) / (accepted + rejected + errors + α + β)        α = β = 1
//
// α = β = 1 is the uniform prior: an unmeasured route reads 0.5 and every
// route starts level, so none is preferred on a rumor (executors.js says the
// same of its own unmeasured executors). Counts are per (route × taskClass) and
// persist across restarts in ~/.heimdall/route-stats.json (atomic write).
//
// Two optional behaviours exist because a pure accept-rate scorer has a known
// failure — LOCK-IN: a route that is stopped being chosen never produces new
// evidence, so a route that recovered is never found again (measured in
// scripts/route-sim.mjs):
//   · halfLife   counts decay by 2^(-1/halfLife) per new observation on that key,
//                so old evidence fades toward the prior
//   · sampleRate a Thompson draw from Beta(accepted+α, failures+β), for the
//                router's `explore: "thompson"` mode

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATS_FILE = path.join(os.homedir(), ".heimdall", "route-stats.json");
export const OUTCOMES = Object.freeze(["accepted", "rejected", "error"]);

/** Standard-normal and Gamma(k) draws (Marsaglia–Tsang) → Beta draws; pure given rng. */
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gamma(k, rng) {
  if (k < 1) return gamma(k + 1, rng) * Math.pow(rng() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gaussian(rng); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function betaSample(a, b, rng = Math.random) {
  const x = gamma(a, rng), y = gamma(b, rng);
  return x / (x + y);
}

export function createRouteStats({ file = null, alpha = 1, beta = 1, halfLife = null, now = () => Date.now() } = {}) {
  /** routes[routeId][taskClass] = { accepted, rejected, errors, unverified, lastAt } (floats once decay is on) */
  let routes = {};
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j && j.routes && typeof j.routes === "object") routes = j.routes;
    } catch { /* first run or unreadable: start empty, never crash a router */ }
  }
  const decayFactor = halfLife ? Math.pow(2, -1 / halfLife) : 1;
  const cell = (route, taskClass, create = false) => {
    const r = routes[route] ?? (create ? (routes[route] = {}) : null);
    if (!r) return null;
    return r[taskClass] ?? (create ? (r[taskClass] = { accepted: 0, rejected: 0, errors: 0, unverified: 0, lastAt: null }) : null);
  };

  const api = {
    alpha, beta, halfLife,
    /** Land one outcome: "accepted" (all local checks passed), "rejected" (a check failed / unresolved / contradiction),
     *  "error" (the route itself failed: timeout, 5xx, capability), "unverified" (a check could not run — evidence
     *  neither way, recorded but not counted toward the rate). */
    record(route, taskClass, outcome) {
      if (![...OUTCOMES, "unverified"].includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
      const c = cell(route, taskClass, true);
      if (decayFactor !== 1) { c.accepted *= decayFactor; c.rejected *= decayFactor; c.errors *= decayFactor; }
      if (outcome === "accepted") c.accepted += 1;
      else if (outcome === "rejected") c.rejected += 1;
      else if (outcome === "error") c.errors += 1;
      else c.unverified += 1;
      c.lastAt = now();
      return api.acceptRate(route, taskClass);
    },
    /** The smoothed accept rate and the raw counts behind it. n = attempts that carried evidence. */
    acceptRate(route, taskClass) {
      const c = cell(route, taskClass) || { accepted: 0, rejected: 0, errors: 0, unverified: 0 };
      const n = c.accepted + c.rejected + c.errors;
      return { p: (c.accepted + alpha) / (n + alpha + beta), accepted: c.accepted, rejected: c.rejected, errors: c.errors, unverified: c.unverified, n, measured: n > 0, prior: { alpha, beta } };
    },
    /** A Thompson draw of the accept rate (exploration): optimistic for thinly-measured routes, tight for well-measured ones. */
    sampleRate(route, taskClass, rng = Math.random) {
      const c = cell(route, taskClass) || { accepted: 0, rejected: 0, errors: 0 };
      return betaSample(c.accepted + alpha, c.rejected + c.errors + beta, rng);
    },
    snapshot() {
      const out = [];
      for (const [route, byClass] of Object.entries(routes)) for (const taskClass of Object.keys(byClass)) out.push({ route, taskClass, ...api.acceptRate(route, taskClass), lastAt: byClass[taskClass].lastAt });
      return { prior: { alpha, beta }, halfLife, file, cells: out.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.taskClass < b.taskClass ? -1 : 1)) };
    },
    /** Persist atomically (temp file + rename). Returns true when written; a failure never throws into a request. */
    save() {
      if (!file) return false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), prior: { alpha, beta }, routes }, null, 2));
        fs.renameSync(tmp, file);
        return true;
      } catch { return false; }
    },
    reset() { routes = {}; },
  };
  return api;
}

/** A plain-text table for the CLI. */
export function formatStats(snap) {
  if (!snap.cells.length) return `no route has been measured yet (prior Beta(${snap.prior.alpha},${snap.prior.beta}) → P = 0.50 for every route)`;
  const rows = snap.cells.map((c) => `${c.route.padEnd(34)} ${c.taskClass.padEnd(24)} P=${c.p.toFixed(3)}  accepted ${String(+c.accepted.toFixed(2)).padStart(4)}  rejected ${String(+c.rejected.toFixed(2)).padStart(4)}  errors ${String(+c.errors.toFixed(2)).padStart(4)}  unverified ${c.unverified}`);
  return [`ROUTE ACCEPT RATES  (Laplace-smoothed Beta(${snap.prior.alpha},${snap.prior.beta}); P = (accepted+α)/(attempts+α+β))`, ...rows].join("\n");
}
