// competence.test.mjs — dispatch by measured competence. Every claim has a falsifier.
import test from "node:test";
import assert from "node:assert/strict";
import { createCompetence, plan, bucketOf, bucketLabel, wilsonLower, estimateTokens, messagesTokens, priceOf, BUCKETS } from "./competence.js";

const LOCAL = { model: "tiny-local", tier: "local", usdInPerM: 0, usdOutPerM: 0, ctxWindow: 8192 };
const FREE = { model: "free-remote", tier: "remote", usdInPerM: 0, usdOutPerM: 0, ctxWindow: 32768 };
const SONNET = { model: "claude-sonnet", tier: "frontier", usdInPerM: 3, usdOutPerM: 15, ctxWindow: 200000 };
const OPUS = { model: "claude-opus", tier: "frontier", usdInPerM: 15, usdOutPerM: 75, ctxWindow: 200000 };
const ALL = [SONNET, OPUS, FREE, LOCAL];
const teach = (c, model, ctx, pass, fail, cls = "code.edit") => { for (let i = 0; i < pass; i++) c.observe({ model, taskClass: cls, ctxTokens: ctx, ok: true }); for (let i = 0; i < fail; i++) c.observe({ model, taskClass: cls, ctxTokens: ctx, ok: false }); };

test("buckets: boundaries and labels", () => {
  assert.equal(bucketOf(0), 0); assert.equal(bucketOf(1024), 0); assert.equal(bucketOf(1025), 1); assert.equal(bucketOf(1e9), BUCKETS.length - 1);
  assert.equal(bucketLabel(0), "1k"); assert.equal(bucketLabel(3), "8k"); assert.equal(bucketLabel(BUCKETS.length - 1), ">128k");
});

test("wilsonLower is honest about small samples: 2/2 is NOT 'competent'; 18/20 is", () => {
  assert.ok(wilsonLower(2, 2) < 0.65, String(wilsonLower(2, 2)));
  assert.ok(wilsonLower(18, 20) > 0.72);
  assert.ok(wilsonLower(50, 50) > wilsonLower(5, 5), "more evidence, higher bound");
  assert.equal(wilsonLower(0, 0), 0);
});

test("observe refuses an outcome that cannot fail: ok must be a boolean the harness decided, not a model's word", () => {
  const c = createCompetence();
  assert.equal(c.observe({ model: "m", ok: "yes" }), null);
  assert.equal(c.observe({ ok: true }), null);
  assert.ok(c.observe({ model: "m", ctxTokens: 500, ok: true }));
});

test("estimate: own bucket counts fully; evidence transfers asymmetrically across sizes", () => {
  const c = createCompetence();
  teach(c, "m", 7000, 10, 0);                       // 8k bucket: 10/10
  const small = c.estimate("m", "code.edit", 1500);  // a SMALLER context inherits the success
  assert.ok(small.mean > 0.9 && small.lcb > 0.5, JSON.stringify(small));
  const c2 = createCompetence();
  teach(c2, "m", 1500, 0, 10);                      // 2k bucket: 0/10
  const big = c2.estimate("m", "code.edit", 7000);   // a BIGGER context inherits the failure
  assert.ok(big.mean < 0.1, JSON.stringify(big));
  const c3 = createCompetence();
  teach(c3, "m", 1500, 10, 0);                      // success at SMALL says little about BIG
  assert.ok(c3.estimate("m", "code.edit", 20000).lcb < 0.45);
});

test("evidence never crosses a model boundary or a task class", () => {
  const c = createCompetence(); teach(c, "a", 2000, 20, 0);
  assert.equal(c.estimate("b", "code.edit", 2000).n, 0);
  assert.equal(c.estimate("a", "prose.write", 2000).n, 0);
});

test("falsifier: with no data NOTHING is proven — the plan ladders by cost and says everything is unmeasured", () => {
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "any" }, ALL, createCompetence(), { explore: 0 });
  assert.ok(p.ladder.every((r) => /unmeasured/.test(r.why)));
  assert.equal(p.ladder[0].model, "tiny-local", "cheapest first");
  assert.equal(p.ladder.at(-1).model, "claude-opus", "the most expensive is the last resort");
});

