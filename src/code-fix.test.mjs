// code-fix.test.mjs — the generate→test loop: drafts are decided by the gate,
// lane failures are recorded, escalation is a different lane, and the privacy
// wall holds inside the loop. Every lane is faked (injected infer), the same
// way remote.test.mjs fakes a fetch.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeJob } from "./job.js";
import { createRegistry, emptyExecutor } from "./executors.js";
import { buildFixPrompt, extractFencedCode, evaluateWithGateScript, fixCode } from "./code-fix.js";

const GOOD = "export const x = 42;";

function job() {
  return makeJob({ taskClass: "formal.code", privacy: "local-raw", requires: ["door:write"] });
}

function registryWith(lanes) {
  const r = createRegistry();
  for (const [id, model] of Object.entries(lanes)) {
    const base = emptyExecutor({ executor: id, endpoint: "http://127.0.0.1:1", model, provider: "ollama", location: "local/LAN", authClass: "local_open", privacyClass: "local-raw" });
    r.put({ ...base, live: { ...base.live, reachable: true } });
  }
  return r;
}

function proven(exec) {
  return {
    ...exec,
    observed: {
      ...exec.observed,
      meanTTFT: 50,
      taskClasses: { "formal.code": { successes: 5, failures: 0 } },
    },
  };
}

test("a draft that passes the gate lands on the first lane and is observed as a success", async () => {
  const r = registryWith({ "ollama:qwen2.5-coder:1.5b": "qwen2.5-coder:1.5b" });
  const infer = async () => ({ text: GOOD, ms: 120, ttft: 80, tokens: 9, status: 200 });
  const res = await fixCode({ registry: r, job: job(), brief: "fix it", evaluate: async (code) => ({ ok: code === GOOD }), infer });

  assert.equal(res.ok, true);
  assert.equal(res.executor, "ollama:qwen2.5-coder:1.5b");
  assert.equal(res.code, GOOD);
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0].ok, true);

  const exec = r.get("ollama:qwen2.5-coder:1.5b");
  assert.equal(exec.observed.taskClasses["formal.code"].successes, 1);
  assert.equal(exec.live.inflight, 0);
  assert.equal(res.ledger[0].selected, "ollama:qwen2.5-coder:1.5b");
  assert.equal(res.ledger[0].actual.accepted, true);
});

test("a failing draft escalates to the next lane and lands there; the first lane's failure is recorded", async () => {
  const r = registryWith({
    "ollama:qwen2.5-coder:1.5b": "qwen2.5-coder:1.5b",
    "groq:gpt-oss-120b": "gpt-oss-120b",
  });
  r.put(proven(r.get("ollama:qwen2.5-coder:1.5b")));

  const draw = new Map([
    ["ollama:qwen2.5-coder:1.5b", "export const x = 1;"],
    ["groq:gpt-oss-120b", GOOD],
  ]);
  const infer = async (exec) => ({ text: draw.get(exec.executor), ms: 10, ttft: 5, tokens: 4, status: 200 });
  const res = await fixCode({ registry: r, job: job(), brief: "fix it", evaluate: async (code) => ({ ok: code === GOOD }), infer });

  assert.equal(res.ok, true);
  assert.equal(res.executor, "groq:gpt-oss-120b");
  assert.equal(res.attempts.length, 2);
  assert.equal(res.attempts[0].executor, "ollama:qwen2.5-coder:1.5b");
  assert.equal(res.attempts[0].ok, false);
  assert.equal(r.get("ollama:qwen2.5-coder:1.5b").observed.taskClasses["formal.code"].failures, 1);
  assert.equal(r.get("groq:gpt-oss-120b").observed.taskClasses["formal.code"].successes, 1);
});

test("escalation never re-draws the same lane; an exhausted single lane stops as no_untried_executor", async () => {
  const r = registryWith({ "ollama:qwen2.5-coder:1.5b": "qwen2.5-coder:1.5b" });
  const infer = async () => ({ text: "export const x = 1;", ms: 10, ttft: 5, tokens: 4, status: 200 });
  const res = await fixCode({ registry: r, job: job(), brief: "fix it", evaluate: async () => ({ ok: false, why: "still wrong" }), infer, maxAttempts: 3 });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_untried_executor");
  assert.equal(res.attempts.length, 1);
  assert.equal(res.code, undefined);
  assert.equal(r.get("ollama:qwen2.5-coder:1.5b").observed.taskClasses["formal.code"].failures, 1);
});

