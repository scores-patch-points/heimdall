#!/usr/bin/env node
// stress-route.mjs — the bifrost under concurrent surfaces.
//
// Fleet: workers loaded with DIFFERENT models, different speeds.
// Surfaces: controller broadcast, borrows with no pin, borrows pinned to a
// specific model, a remote Matrix mouth, a pin for a model nobody loaded.
// Asserts: no wrong-model delivery, no self-route, no silent remote local,
// measured wait beats round-robin under skew.
import { pickGiver, observe, markSent, broadcastTargets, isRoomMouth, mergeInflight, mergeMeanMs, electLeader } from "../src/route.js";
import { amAlly, servesOf, pickForwarder, makeFwdJob, validFwdJob, pruneControllers } from "../src/swarm.js";

const QWEN = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const LLAMA1 = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const SMOL = "SmolLM2-360M-Instruct-q4f16_1-MLC";

const open = { opened: true };
const mkRec = (model) => ({ status: "ready", peer: open, hello: { model, leaseUntil: Date.now() + 3600_000 } });

const workers = new Map([
  ["fast-qwen|1", mkRec(QWEN)],
  ["slow-llama|1", mkRec(LLAMA1)],
  ["tiny-smol|1", mkRec(SMOL)],
  ["slow-llama|2", mkRec(LLAMA1)],
]);
const self = { key: "self", model: QWEN, loaded: true };

// Simulated true service times (ms): fast givers answer quickly.
const serviceOf = { "fast-qwen|1": 800, "slow-llama|1": 4000, "tiny-smol|1": 500, "slow-llama|2": 3800, self: 900 };
const modelOfKey = (k) => (k === "self" ? self.model : workers.get(k)?.hello?.model);

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
};

// ── 1. surfaces ─────────────────────────────────────────────────────────
{
  // Broadcast fans out to every eligible giver + self.
  const t = broadcastTargets(workers, { self });
  check(t.length === 5, `broadcast reaches all 5 givers (got ${t.length})`);
}
{
  // Pinned Qwen borrows only ever land on Qwen.
  let state = { inflight: {}, meanMs: {}, idx: 0 };
  for (let i = 0; i < 6; i++) {
    const p = pickGiver(workers, { model: QWEN, self, inflight: state.inflight, meanMs: state.meanMs, idx: state.idx++ });
    check(p.giver && modelOfKey(p.giver.key) === QWEN, `pinned Qwen job ${i} → Qwen (${p.giver?.key})`);
    state.inflight = markSent(state.inflight, p.giver.key);
    const done = observe(state, p.giver.key, { ms: serviceOf[p.giver.key], ok: true });
    state.inflight = done.inflight; state.meanMs = done.meanMs;
  }
}
{
  // Pinned Llama spreads across BOTH Llama workers (rotation under tie),
  // never onto Qwen/Smol.
  let state = { inflight: {}, meanMs: {}, idx: 0 };
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const p = pickGiver(workers, { model: LLAMA1, borrowerKey: "slow-llama|1", self, inflight: state.inflight, meanMs: state.meanMs, idx: state.idx++ });
    check(p.giver && modelOfKey(p.giver.key) === LLAMA1, `pinned Llama job ${i} → Llama (${p.giver?.key})`);
    check(p.giver?.key !== "slow-llama|1", `borrower never routes to itself (${p.giver?.key})`);
    seen.add(p.giver.key);
    state.inflight = markSent(state.inflight, p.giver.key);
    const done = observe(state, p.giver.key, { ms: serviceOf[p.giver.key], ok: true });
    state.inflight = done.inflight; state.meanMs = done.meanMs;
  }
  check(seen.has("slow-llama|2"), "pinned Llama reaches the second Llama worker (not pinned to one)");
}
{
  // Remote Matrix mouth: never a local giver.
  const mouth = "room:@bob:hyphae.social llama3.2:latest";
  check(isRoomMouth(mouth), "room mouth recognised as remote");
  // main.js refuses these before routing; the router itself must also
  // never match them to a local model id.
  const p = pickGiver(workers, { model: mouth, self, inflight: {}, meanMs: {} });
  check(p.giver === null && p.reason === "no_giver_for_model", "remote mouth matches no local giver");
  // Missing model: loud refusal, never a quiet wrong-model answer.
  const miss = pickGiver(workers, { model: "nope-9B", self, inflight: {}, meanMs: {} });
  check(miss.giver === null && miss.reason === "no_giver_for_model", "unknown model refuses loudly");
}