test("the cheapest model whose LOWER bound clears the bar is chosen — not the one with the best mean", () => {
  const c = createCompetence();
  teach(c, "claude-sonnet", 2000, 20, 0);            // proven, costly
  teach(c, "free-remote", 2000, 18, 2);              // proven (lcb ≈ .75), free
  teach(c, "tiny-local", 2000, 3, 0);                // 3/3 — a perfect mean, but untested
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "any" }, ALL, c, { explore: 0, minPass: 0.7 });
  assert.equal(p.chosen.model, "free-remote");
  assert.ok(p.ladder.findIndex((r) => r.model === "free-remote") < p.ladder.findIndex((r) => r.model === "claude-sonnet"), "escalation goes UP in cost");
  assert.ok(!/proven/.test(p.ladder.find((r) => r.model === "tiny-local").why) || /not yet proven/.test(p.ladder.find((r) => r.model === "tiny-local").why));
});

test("THE POINT: as the context grows, the same task class escalates — a small model is proven at 2k and not at 16k", () => {
  const c = createCompetence();
  teach(c, "tiny-local", 1800, 19, 1); teach(c, "tiny-local", 14000, 2, 14);
  teach(c, "claude-sonnet", 1800, 20, 0); teach(c, "claude-sonnet", 14000, 19, 1);
  const small = plan({ taskClass: "code.edit", ctxTokens: 1800, privacy: "any" }, [LOCAL, SONNET], c, { explore: 0, reserveOut: 200 });
  const big = plan({ taskClass: "code.edit", ctxTokens: 14000, privacy: "any" }, [{ ...LOCAL, ctxWindow: 32768 }, SONNET], c, { explore: 0 });
  assert.equal(small.chosen.model, "tiny-local", "scoped step → the small model");
  assert.equal(big.chosen.model, "claude-sonnet", "big context → the capable model");
});

test("privacy is a hard filter applied BEFORE cost: a local-only job never sees a remote model", () => {
  const c = createCompetence(); teach(c, "claude-sonnet", 2000, 30, 0);
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "local-only" }, ALL, c, { explore: 1 });
  assert.ok(p.ladder.every((r) => r.tier === "local" || r.tier === "fleet"), JSON.stringify(p.ladder.map((r) => r.model)));
  assert.ok(p.excluded.some((e) => /stay on this machine/.test(e.why)));
  assert.equal(p.ladder.some((r) => r.model === "claude-sonnet"), false);
});

test("a model whose window cannot hold the context + answer is excluded, with the reason", () => {
  const p = plan({ taskClass: "code.edit", ctxTokens: 9000, privacy: "any" }, [LOCAL, FREE], createCompetence(), { explore: 0 });
  assert.ok(p.excluded.some((e) => e.model === "tiny-local" && /does not fit/.test(e.why)));
  assert.deepEqual(p.ladder.map((r) => r.model), ["free-remote"]);
});

test("an unhealthy (throttled) model is excluded from the ladder", () => {
  const p = plan({ taskClass: "code.edit", ctxTokens: 1000, privacy: "any" }, [{ ...FREE, healthy: false }, SONNET], createCompetence(), { explore: 0 });
  assert.deepEqual(p.ladder.map((r) => r.model), ["claude-sonnet"]);
  assert.match(p.excluded[0].why, /throttled/);
});

test("exploration is bounded and reproducible: the cheapest UNMEASURED model is tried first only on a share of jobs", () => {
  const c = createCompetence(); teach(c, "claude-sonnet", 2000, 30, 0);
  const job = { taskClass: "code.edit", ctxTokens: 2000, privacy: "any" };
  const lowRng = plan(job, [LOCAL, SONNET], c, { explore: 0.2, rng: () => 0.05 });
  const highRng = plan(job, [LOCAL, SONNET], c, { explore: 0.2, rng: () => 0.9 });
  assert.equal(lowRng.chosen.model, "tiny-local"); assert.match(lowRng.chosen.why, /explored/);
  assert.equal(highRng.chosen.model, "claude-sonnet");
  let tried = 0; let seed = 1; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1000; i++) if (plan(job, [LOCAL, SONNET], c, { explore: 0.2, rng }).chosen.model === "tiny-local") tried++;
  assert.ok(tried > 150 && tried < 250, "about 20% explored: " + tried);
});

