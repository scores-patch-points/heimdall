#!/usr/bin/env node
// falsify-void.mjs — try to break the void loop (DEF / EVA / REC + learning who is good at what).
//
// The doctrine's own falsifying controls, made executable:
//   F1  a chase that reports the void FILLED without the real test holding  (no false satisfaction)
//   F2  learning that does not move with the evidence  (a bad model keeps winning)
//   F4  a recursion that bottoms out in anything but a refutation or a wall (never a silent fill)
// A model's SELF-REPORTED confidence is attached to every proposal and must influence nothing.
import { makeJob } from "../src/job.js";
import { createRouteStats } from "../src/route-stats.js";
import { createCompetence } from "../src/competence.js";
import { runAcceptance } from "../src/acceptance.js";
import { chaseVoid, SATISFACTION } from "../src/void.js";

const CAPS = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval"];
const hash01 = (...p) => { let h = 2166136261 >>> 0; for (const ch of p.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return h / 2 ** 32; };
const local = (id, model, q, ms = 500) => ({ id, kind: "local-model", trust: "local", model, capabilities: CAPS, queue: 0, inflight: 0, networkMs: 0, serviceMs: ms, sim: { q } });
const external = (id, model, q, usd, ms = 300) => ({ id, kind: "remote", trust: "external", model, exposure: "sealed-external-text", capabilities: CAPS, queue: 0, inflight: 0, networkMs: 100, serviceMs: ms, usd, sim: { q } });
const job = (over = {}) => makeJob({ taskClass: "formal.check", acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 42 }] }], ...over });
const execFor = (routes, seed, i) => async (r) => {
  const ok = hash01(seed, i, r.id) < (r.sim?.q ?? 0.8);
  // a self-report deliberately UNCORRELATED with correctness — a router that read it would be misled
  return { proposal: { value: ok ? 42 : 7 }, ms: 50, selfReported: { confidence: r.id === "liar" ? 0.99 : 0.1 } };
};

// ── F1: never satisfiable without the check holding (re-verified independently)
{
  const routes = [local("good", "g", 0.9), external("bad", "b", 0.2, 0.02)];
  let mismatch = 0, satisfied = 0;
  for (let i = 0; i < 300; i++) {
    const j = job({ routing: i % 2 ? "cheapest" : "fastest", maxAttempts: 3 });
    const trace = await chaseVoid(j, { routes, stats: createRouteStats({}), execute: execFor(routes, 11, i) });
    const saidFilled = trace.void.satisfaction === SATISFACTION.satisfied;
    const reallyFilled = (await runAcceptance(j.acceptance, trace.final.proposal ?? null)).state === "accepted";
    if (saidFilled) satisfied++;
    if (saidFilled !== reallyFilled) mismatch++;
  }
  console.log(`F1 no false satisfaction: ${mismatch} mismatch(es) over 300 voids (${satisfied} reported filled). ${mismatch === 0 ? "PASS" : "FALSIFIED"}`);
}

// ── F2: learning moves selection — a fast-but-bad model loses to a slow-but-good one
{
  const routes = [local("fast-bad", "bad-model", 0.1, 100), external("slow-good", "good-model", 0.95, 0.02, 500)];
  const comp = createCompetence();
  const firstPick = [];
  for (let i = 0; i < 120; i++) {
    const trace = await chaseVoid(job({ routing: "fastest", maxAttempts: 3 }), { routes, stats: createRouteStats({}), comp, execute: execFor(routes, 5, i) });
    firstPick.push(trace.attempts[0]?.route);
  }
  const share = (a) => a.filter((x) => x === "fast-bad").length / a.length;
  const head = share(firstPick.slice(0, 20)), tail = share(firstPick.slice(-20));
  console.log(`F2 learning moves selection: fast-bad's share of first picks ${(100 * head).toFixed(0)}% (first 20) → ${(100 * tail).toFixed(0)}% (last 20). ${tail < head ? "PASS" : "FALSIFIED"}`);
}

// ── F4: an unsatisfiable void is a WALL, never a silent fill; a pin (received) is honored
{
  const routes = [local("a", "a", 0, 100), external("b", "b", 0, 0.02)];
  const j = job({ routing: "cheapest", maxAttempts: 3 });
  const trace = await chaseVoid(j, { routes, stats: createRouteStats({}), execute: execFor(routes, 3, 0) });
  const walled = trace.final.state !== "accepted" && trace.void.wall?.kind === "wall" && trace.void.satisfaction === SATISFACTION.refuted;
  console.log(`F4 unsatisfiable void walls: state=${trace.final.state} wall=${trace.void.wall?.kind ?? "-"} satisfaction=${trace.void.satisfaction}. ${walled ? "PASS" : "FALSIFIED"}`);

  // the RECEIVED floor: a model pin must be honored, not overridden by learning
  const comp = createCompetence();
  comp.observe({ model: "b", taskClass: "formal.check", ctxTokens: 0, ok: true });
  const pinned = await chaseVoid(job({ routing: "fastest", model: "a", maxAttempts: 2 }), { routes, stats: createRouteStats({}), comp, execute: execFor(routes, 3, 0) });
  const honored = pinned.attempts.every((x) => x.route === "a");
  console.log(`F4b received floor (a model pin) is honored over learning: routes tried ${pinned.attempts.map((x) => x.route).join(",")}. ${honored ? "PASS" : "FALSIFIED"}`);
}
