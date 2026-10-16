#!/usr/bin/env node
// falsify-cheapest.mjs — try to make `routing: "cheapest"` produce WORSE output than `routing: "fastest"`.
//
// The claim under test, stated so it can fail:
//   For the same job, cheapest reaches an ACCEPTED answer at least as often as fastest
//   (non-inferior), the accepted answer is the same one, and it costs less.
//
// The mode's only defence is the job's OWN acceptance checks. So the claim must break in exactly
// two places, and this script hunts both:
//   (B) the free lanes are bad and numerous relative to maxAttempts: cheapest burns every attempt
//       on free lanes, never reaches the good paid lane, and the job ends rejected — while fastest
//       (which ranks by time) accepted it.  ← degraded ACCEPT rate
//   (C) the acceptance gate is WEAK (a schema, not the value): then a wrong answer "passes", and a
//       router that uses cheap models more often accepts more wrong answers.  ← degraded QUALITY
//
// Correctness is DETERMINISTIC per (seed, job index, route id): both policies observe the SAME
// model behaviour, so the only variable measured is the routing policy itself.
import { makeJob } from "../src/job.js";
import { runJob, costTerms } from "../src/escalation.js";
import { createRouteStats } from "../src/route-stats.js";

const TRUTH = 42;
const CAPS = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval"];
const hash01 = (...parts) => {
  let h = 2166136261 >>> 0;
  for (const ch of parts.join("|")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h / 2 ** 32;
};

const route = (id, { trust = "local", quality = 0.8, usd, serviceMs = 1000 } = {}) => ({
  id, kind: trust === "external" ? "remote" : "local-model", trust, capabilities: CAPS,
  queue: 0, inflight: 0, networkMs: trust === "external" ? 100 : 0, serviceMs,
  ...(usd != null ? { usd } : {}),
  sim: { quality },
});

const jobFor = ({ routing, gate, maxAttempts }) => makeJob({
  taskClass: "formal.check",
  routing,
  maxAttempts,
  acceptance: gate === "weak"
    ? [{ type: "schema", schema: { type: "object", required: ["value"], properties: { value: { type: "integer" } } } }]
    : [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: TRUTH }] }],
});