test("exploration never puts an unmeasured model ahead of a CHEAPER proven one", () => {
  const c = createCompetence(); teach(c, "tiny-local", 2000, 30, 0);
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "any" }, [LOCAL, FREE], c, { explore: 1, rng: () => 0 });
  assert.equal(p.chosen.model, "tiny-local");
});

test("a failing cheap model drops out of the default and the ladder escalates past it", () => {
  const c = createCompetence();
  teach(c, "tiny-local", 2000, 1, 12); teach(c, "free-remote", 2000, 15, 1);
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "any" }, [LOCAL, FREE, SONNET], c, { explore: 0 });
  assert.equal(p.chosen.model, "free-remote");
  assert.notEqual(p.ladder[0].model, "tiny-local");
});

test("persistence round-trips, and seed() ingests benchmark rows", () => {
  const c = createCompetence(); teach(c, "m", 3000, 4, 1);
  const d = createCompetence().load(JSON.parse(JSON.stringify(c.toJSON())));
  assert.deepEqual(d.estimate("m", "code.edit", 3000), c.estimate("m", "code.edit", 3000));
  const e = createCompetence().seed([{ model: "x", ctxTokens: 500, ok: true }, { model: "x", ctxTokens: 500, ok: false }, { model: "x", ok: "no" }]);
  assert.equal(e.cells()[0].s + e.cells()[0].f, 2);
});

test("token estimates and prices: code is denser than prose, paid models are priced, unknown tiers are free", () => {
  assert.ok(estimateTokens("x".repeat(240)) > estimateTokens("x".repeat(240), { code: false }));
  assert.equal(messagesTokens([{ role: "user", content: "x".repeat(240) }]), 84);
  assert.equal(priceOf("anthropic:claude-sonnet-5", "frontier").usdOutPerM, 15);
  assert.equal(priceOf("whatever", "local").usdInPerM, 0);
});

test("the plan states its own cost: a scoped step is far cheaper than the same job at full-transcript size", () => {
  const c = createCompetence(); teach(c, "claude-sonnet", 2000, 30, 0); teach(c, "claude-sonnet", 120000, 30, 0);
  const scoped = plan({ taskClass: "code.edit", ctxTokens: 2500, privacy: "any" }, [SONNET], c, { explore: 0 }).chosen.usd;
  const full = plan({ taskClass: "code.edit", ctxTokens: 120000, privacy: "any" }, [SONNET], c, { explore: 0 }).chosen.usd;
  assert.ok(full / scoped > 20, `${full} vs ${scoped}`);
});

// ───────────────────────── through the bridge ─────────────────────────
import { createBridge } from "./bridge-server.mjs";
async function withBridge(t, { local = [{ name: "tiny-local", ctxWindow: 8192 }], executors = [], comp = createCompetence() } = {}) {
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: "http://127.0.0.1:1", frontierExecutors: executors, competence: comp, listLocalModels: () => local, auditFile: null });
  await bridge.listen(); t.after(() => bridge.close());
  const base = "http://127.0.0.1:" + bridge.server.address().port;
  tokens.set(base, bridge.token); // the gate requires it on /api/dispatch/observe
  return base;
}
const tokens = new Map();
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-heimdall-token": tokens.get(base) || "" }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, j })));
const exec = (provider, model, key) => ({ executor: provider + ":" + model, endpoint: `https://${provider}.example/v1`, model, provider, location: "external", authClass: key ? "api_key" : "local_open", privacyClass: "sealed-only", auth: key ? { kind: "api_key", apiKey: "k" } : { kind: "none" }, live: { reachable: true, inflight: 0, queue: 0 }, advertised: {}, cost: {} });

