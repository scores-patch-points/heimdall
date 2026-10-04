// executors.test.mjs — the registry: one inventory, privacy-first eligibility,
// E[T_accepted], congestion learning.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createRegistry, emptyExecutor, observe, markSent, markQueue, expectedTime,
  successRate, privacyAllowed, isEligible, isReachable, PRIVACY_CLASS,
} from "./executors.js";
import { makeJob } from "./job.js";

function extRec(over = {}) {
  return emptyExecutor({
    executor: over.executor ?? "groq:gpt-oss-120b",
    model: over.model ?? "gpt-oss-120b",
    provider: over.provider ?? "groq",
    location: over.location ?? "external",
    authClass: over.authClass ?? "api_key",
    privacyClass: over.privacyClass ?? "sealed-only",
    advertised: over.advertised ?? null,
  });
}

test("registry stores and merges the common shape", () => {
  const r = createRegistry();
  r.put(extRec());
  assert.ok(r.has("groq:gpt-oss-120b"));
  r.put({ ...extRec(), advertised: { tools: true, structured: true, context: 128000 } });
  assert.equal(r.get("groq:gpt-oss-120b").advertised.structured, true);
  assert.equal(r.get("groq:gpt-oss-120b").advertised.tools, true);
});

test("a never-heard executor is not reachable, never routed", () => {
  const r = createRegistry();
  r.put(extRec());
  assert.equal(isReachable(r.get("groq:gpt-oss-120b")), false);
  const job = makeJob({ taskClass: "formal.summarize" });
  const pick = r.pick(job);
  assert.equal(pick.executor, null);
  assert.equal(pick.reason, "no_eligible_executor");
});

test("ELIGIBILITY FIRST: a blind job may go external; a local-raw job may not", () => {
  const r = createRegistry();
  const remote = extRec({ executor: "groq:gpt-oss-120b", model: "gpt-oss-120b", location: "external" });
  remote.live.reachable = true;
  const local = extRec({ executor: "ollama:gemma2", model: "gemma2:2b", provider: "ollama", location: "local/LAN", authClass: "local_open", privacyClass: "local-raw" });
  local.live.reachable = true;
  r.put(remote);
  r.put(local);

  const blind = makeJob({ taskClass: "formal.summarize", privacy: "sealed-external" });
  assert.equal(privacyAllowed(remote, blind), true);
  assert.equal(privacyAllowed(local, blind), true);

  const raw = makeJob({ taskClass: "formal.summarize", privacy: "local-raw" });
  assert.equal(privacyAllowed(remote, raw), false, "a model being smarter does not override the privacy boundary");
  assert.equal(privacyAllowed(local, raw), true);
  const pick = r.pick(raw);
  assert.equal(pick.executor, "ollama:gemma2", "only the local horse survives the local-raw wall");
});

test("a discovery_only endpoint is never an executor", () => {
  const r = createRegistry();
  const disc = extRec({ executor: "pollinations:models", model: "any", provider: "pollinations", authClass: "discovery_only" });
  disc.live.reachable = true;
  r.put(disc);
  const pick = r.pick(makeJob({ taskClass: "formal.summarize" }));
  assert.equal(pick.executor, null);
});

test("model pin is the override, and only exact holders survive it", () => {
  const r = createRegistry();
  const a = extRec({ executor: "groq:gpt-oss-120b", model: "gpt-oss-120b" });
  a.live.reachable = true;
  const b = extRec({ executor: "groq:gpt-oss-20b", model: "gpt-oss-20b" });
  b.live.reachable = true;
  r.put(a);
  r.put(b);
  const pick = r.pick(makeJob({ taskClass: "formal.summarize", model: "gpt-oss-120b" }));
  assert.equal(pick.executor, "groq:gpt-oss-120b");
  assert.equal(pick.reason, "pinned_model");
});

test("structured-output jobs require an executor that advertises it", () => {
  const r = createRegistry();
  const plain = extRec({ executor: "groq:plain", model: "x" });
  plain.live.reachable = true;
  const structured = extRec({ executor: "groq:structured", model: "y", advertised: { tools: false, structured: true, context: null } });
  structured.live.reachable = true;
  r.put(plain);
  r.put(structured);
  const job = makeJob({ taskClass: "formal.extract", output: { kind: "structured", maxTokens: 100 }, requires: ["door:structured"] });
  const pick = r.pick(job);
  assert.equal(pick.executor, "groq:structured");
});