// ── 2. concurrency: unpinned borrows under skew ──────────────────────────
// 20 concurrent unpinned jobs. Router sees inflight × mean and must steer
// away from the slow Llamas toward the fast Qwen/Smol/self — round-robin
// would deal 4 each; measured wait must not.
{
  let state = { inflight: {}, meanMs: { "fast-qwen|1": 800, "slow-llama|1": 4000, "tiny-smol|1": 500, "slow-llama|2": 3800, self: 900 }, idx: 0 };
  const counts = {};
  // Simulate 20 jobs arriving while previous ones are still in flight
  // (inflight accumulates; each completion is observed after the burst).
  const picked = [];
  for (let i = 0; i < 20; i++) {
    const p = pickGiver(workers, { model: null, self, inflight: state.inflight, meanMs: state.meanMs, idx: state.idx++ });
    check(!!p.giver, `unpinned job ${i} routes somewhere (${p.giver?.key})`);
    picked.push(p.giver.key);
    counts[p.giver.key] = (counts[p.giver.key] ?? 0) + 1;
    state.inflight = markSent(state.inflight, p.giver.key);
  }
  console.log("  distribution under skew:", JSON.stringify(counts));
  const slow = (counts["slow-llama|1"] ?? 0) + (counts["slow-llama|2"] ?? 0);
  const fast = (counts["fast-qwen|1"] ?? 0) + (counts["tiny-smol|1"] ?? 0) + (counts["self"] ?? 0);
  check(fast > slow, `measured wait steers to fast givers (fast ${fast} > slow ${slow})`);
  check(slow < 8, `slow workers not dealt a round-robin share (slow ${slow} < 8 of 20)`);
  for (const k of picked) {
    const done = observe(state, k, { ms: serviceOf[k], ok: true });
    state = { ...state, inflight: done.inflight, meanMs: done.meanMs };
  }
  check(Object.values(state.inflight).every((v) => v === 0), "all in-flight drains after the burst");
}

// ── 3. failure: a giver that errors sheds load ──────────────────────────
{
  let state = { inflight: { "fast-qwen|1": 1 }, meanMs: { "fast-qwen|1": 800, "tiny-smol|1": 500 }, idx: 0 };
  const done = observe(state, "fast-qwen|1", { ok: false });
  check(done.inflight["fast-qwen|1"] === 0, "failed job frees its slot");
  check(done.meanMs["fast-qwen|1"] === 800, "failure leaves the mean alone");
}

// ── 4. two heimdalls, one fleet ─────────────────────────────────────────
// Controller B routes while controller A is busy. Without sharing, B sees
// idle workers and piles on; with sibling snapshots + worker queueDepth, B
// steers away. Both channels are exercised here.
{
  // Channel 1: sibling snapshots. A holds 3 unanswered on tiny-smol.
  const snapA = { at: Date.now(), inflight: { "tiny-smol|1": 3 }, meanMs: { "tiny-smol|1": 500 } };
  const effB = {
    inflight: mergeInflight({}, [snapA]),
    meanMs: mergeMeanMs({ "fast-qwen|1": 800 }, [snapA]),
  };
  check(effB.inflight["tiny-smol|1"] === 3, "sibling inflight visible to B");
  check(effB.meanMs["tiny-smol|1"] === 500, "sibling pace fills B's blind spot");
  const p = pickGiver(workers, {
    model: null, self, inflight: effB.inflight, meanMs: effB.meanMs, queued: {}, idx: 0,
  });
  check(p.giver.key !== "tiny-smol|1", `B avoids A's busy worker (picked ${p.giver.key})`);

  // Channel 2: worker backpressure. No snapshot at all — the worker itself
  // reports 3 queued (sent by a DIFFERENT-account heimdall sharing nothing).
  const q = pickGiver(workers, {
    model: null, self,
    inflight: {},
    meanMs: { "fast-qwen|1": 800, "tiny-smol|1": 500, "slow-llama|1": 4000, "slow-llama|2": 3800, self: 900 },
    queued: { "tiny-smol|1": 3 },
    idx: 0,
  });
  check(q.giver.key !== "tiny-smol|1", `cross-account backpressure steers too (picked ${q.giver.key})`);

  // Display leadership is deterministic across both siblings.
  check(electLeader(["ctrl-b", "ctrl-a"]) === "ctrl-a", "siblings agree who leads the display");
}

