// void.test.mjs — the void loop: DEF the void, EVA its satisfaction, REC as needed,
// and learn who is good at what. Each test is a falsifying control on one operator.
import test from "node:test";
import assert from "node:assert/strict";
import { makeJob } from "./job.js";
import { createRouteStats } from "./route-stats.js";
import { createCompetence } from "./competence.js";
import { defVoid, eva, recVoid, satisfactionOf, chaseVoid, whoIsGoodAt, SATISFACTION } from "./void.js";

const CAPS = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval"];
const local = (id, model, over = {}) => ({ id, kind: "local-model", trust: "local", model, capabilities: CAPS, queue: 0, inflight: 0, networkMs: 0, serviceMs: 100, ...over });
const external = (id, model, over = {}) => ({ id, kind: "remote", trust: "external", model, exposure: "sealed-external-text", capabilities: CAPS, queue: 0, inflight: 0, networkMs: 100, serviceMs: 200, ...over });
const job = (over = {}) => makeJob({ taskClass: "formal.check", acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 42 }] }], ...over });

test("DEF: the void is its closure; no closure is a typed gap, not a fillable void", () => {
  const v = defVoid(job(), { ctxTokens: 2048 });
  assert.equal(v.defined, true);
  assert.equal(v.closure.length, 1);
  assert.equal(v.slot.taskClass, "formal.check");
  assert.equal(v.slot.bucket, "2k");
  assert.equal(v.floors.given, true);
  const undef = defVoid(makeJob({ taskClass: "formal.check" })); // no acceptance
  assert.equal(undef.defined, false);
  assert.equal(undef.gap.kind, "no-closure");
});

test("EVA: satisfaction is three-valued — satisfied / refuted / gap (a gap is never a yes)", async () => {
  const v = defVoid(job());
  assert.equal((await eva(v, { value: 42 })).satisfaction, SATISFACTION.satisfied);
  assert.equal((await eva(v, { value: 7 })).satisfaction, SATISFACTION.refuted);
  assert.equal((await eva(v, {})).satisfaction, SATISFACTION.gap); // an unusable proposal is unresolved, not refuted
  assert.equal(satisfactionOf({ state: "unverified" }), SATISFACTION.gap);
  assert.equal(satisfactionOf({ state: "unresolved" }), SATISFACTION.gap);
  assert.equal(satisfactionOf(null), SATISFACTION.gap);
});

test("REC: narrows the void by each finding, and walls when no giver remains", () => {
  const v = defVoid(job());
  const r1 = recVoid(v, { refutedBy: "free", remaining: ["paid"] });
  assert.deepEqual(r1.tried, ["free"]);
  assert.equal(r1.wall, null);
  const r2 = recVoid(r1, { refutedBy: "paid", remaining: [] });
  assert.deepEqual(r2.tried, ["free", "paid"]);
  assert.equal(r2.wall.kind, "wall");
});

test("chaseVoid: an undefined void never reaches a route", async () => {
  let called = 0;
  const trace = await chaseVoid(makeJob({ taskClass: "formal.check" }), {
    routes: [local("free-r", "m")], stats: createRouteStats({}), execute: async () => { called++; return { proposal: { value: 42 }, ms: 1 }; },
  });
  assert.equal(trace.final.state, "void-undefined");
  assert.equal(trace.final.gap.kind, "no-closure");
  assert.equal(called, 0);
});

test("learning who is good at what: every EVA teaches the competence table, keyed by model", async () => {
  const routes = [local("free-r", "free-model"), external("paid-r", "paid-model")];
  const comp = createCompetence();
  const execute = async (r) => (r.id === "free-r" ? { proposal: { value: 0 }, ms: 5 } : { proposal: { value: 42 }, ms: 5 });
  const trace = await chaseVoid(job({ routing: "cheapest", maxAttempts: 3 }), { routes, stats: createRouteStats({}), comp, execute });
  assert.equal(trace.final.state, "accepted");
  assert.equal(comp.estimate("free-model", "formal.check", 0).mean, 0); // refuted → not good at this
  assert.equal(comp.estimate("paid-model", "formal.check", 0).mean, 1); // satisfied → good at this
  assert.equal(trace.void.satisfaction, SATISFACTION.satisfied);
  assert.equal(whoIsGoodAt(comp, { taskClass: "formal.check", candidates: ["free-model", "paid-model"] })[0].model, "paid-model");
});

test("what was learned is USED: a model measured bad is not picked, without any route-stats evidence", async () => {
  const routes = [local("free-r", "free-model"), external("paid-r", "paid-model")];
  const comp = createCompetence();
  for (let i = 0; i < 3; i++) comp.observe({ model: "free-model", taskClass: "formal.check", ctxTokens: 0, ok: false });
  for (let i = 0; i < 3; i++) comp.observe({ model: "paid-model", taskClass: "formal.check", ctxTokens: 0, ok: true });
  const execute = async () => ({ proposal: { value: 42 }, ms: 5 });
  const trace = await chaseVoid(job({ routing: "fastest" }), { routes, stats: createRouteStats({}), comp, execute });
  assert.equal(trace.attempts[0].route, "paid-r"); // the measured-good model, not the free-but-refuted one
});

test("who is good at what is size-aware: the same model is credited where it was measured", async () => {
  const routes = [local("free-r", "free-model"), external("paid-r", "paid-model")];
  const comp = createCompetence();
  for (let i = 0; i < 3; i++) comp.observe({ model: "free-model", taskClass: "formal.check", ctxTokens: 2048, ok: true }); // good at 2k
  for (let i = 0; i < 3; i++) comp.observe({ model: "free-model", taskClass: "formal.check", ctxTokens: 32768, ok: false }); // bad at 32k
  const execute = async () => ({ proposal: { value: 42 }, ms: 5 });
  const small = await chaseVoid(job({ routing: "fastest" }), { routes, stats: createRouteStats({}), comp, execute, ctxTokens: 2048 });
  const big = await chaseVoid(job({ routing: "fastest" }), { routes, stats: createRouteStats({}), comp, execute, ctxTokens: 32768 });
  assert.equal(small.attempts[0].route, "free-r"); // measured good here
  assert.equal(big.attempts[0].route, "paid-r"); // measured bad here — the size is part of "what"
});