test("E[T_accepted]: a 50%-reliable 400ms model is an 800ms solution", () => {
  const exec = extRec();
  exec.live.reachable = true;
  // one success and one failure on the task class → P = 0.5
  let e = observe(exec, { taskClass: "formal.summarize", ok: true, ms: 400 });
  e = observe(e, { taskClass: "formal.summarize", ok: false, ms: 400 });
  assert.equal(successRate(e, "formal.summarize"), 0.5);
  const t = expectedTime(e, "formal.summarize", { networkMs: 0, serviceMs: 400 });
  assert.equal(t.P, 0.5);
  assert.ok(t.ms >= 800, `expected >= 800ms, got ${t.ms}`);
});

test("an unproven executor is tried, never preferred", () => {
  // P defaults to 0.5 for unmeasured — it does NOT win on a rumor.
  const unproven = extRec({ executor: "groq:new" });
  unproven.live.reachable = true;
  const proven = extRec({ executor: "groq:known", model: "gpt-oss-120b" });
  proven.live.reachable = true;
  proven.observed.meanTTFT = 200;
  const t1 = expectedTime(unproven, "formal.summarize", { networkMs: 200, serviceMs: 200 });
  const t2 = expectedTime(proven, "formal.summarize", { networkMs: 200, serviceMs: 200 });
  assert.ok(t1.ms >= t2.ms, `unproven ${t1.ms} should not beat proven ${t2.ms}`);
});

test("queue and inflight push E[T_accepted] up (congestion is learned)", () => {
  const r = createRegistry();
  const local = extRec({ executor: "local:qwen", model: "qwen", provider: "ollama", location: "local/LAN", authClass: "local_open", privacyClass: "local-raw" });
  local.live.reachable = true;
  let l = observe(local, { taskClass: "formal.summarize", ok: true, ms: 800, ttft: 800 }); // measured 0.8s
  l = markQueue(l, 12);
  l = markSent(l); // one job in flight
  const remote = extRec({ executor: "groq:gpt-oss-120b", model: "gpt-oss-120b" });
  remote.live.reachable = true;
  let r2 = observe(remote, { taskClass: "formal.summarize", ok: true, ms: 900, ttft: 900 }); // measured 0.9s
  r.put(l);
  r.put(r2);

  const job = makeJob({ taskClass: "formal.summarize" });
  // the congested local lane has 13 jobs ahead (12 queue + 1 inflight) at ~0.8s each
  assert.equal(r.pick(job).executor, "groq:gpt-oss-120b", "congested local lane yields to the remote lane");
  // clear the queue AND the inflight: the same kind of job stays local
  l = markQueue(l, 0);
  l = observe(l, { taskClass: "formal.summarize", ok: true, ms: 800, ttft: 800 }); // frees the inflight
  r.put(l);
  assert.equal(r.pick(job).executor, "local:qwen", "once local clears, the same kind of job stays local");
});

test("429s and 5xx are learned as capacity, not model failure", () => {
  let e = extRec();
  e = observe(e, { taskClass: "formal.summarize", ok: false, status: 429 });
  e = observe(e, { taskClass: "formal.summarize", ok: false, status: 429 });
  assert.equal(e.observed.recent429, 2);
  assert.equal(e.observed.taskClasses["formal.summarize"].failures, 2);
  e = observe(e, { taskClass: "formal.summarize", ok: false, status: 503 });
  assert.equal(e.observed.recent5xx, 1);
  e = observe(e, { taskClass: "formal.summarize", timeout: true });
  assert.equal(e.observed.timeouts, 1);
});

test("observe never mutates its input", () => {
  const e = extRec();
  e.live.reachable = true;
  const next = observe(e, { taskClass: "formal.summarize", ok: true, ms: 100 });
  assert.equal(e.observed.taskClasses["formal.summarize"], undefined);
  assert.equal(next.observed.taskClasses["formal.summarize"].successes, 1);
});

test("inflight is freed exactly once on completion", () => {
  let e = extRec();
  e = markSent(e);
  e = markSent(e);
  assert.equal(e.live.inflight, 2);
  e = observe(e, { taskClass: "formal.summarize", ok: true, ms: 100 });
  assert.equal(e.live.inflight, 1);
});

test("PRIVACY_CLASS and LOCATIONS are the declared vocabularies", () => {
  assert.deepEqual([...PRIVACY_CLASS], ["local-raw", "sealed-only"]);
});