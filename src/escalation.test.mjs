// escalation.test.mjs — the cost objective: "cheapest model per call that still
// gets a satisfactory answer". A job defines "satisfactory" up front as its local
// `acceptance` checks (src/acceptance.js); the router minimizes expected COST per
// ACCEPTED answer, E[$_accepted] = C / P, and escalates only when a proposal fails
// a check. These are falsifying controls: each test breaks if the mode is wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { makeJob, validateJob, routingOf, ROUTING } from "./job.js";
import { choose, runJob, costTerms } from "./escalation.js";
import { createRouteStats } from "./route-stats.js";

const CAPS = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval"];
const local = (id, over = {}) => ({ id, kind: "local-model", trust: "local", capabilities: CAPS, queue: 0, inflight: 0, networkMs: 0, serviceMs: 1000, ...over });
const external = (id, over = {}) => ({ id, kind: "remote", trust: "external", exposure: "sealed-external-text", capabilities: CAPS, queue: 0, inflight: 0, networkMs: 100, serviceMs: 500, ...over });
const job = (over = {}) => makeJob({
  taskClass: "formal.check",
  acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 42 }] }],
  ...over,
});

test("routing: explicit values validate, an unknown one is refused, objective=batch implies cheapest", () => {
  assert.deepEqual(ROUTING, ["fastest", "cheapest"]);
  assert.equal(validateJob(job({ routing: "cheapest" })).ok, true);
  const bad = validateJob(job({ routing: "bargain" }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("routing")));
  assert.equal(routingOf(makeJob({ taskClass: "formal.check" })), "fastest");
  assert.equal(routingOf(makeJob({ taskClass: "formal.check", objective: "batch" })), "cheapest");
  // an explicit routing outranks the objective it would otherwise derive from
  assert.equal(routingOf(makeJob({ taskClass: "formal.check", objective: "batch", routing: "fastest" })), "fastest");
});

test("cheapest minimizes cost-per-accepted: the free route wins over a faster paid one; fastest picks the paid one", () => {
  const routes = [local("free", { serviceMs: 5000 }), external("paid", { serviceMs: 500, usd: 0.02 })];
  const st = createRouteStats({}); // every route at the 0.5 prior
  const cheap = choose(job({ routing: "cheapest" }), routes, st);
  assert.equal(cheap.route.id, "free");
  assert.equal(cheap.reason, "expected_cost_to_accepted");
  assert.equal(cheap.routing, "cheapest");
  const fast = choose(job({ routing: "fastest" }), routes, st);
  assert.equal(fast.route.id, "paid");
  assert.equal(fast.reason, "expected_time_to_accepted");
});

test("cost-per-accepted divides by the measured accept rate, not the sticker price", () => {
  const routes = [external("reliable", { usd: 0.01 }), external("flaky", { usd: 0.006 })];
  const st = createRouteStats({}), cls = "formal.check";
  st.record("reliable", cls, "accepted"); // P = 2/3 -> E$ ≈ 0.015
  st.record("flaky", cls, "accepted");
  for (let i = 0; i < 8; i++) st.record("flaky", cls, "rejected"); // P = 2/11 -> E$ ≈ 0.033
  const c = choose(job({ routing: "cheapest" }), routes, st);
  assert.equal(c.route.id, "reliable"); // the pricier sticker that is accepted more often wins
  const reliable = c.scores.find((s) => s.route === "reliable");
  const flaky = c.scores.find((s) => s.route === "flaky");
  assert.ok(reliable.expectedUsd < flaky.expectedUsd);
});

test("an unpriced external route is not assumed free", () => {
  const routes = [external("priced", { usd: 0.02 }), external("unknown", {})];
  const c = choose(job({ routing: "cheapest" }), routes, createRouteStats({}));
  assert.equal(c.route.id, "priced");
  const unknown = c.scores.find((s) => s.route === "unknown");
  assert.equal(unknown.priced, false);
  assert.equal(unknown.expectedUsd, null);
});

