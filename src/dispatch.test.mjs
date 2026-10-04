// dispatch.test.mjs — the ledger, the meter, and the estimates.
import test from "node:test";
import assert from "node:assert/strict";
import { record, meter } from "./dispatch.js";

test("a dispatch record carries the decision and its reasons", () => {
  const e = record({
    job: { id: "J144", taskClass: "formal.counterfactual" },
    selected: "groq:gpt-oss-120b",
    reason: "local congestion",
    candidates: [
      { executor: "local:qwen", eligible: true, expectedMs: 14120 },
      { executor: "groq:gpt-oss", eligible: true, expectedMs: 940 },
    ],
    actual: { ms: 1012, inputTokens: 219, outputTokens: 73, accepted: true },
  });
  assert.equal(e.job, "J144");
  assert.equal(e.selected, "groq:gpt-oss-120b");
  assert.equal(e.actual.ms, 1012);
  assert.equal(e.actual.accepted, true);
});

test("the meter counts lanes and the external token total is exact", () => {
  const entries2 = [
    { _lane: "deterministic/local", selected: "solver", actual: { outputTokens: 0 } },
    { _lane: "deterministic/local", selected: "local:qwen", actual: { outputTokens: 120 } },
    { _lane: "open remote", selected: "groq:gpt-oss-120b", actual: { outputTokens: 73 } },
    { _lane: "frontier", selected: "anthropic:claude", actual: { outputTokens: 58 } },
  ];
  const m = meter(entries2, { frontierCost: 1, rawContextCost: 22.7 });
  assert.equal(m.counts["deterministic/local"], 2);
  assert.equal(m.counts["open remote"], 1);
  assert.equal(m.counts.frontier, 1);
  assert.equal(m.externalTokens, 131, "73 + 58, exact");
  assert.equal(m.estimated.frontierEverything, 131);
  assert.ok(m.estimated.conventionalRawContext > m.estimated.frontierEverything);
  assert.match(m.estimated.note, /exact/);
});

test("a failed job still enters the ledger — that is how Heimdall learns", () => {
  const e = record({ job: { id: "B", taskClass: "formal.check" }, selected: "groq:gpt-oss-120b", reason: "expected_time", actual: { ms: 4100, accepted: false } });
  assert.equal(e.actual.accepted, false);
});