test("bridge: /api/dispatch/plan lists local and frontier candidates and plans by cost when nothing is measured", async (t) => {
  const base = await withBridge(t, { executors: [exec("anthropic", "claude-sonnet-5", true), exec("pollinations", "openai-fast", false)] });
  const { j } = await post(base, "/api/dispatch/plan", { taskClass: "code.edit", ctxTokens: 2000, privacy: "any", explore: 0 });
  assert.deepEqual(j.ladder.map((r) => r.model), ["tiny-local", "openai-fast", "claude-sonnet-5"], "local, then free remote, then paid");
  assert.equal(j.ladder.find((r) => r.model === "claude-sonnet-5").tier, "frontier");
  assert.equal(j.bucket, "2k");
});

test("bridge: observations teach the plan — a verdict moves the default; a model's own word is refused", async (t) => {
  const base = await withBridge(t, { executors: [exec("anthropic", "claude-sonnet-5", true)] });
  for (let i = 0; i < 12; i++) await post(base, "/api/dispatch/observe", { model: "tiny-local", ctxTokens: 2000, ok: true });
  let p = (await post(base, "/api/dispatch/plan", { ctxTokens: 2000, privacy: "any", explore: 0 })).j;
  assert.equal(p.chosen.model, "tiny-local"); assert.match(p.chosen.why, /measured/);
  for (let i = 0; i < 30; i++) await post(base, "/api/dispatch/observe", { model: "tiny-local", ctxTokens: 2000, ok: false });
  p = (await post(base, "/api/dispatch/plan", { ctxTokens: 2000, privacy: "any", explore: 0 })).j;
  assert.notEqual(p.chosen.model, "tiny-local", "after it started failing the default moves up");
  const bad = await post(base, "/api/dispatch/observe", { model: "tiny-local", ok: "looks good to me" });
  assert.equal(bad.status, 400);
});

test("bridge: a local-only job never gets a remote rung, and messages are sized when no count is given", async (t) => {
  const base = await withBridge(t, { executors: [exec("anthropic", "claude-sonnet-5", true)] });
  const { j } = await post(base, "/api/dispatch/plan", { privacy: "local-only", messages: [{ role: "user", content: "x".repeat(2400) }], explore: 0 });
  assert.ok(j.ladder.every((r) => r.tier === "local")); assert.ok(j.ctxTokens > 700 && j.ctxTokens < 1000);
});

test("bridge: a model the ledger shows throttled (two 429s inside a minute) is excluded from the plan", async (t) => {
  const execs = [exec("pollinations", "openai-fast", false)];
  const sent = [];
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: "http://127.0.0.1:1", frontierExecutors: execs, competence: createCompetence(), listLocalModels: () => [], auditFile: null, frontierFetch: async () => { sent.push(1); return { ok: false, status: 429, body: null, json: async () => ({}) }; } });
  await bridge.listen(); t.after(() => bridge.close());
  const base = "http://127.0.0.1:" + bridge.server.address().port;
  for (let i = 0; i < 2; i++) await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "openai-fast", heimdall_privacy: "sealed-external", stream: false, messages: [{ role: "user", content: "x" }] }) });
  const { j } = await post(base, "/api/dispatch/plan", { ctxTokens: 500, privacy: "any", explore: 0 });
  assert.ok(j.excluded.some((e) => e.model === "openai-fast" && /throttled/.test(e.why)), JSON.stringify(j.excluded));
});

test("bridge: /api/dispatch/competence shows the table that plans are made from", async (t) => {
  const base = await withBridge(t);
  await post(base, "/api/dispatch/observe", { model: "tiny-local", ctxTokens: 3000, ok: true });
  const j = await (await fetch(base + "/api/dispatch/competence")).json();
  assert.equal(j.cells[0].model, "tiny-local"); assert.equal(j.cells[0].bucket, "4k"); assert.equal(j.cells[0].s, 1);
});

test("falsifier: a model MEASURED to fail ranks below one nobody has tried — failure is evidence, ignorance is not", () => {
  const c = createCompetence(); teach(c, "tiny-local", 2000, 4, 20);
  const p = plan({ taskClass: "code.edit", ctxTokens: 2000, privacy: "any" }, [LOCAL, SONNET], c, { explore: 0 });
  assert.deepEqual(p.ladder.map((r) => r.model), ["claude-sonnet", "tiny-local"]);
  assert.match(p.ladder[1].why, /measured to fail/);
});