// ── 5. the organism migrates work ───────────────────────────────────────
// Origin O has Qwen workers only; ally S serves Llama. A Llama-pinned
// borrow at O must migrate to S, settle per hop, and never loop.
{
  const now = Date.now();
  const ctrls = new Map([
    ["cS|9", { at: now, userId: "@b:h", deviceId: "9", serves: [LLAMA1], sameAccount: false }],
    ["cQ|7", { at: now, userId: "@a:h", deviceId: "7", serves: [QWEN], sameAccount: true }],
  ]);
  // O's local pick fails (Qwen-only fleet, Llama pinned) → forward to S.
  const local = pickGiver(workers, { model: LLAMA1, inflight: {}, meanMs: {} });
  // (fleet above has Llamas; simulate O's Qwen-only view instead)
  const oWorkers = new Map([["fast-qwen|1", workers.get("fast-qwen|1")]]);
  const oLocal = pickGiver(oWorkers, { model: LLAMA1, inflight: {}, meanMs: {} });
  check(oLocal.giver === null && oLocal.reason === "no_giver_for_model", "O cannot serve Llama locally");
  const { forwarder } = pickForwarder(ctrls, { wantModel: LLAMA1 });
  check(forwarder?.key === "cS|9", `Llama job migrates to the Llama ally (→ ${forwarder?.key})`);
  // One hop only: S serves from ITS workers, never re-forwards.
  const env = makeFwdJob({ fwdId: "f9", from: "cO|1", job: { id: "j9", model: LLAMA1, messages: [{ role: "user", content: "hi" }] } });
  check(validFwdJob(env, []).ok, "forward envelope valid at S");
  const sWorkers = new Map([["slow-llama|1", workers.get("slow-llama|1")]]);
  const sPick = pickGiver(sWorkers, { model: env.job.model, inflight: {}, meanMs: {} });
  check(sPick.giver?.key === "slow-llama|1", "S serves the migrated job locally (no second hop)");
  check(validFwdJob(env, ["f9"]).reason === "forward_replay", "replay refused — no loop ever");
  // Per-hop settlement math: O settles (S ↔ borrower), S settles (giver ↔ O).
  // Net: giver +1 give, borrower +1 borrow, middlemen symmetric (+1/+1).
  const ledger = new Map();
  const settle = (g, b) => {
    if (g !== "self") ledger.set(g, { ...{ give: 0, borrow: 0 }, ...ledger.get(g), give: ((ledger.get(g) || {}).give || 0) + 1 });
    ledger.set(b, { ...{ give: 0, borrow: 0 }, ...ledger.get(b), borrow: ((ledger.get(b) || {}).borrow || 0) + 1 });
  };
  settle("slow-llama|1", "cS|9"); // S-side: giver earns, O-as-borrower owes S
  settle("cS|9", "worker-w|1"); // O-side: S earns with O, borrower owes O
  check(ledger.get("slow-llama|1").give === 1, "giver earns its compute");
  check(ledger.get("worker-w|1").borrow === 1, "borrower owes its compute");
  check(ledger.get("cS|9").give === 1 && ledger.get("cS|9").borrow === 1, "middleman nets zero (symmetric hops)");
  // Ally mode: a controller that didn't create the room never storms workers.
  check(amAlly({ creatorId: "@a:h", userId: "@b:h" }), "non-creator routes as ally");
  check(!amAlly({ creatorId: "@a:h", userId: "@a:h" }), "creator's own surfaces route");
  // Dead allies are forgotten, not consulted.
  const pruned = pruneControllers(new Map([["cS|9", { at: now - 61_000 }]]), now);
  check(pruned.size === 0, "dead ally forgotten");
  void local;
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nstress-route: all surfaces held");