test("costTerms: local/private are free, per-million pricing charges route.inputTokens, an unpriced external is a gap not a zero", () => {
  assert.deepEqual(costTerms(local("l"), job()), { usd: 0, priced: true });
  assert.equal(costTerms(external("e", { usdInPerM: 1, usdOutPerM: 5, inputTokens: 1_000_000, outputTokens: 1_000_000 }), job()).usd, 6);
  assert.deepEqual(costTerms(external("u"), job()), { usd: null, priced: false });
});

test("cheapest escalates only when the cheap proposal fails its acceptance checks", async () => {
  const routes = [local("free"), external("paid", { usd: 0.05, serviceMs: 200 })];
  const st = createRouteStats({});
  const execute = async (route) => route.id === "free"
    ? { proposal: { value: 7 }, ms: 10 } // fails the eq-42 constraint → check_failed
    : { proposal: { value: 42 }, ms: 10 }; // passes
  const trace = await runJob(job({ routing: "cheapest", maxAttempts: 3 }), { routes, stats: st, execute });
  assert.equal(trace.attempts[0].route, "free");
  assert.equal(trace.attempts[0].verdict, "rejected");
  assert.equal(trace.attempts[0].routing, "cheapest");
  assert.equal(trace.attempts[1].route, "paid");
  assert.equal(trace.final.state, "accepted");
  assert.equal(trace.final.route, "paid");
});

test("cheapest keeps the free answer when it passes — it is never escalated past", async () => {
  const routes = [local("free"), external("paid", { usd: 0.05 })];
  const trace = await runJob(job({ routing: "cheapest" }), { routes, stats: createRouteStats({}), execute: async () => ({ proposal: { value: 42 }, ms: 10 }) });
  assert.equal(trace.attempts.length, 1);
  assert.equal(trace.final.state, "accepted");
  assert.equal(trace.final.route, "free");
});

test("cheapest never crosses the disclosure boundary", () => {
  const routes = [local("home", { serviceMs: 9000 }), external("cheap-out", { usd: 0 })];
  const c = choose(job({ privacy: "local-raw", disclosure: "none", routing: "cheapest" }), routes, createRouteStats({}));
  assert.equal(c.route.id, "home");
  assert.ok(c.excluded.some((e) => e.route === "cheap-out"));
});

// The falsifier (scripts/falsify-cheapest.mjs) found that a free lane's expected cost is 0/P = 0 for
// ANY pass rate, so pure cost-first burned the whole attempt budget on bad free lanes and accepted 0%.
// The last attempt now maximizes accept probability, so a field of bad free lanes cannot exhaust a job.
test("cheapest reserves the final attempt: a flood of bad free lanes cannot exhaust the job", async () => {
  const routes = [local("f1", { serviceMs: 500 }), local("f2", { serviceMs: 500 }), local("f3", { serviceMs: 500 }), external("paid", { usd: 0.02, serviceMs: 200 })];
  const execute = async (r) => (r.id === "paid" ? { proposal: { value: 42 }, ms: 5 } : { proposal: { value: 0 }, ms: 5 });
  const trace = await runJob(job({ routing: "cheapest", maxAttempts: 3 }), { routes, stats: createRouteStats({}), execute });
  assert.equal(trace.final.state, "accepted");
  assert.equal(trace.final.route, "paid");
});

test("on the final attempt the chooser maximizes accept probability, not cost", () => {
  const routes = [local("free", { serviceMs: 100 }), external("paid", { usd: 0.02, serviceMs: 300 })];
  const st = createRouteStats({}), cls = "formal.check";
  st.record("paid", cls, "accepted"); // paid P = 2/3; free still at the 0.5 prior
  assert.equal(choose(job({ routing: "cheapest" }), routes, st, { attemptsLeft: 3 }).route.id, "free"); // budget to spare: cheapest first
  assert.equal(choose(job({ routing: "cheapest" }), routes, st, { attemptsLeft: 1 }).route.id, "paid"); // last attempt: the one that accepts
});

