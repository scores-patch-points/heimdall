#!/usr/bin/env node
// measure-routing.mjs — does the new bifrost actually improve things?
//
// Two fair experiments, same seeded burst both arms. The baseline replicates
// the OLD main.js pickGiver verbatim (round-robin over ready givers, model
// ignored, self only when nobody ready, no migration). The contender is
// src/route.js + src/swarm.js as wired. Seeded RNG: identical order per arm.
//
// Exp 1 — CORRECTNESS (mixed burst: 10 Qwen-pinned, 10 Llama-pinned,
// 10 free): wrong-model deliveries and unserved jobs. A fast wrong answer
// is a failure, not a win, so speed is not scored here at all.
// Exp 2 — SPEED (30 free jobs, all servable by anyone): avg completion and
// makespan. Same denominator both arms (30/30 served) — the only honest
// way to compare latency.
// Exp 3 — MIGRATION (origin holds Qwen only; 10 Llama-pinned jobs):
// baseline fails all ten; contender forwards to a Llama ally.

import { pickGiver as routePick, markSent, observe } from "../src/route.js";
import { pickForwarder } from "../src/swarm.js";

const QWEN = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const LLAMA = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const SMOL = "SmolLM2-360M-Instruct-q4f16_1-MLC";

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVERS = [
  { key: "fast-qwen|1", model: QWEN, ms: 800 },
  { key: "tiny-smol|1", model: SMOL, ms: 500 },
  { key: "slow-llama|1", model: LLAMA, ms: 4000 },
  { key: "slow-llama|2", model: LLAMA, ms: 3800 },
  { key: "self", model: QWEN, ms: 900 },
];
const serviceMs = Object.fromEntries(GIVERS.map((g) => [g.key, g.ms]));
const workersOf = (keys = GIVERS.filter((g) => g.key !== "self")) =>
  new Map(keys.filter((g) => g.key !== "self").map((g) => [
    g.key,
    { status: "ready", peer: { opened: true }, hello: { model: g.model, leaseUntil: Date.now() + 3600_000 } },
  ]));
const selfOf = () => ({ key: "self", model: QWEN, loaded: true });

function shuffledJobs(rand, spec) {
  const jobs = [];
  for (const [model, n, p] of spec) for (let i = 0; i < n; i++) jobs.push({ id: `${p}${i}`, model });
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  return jobs;
}

// Baseline: old round-robin, model-blind, workers preferred, self fallback.
function runBaseline(jobs, giverKeys) {
  const workers = giverKeys.filter((k) => k !== "self");
  const pool = workers.length ? workers : ["self"];
  const queues = Object.fromEntries(pool.map((k) => [k, 0]));
  let idx = 0, wrong = 0, done = 0, sumMs = 0, maxMs = 0;
  for (const job of jobs) {
    const key = pool[idx++ % pool.length];
    const giver = GIVERS.find((g) => g.key === key);
    if (job.model && giver.model !== job.model) { wrong++; continue; }
    const ms = giver.ms * ++queues[key];
    sumMs += ms; maxMs = Math.max(maxMs, ms); done++;
  }
  return { done, wrong, unserved: jobs.length - done - wrong, avgMs: done ? Math.round(sumMs / done) : null, maxMs };
}

function runContender(jobs, giverKeys, controllers = new Map()) {
  const workers = workersOf(GIVERS.filter((g) => giverKeys.includes(g.key)));
  const self = giverKeys.includes("self") ? selfOf() : null;
  // Seed pace from prior measurement (the fleet has run before), so the
  // duel tests steering — not cold-start discovery, which both arms share.
  let state = { inflight: {}, meanMs: { ...serviceMs }, idx: 0 };
  const queues = Object.fromEntries(giverKeys.map((k) => [k, 0]));
  let wrong = 0, done = 0, sumMs = 0, maxMs = 0, forwarded = 0, fwdIdx = 0;
  // Phase 1 — the burst: route all 30 while every job is still in flight
  // (markSent only). Observing inline would drain inflight and simulate
  // sequential jobs, hiding exactly the load being measured.
  const assignments = [];
  for (const job of jobs) {
    const p = routePick(workers, {
      model: job.model, self, inflight: state.inflight, meanMs: state.meanMs, queued: {}, idx: state.idx++,
    });
    if (!p.giver) {
      const f = pickForwarder(controllers, { wantModel: job.model, idx: fwdIdx++ });
      if (f.forwarder) { forwarded++; done++; continue; } // served one hop away
      continue; // genuinely unservable
    }
    const key = p.giver.key;
    if (job.model && GIVERS.find((g) => g.key === key).model !== job.model) { wrong++; continue; }
    state.inflight = markSent(state.inflight, key);
    assignments.push(key);
  }
  // Phase 2 — completions drain (FIFO per giver).
  for (const key of assignments) {
    const ms = serviceMs[key] * ++queues[key];
    sumMs += ms; maxMs = Math.max(maxMs, ms); done++;
  }
  return { done, wrong, unserved: jobs.length - done, forwarded, avgMs: done ? Math.round(sumMs / done) : null, maxMs, queues };
}