test("every lane failing is a gate_unmet, never a fabricated pass", async () => {
  const r = registryWith({
    "ollama:qwen2.5-coder:1.5b": "qwen2.5-coder:1.5b",
    "groq:gpt-oss-120b": "gpt-oss-120b",
  });
  const infer = async () => ({ text: "export const x = 1;", ms: 10, ttft: 5, tokens: 4, status: 200 });
  const res = await fixCode({ registry: r, job: job(), brief: "fix it", evaluate: async () => ({ ok: false, why: "nope" }), infer, maxAttempts: 2 });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "gate_unmet");
  assert.equal(res.attempts.length, 2);
  assert.equal(r.get("ollama:qwen2.5-coder:1.5b").observed.taskClasses["formal.code"].failures, 1);
  assert.equal(r.get("groq:gpt-oss-120b").observed.taskClasses["formal.code"].failures, 1);
});

test("with no eligible executor the run stops before any draw", async () => {
  const res = await fixCode({ registry: createRegistry(), job: job(), brief: "fix it", evaluate: async () => ({ ok: true }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_eligible_executor");
  assert.equal(res.attempts.length, 0);
});

test("a local-raw job never reaches an external sealed-only lane", async () => {
  const r = createRegistry();
  r.put({
    ...emptyExecutor({ executor: "groq:gpt-oss-120b", endpoint: "http://x", model: "gpt-oss-120b", provider: "groq", location: "external", authClass: "api_key", privacyClass: "sealed-only" }),
    live: { reachable: true },
  });
  const res = await fixCode({ registry: r, job: job(), brief: "fix it", evaluate: async () => ({ ok: true }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_eligible_executor");
});

test("a pinned model that fails stops the loop off the pin", async () => {
  const r = registryWith({ "ollama:qwen2.5-coder:1.5b": "qwen2.5-coder:1.5b" });
  const infer = async () => ({ text: "export const x = 1;", ms: 10, ttft: 5, tokens: 4, status: 200 });
  const res = await fixCode({
    registry: r,
    job: makeJob({ taskClass: "formal.code", privacy: "local-raw", model: "qwen2.5-coder:1.5b" }),
    brief: "fix it",
    evaluate: async () => ({ ok: false }),
    infer,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_untried_executor");
  assert.equal(res.attempts.length, 1);
});

test("an invalid job is refused", async () => {
  await assert.rejects(
    () => fixCode({ registry: createRegistry(), job: makeJob({ taskClass: "llm.guess" }), brief: "x", evaluate: async () => ({ ok: true }) }),
    /valid HeimdallJob@1/,
  );
});

test("evaluate is mandatory — a run without a gate is refused, never guessed", async () => {
  await assert.rejects(() => fixCode({ registry: createRegistry(), job: job(), brief: "x" }), /falsifying gate/);
});

test("extractFencedCode strips fences and keeps raw code", () => {
  assert.equal(extractFencedCode("```js\nexport const x = 42;\n```"), "export const x = 42;");
  assert.equal(extractFencedCode("  export const x = 42;  "), "export const x = 42;");
  assert.equal(extractFencedCode("```python\nprint(1)\n```"), "print(1)");
});

test("buildFixPrompt carries the brief, the current source, and the preserve-API instruction", () => {
  const p = buildFixPrompt({ brief: "Fix the rounding.", target: "export function r(x){return Math.round(x*100)/100;}" });
  assert.match(p, /Fix the rounding\./);
  assert.match(p, /CURRENT SOURCE:/);
  assert.match(p, /Preserve every exported name/);
  assert.match(p, /No markdown fences/);
});

test("evaluateWithGateScript runs a real gate script against the candidate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "code-fix-gate-"));
  try {
    const gatePath = path.join(dir, "gate.mjs");
    await writeFile(
      gatePath,
      `import { pathToFileURL } from "node:url";\nimport assert from "node:assert/strict";\nconst m = await import(pathToFileURL(process.argv[2]).href);\nassert.strictEqual(m.x, 42);\nconsole.log("GATE PASS");\n`,
      "utf8",
    );
    const evaluate = evaluateWithGateScript({ gatePath });

    const pass = await evaluate("export const x = 42;");
    assert.equal(pass.ok, true);

    const fail = await evaluate("export const x = 1;");
    assert.equal(fail.ok, false);
    assert.match(fail.why, /AssertionError|expected|GATE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});