// One online run of `n` jobs under a policy: stats accumulate across jobs (the router learns), and
// each (job, route) outcome is fixed by the hash, so the two policies are compared on identical worlds.
async function run(policy, routes, { seed = 1, n = 500, gate = "strong", maxAttempts = 3 } = {}) {
  const stats = createRouteStats({});
  const rows = [];
  for (let i = 0; i < n; i++) {
    const job = jobFor({ routing: policy, gate, maxAttempts });
    const execute = async (r) => {
      const ok = hash01(seed, i, r.id) < (r.sim.quality ?? 0.8);
      return { proposal: { value: ok ? TRUTH : TRUTH + 7 }, ms: 100, tokens: 10 };
    };
    const trace = await runJob(job, { routes, stats, execute });
    const cost = trace.attempts.reduce((s, a) => s + (costTerms(routes.find((r) => r.id === a.route), job).usd ?? 0), 0);
    rows.push({
      accepted: trace.final.state === "accepted",
      correct: trace.final.state === "accepted" && trace.final.proposal?.value === TRUTH,
      cost, attempts: trace.attempts.length, route: trace.final.route, state: trace.final.state,
    });
  }
  return rows;
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const worst = (rows) => rows.filter((r) => !r.accepted).length;

async function compare(name, routes, opts) {
  const fast = await run("fastest", routes, opts);
  const cheap = await run("cheapest", routes, opts);
  const n = fast.length;
  const accF = fast.filter((x) => x.accepted).length / n;
  const accC = cheap.filter((x) => x.accepted).length / n;
  const faF = fast.filter((x) => x.accepted && !x.correct).length / n;
  const faC = cheap.filter((x) => x.accepted && !x.correct).length / n;
  const harm = fast.filter((f, i) => f.accepted && !cheap[i].accepted).length;
  const help = fast.filter((f, i) => !f.accepted && cheap[i].accepted).length;
  const cheaperUsd = mean(cheap.map((x) => x.cost)) < mean(fast.map((x) => x.cost));
  console.log(`\n== ${name}`);
  console.log(`   accepted        fastest ${pct(accF)}   cheapest ${pct(accC)}   Δ ${(100 * (accC - accF)).toFixed(1)}pt   (${worst(fast)} vs ${worst(cheap)} rejected)`);
  console.log(`   false-accept    fastest ${pct(faF)}   cheapest ${pct(faC)}`);
  console.log(`   $/job           fastest ${mean(fast.map((x) => x.cost)).toFixed(5)}   cheapest ${mean(cheap.map((x) => x.cost)).toFixed(5)}   ${cheaperUsd ? "(cheaper)" : "(NOT cheaper)"}`);
  console.log(`   attempts        fastest ${mean(fast.map((x) => x.attempts)).toFixed(2)}   cheapest ${mean(cheap.map((x) => x.attempts)).toFixed(2)}`);
  console.log(`   HARM (fastest accepted, cheapest did not): ${harm}   |   HELP (cheapest accepted, fastest did not): ${help}`);
  return { dAccepted: accC - accF, dFalse: faC - faF, harm, help };
}

const results = [];
// A: benign world — one good free lane, one better paid lane.
results.push(["A benign", await compare("A benign (1 free q0.9, 1 paid q0.95, budget 3)",
  [route("free", { quality: 0.9 }), route("paid", { trust: "external", quality: 0.95, usd: 0.02, serviceMs: 300 })], { seed: 7 })]);
// B: adversarial — more bad free lanes than the attempt budget.
results.push(["B adversarial", await compare("B adversarial (3 free q0, 1 paid q1, budget 2)",
  [route("free1", { quality: 0 }), route("free2", { quality: 0 }), route("free3", { quality: 0 }), route("paid", { trust: "external", quality: 1, usd: 0.02, serviceMs: 200 })], { seed: 7, maxAttempts: 2 })]);
// B2: same, but budget 4 (just enough to reach the paid lane).
results.push(["B2 adversarial, budget 4", await compare("B2 adversarial (3 free q0, 1 paid q1, budget 4)",
  [route("free1", { quality: 0 }), route("free2", { quality: 0 }), route("free3", { quality: 0 }), route("paid", { trust: "external", quality: 1, usd: 0.02, serviceMs: 200 })], { seed: 7, maxAttempts: 4 })]);
// C: weak gate — a wrong integer passes; who accepts more wrong answers?
results.push(["C weak gate", await compare("C weak gate (1 free q0.3, 1 paid q0.9, schema-only)",
  [route("free", { quality: 0.3 }), route("paid", { trust: "external", quality: 0.9, usd: 0.02, serviceMs: 300 })], { seed: 7, gate: "weak" })]);
// D: tight budget, no measured evidence — a rational gamble on the free lane, and what it costs.
results.push(["D tight budget", await compare("D tight budget (1 free q0, 2 paid q0.5, budget 2)",
  [route("free", { quality: 0 }), route("paid1", { trust: "external", quality: 0.5, usd: 0.02, serviceMs: 200 }), route("paid2", { trust: "external", quality: 0.5, usd: 0.02, serviceMs: 250 })], { seed: 7, maxAttempts: 2 })]);
// E: more bad free lanes than the budget — the last-attempt reservation must still reach a good lane.
results.push(["E free flood", await compare("E free flood (5 free q0, 1 paid q1, budget 3)",
  [route("f1", { quality: 0 }), route("f2", { quality: 0 }), route("f3", { quality: 0 }), route("f4", { quality: 0 }), route("f5", { quality: 0 }), route("paid", { trust: "external", quality: 1, usd: 0.02, serviceMs: 200 })], { seed: 7, maxAttempts: 3 })]);

console.log("\n== verdict");
const hard = results.filter(([, r]) => r.dAccepted < -0.02); // acceptance genuinely degraded
const residual = results.filter(([, r]) => r.harm > 0 && r.dAccepted >= -0.02); // bounded exploration loss
const gate = results.filter(([, r]) => r.dFalse > 0.02);
console.log(hard.length
  ? `FALSIFIED (mechanism): ${hard.map(([n]) => n).join(", ")} — cheapest accepted materially fewer jobs.`
  : "mechanism holds: cheap-first never degraded the accepted rate by ≥2pt in any world here.");
console.log(residual.length
  ? `bounded residual (exploration): ${residual.map(([n]) => n).join(", ")} — a few jobs gambled on an unmeasured cheap lane and lost, while still costing less; the reserved last attempt bounds it (no 0%-vs-100% cliff).`
  : "no exploration residual found.");
console.log(gate.length
  ? `REQUIRES A SOUND GATE: ${gate.map(([n]) => n).join(", ")} — a weak acceptance check lets cheapest keep wrong answers; the mode is only as strong as the check.`
  : "no gate-dependence detected.");