const SEEDS = process.argv.slice(2).map(Number).filter(Boolean);
const seeds = SEEDS.length ? SEEDS : [7, 42, 99];
const ALL = GIVERS.map((g) => g.key);
let fail = 0;

// Exp 1 — correctness on a mixed burst.
{
  console.log("Exp 1 — CORRECTNESS · 30 jobs (10 Qwen-pinned, 10 Llama-pinned, 10 free)");
  for (const s of seeds) {
    const spec = [[QWEN, 10, "q"], [LLAMA, 10, "l"], [null, 10, "u"]];
    const b = runBaseline(shuffledJobs(rng(s), spec), ALL);
    const c = runContender(shuffledJobs(rng(s), spec), ALL);
    console.log(`  seed ${s}: baseline served=${b.done} wrong=${b.wrong} unserved=${b.unserved} | contender served=${c.done} wrong=${c.wrong} unserved=${c.unserved}`);
    if (c.wrong !== 0) { fail++; console.error("  BROKEN: contender delivered a wrong model"); }
  }
}

// Exp 2 — speed on 30 free jobs (same denominator, the only honest latency duel).
{
  console.log("Exp 2 — SPEED · 30 free jobs (every giver eligible)");
  let bAvg = 0, cAvg = 0, bMax = 0, cMax = 0;
  for (const s of seeds) {
    const b = runBaseline(shuffledJobs(rng(s), [[null, 30, "u"]]), ALL);
    const c = runContender(shuffledJobs(rng(s), [[null, 30, "u"]]), ALL);
    bAvg += b.avgMs; cAvg += c.avgMs; bMax = Math.max(bMax, b.maxMs); cMax = Math.max(cMax, c.maxMs);
    console.log(`  seed ${s}: baseline avg=${b.avgMs}ms makespan=${b.maxMs}ms | contender avg=${c.avgMs}ms makespan=${c.maxMs}ms`);
    if (s === seeds[0]) console.log(`    contender spread: ${JSON.stringify(c.queues)}`);
  }
  bAvg = Math.round(bAvg / seeds.length); cAvg = Math.round(cAvg / seeds.length);
  const pct = Math.round((100 * (bAvg - cAvg)) / bAvg);
  console.log(`  mean over seeds: baseline ${bAvg}ms → contender ${cAvg}ms (${pct >= 0 ? "−" + pct + "%" : "+" + -pct + "%"})`);
  if (cAvg >= bAvg) { fail++; console.error("  NO SPEEDUP: contender not faster on free jobs"); }
}

// Exp 3 — migration: origin holds Qwen only, 10 Llama-pinned jobs, one Llama ally.
{
  console.log("Exp 3 — MIGRATION · Qwen-only origin, 10 Llama-pinned jobs, Llama ally next door");
  const originKeys = ["fast-qwen|1", "self"];
  const ally = new Map([["ally|9", { at: Date.now(), userId: "@b:h", deviceId: "9", serves: [LLAMA], sameAccount: false }]]);
  const b = runBaseline(shuffledJobs(rng(seeds[0]), [[LLAMA, 10, "l"]]), originKeys);
  const c = runContender(shuffledJobs(rng(seeds[0]), [[LLAMA, 10, "l"]]), originKeys, ally);
  console.log(`  baseline: served=${b.done} wrong=${b.wrong} unserved=${b.unserved} | contender: served=${c.done} (forwarded=${c.forwarded}) unserved=${c.unserved}`);
  if (c.done !== 10 || b.done !== 0) { fail++; console.error("  MIGRATION CLAIM BROKEN"); }
}

console.log(fail ? `\n${fail} improvement claim(s) FAILED` : "\nall three improvements measured (correctness, speed, migration)");
process.exit(fail ? 1 : 0);
