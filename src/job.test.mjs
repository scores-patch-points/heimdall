// job.test.mjs — HeimdallJob@1 contract (falsifying controls per the schema).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA, TASK_CLASSES, isTaskClass, taskClassFor, capabilitiesOf, satisfies,
  mayLeave, makeJob, validateJob, DOOR_CAPABILITIES,
} from "./job.js";

test("a valid job validates", () => {
  const job = makeJob({ taskClass: "formal.counterfactual", privacy: "sealed-external", requires: ["door:compare", "door:structured"], output: { kind: "structured", maxTokens: 500 } });
  assert.deepEqual(validateJob(job), { ok: true, errors: [] });
});

test("an unknown taskClass is refused, not guessed", () => {
  const job = makeJob({ taskClass: "llm.guess", privacy: "sealed-external" });
  const v = validateJob(job);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("unknown taskClass")));
});

test("an unknown door is refused", () => {
  const job = makeJob({ taskClass: "formal.check", requires: ["door:not-real"] });
  const v = validateJob(job);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("unknown door")));
});

test("structured output requires the structured-output capability", () => {
  const job = makeJob({ taskClass: "formal.extract", output: { kind: "structured", maxTokens: 100 } });
  const v = validateJob(job);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("structured-output")));
});

test("taskClassFor maps plain asks mechanically, never from a model", () => {
  assert.equal(taskClassFor("counterfactual"), "formal.counterfactual");
  assert.equal(taskClassFor("COMPARE these two"), "formal.compare");
  assert.equal(taskClassFor("summarize"), "formal.summarize");
  assert.equal(taskClassFor("nonsense ask"), null);
  assert.equal(taskClassFor("formal.counterfactual"), "formal.counterfactual");
});

test("capabilitiesOf combines the task class and every required door", () => {
  const job = makeJob({ taskClass: "formal.check", requires: ["door:find", "door:structured"] });
  const caps = capabilitiesOf(job);
  assert.ok(caps.includes("verification"));
  assert.ok(caps.includes("retrieval"));
  assert.ok(caps.includes("structured-output"));
});

test("satisfies is strict: a missing capability is a refusal", () => {
  const job = makeJob({ taskClass: "formal.check", requires: ["door:structured"] });
  assert.equal(satisfies(job, ["verification"]), false);
  assert.equal(satisfies(job, ["verification", "structured-output"]), true);
});

test("mayLeave: local-raw never leaves; sealed-external may", () => {
  assert.equal(mayLeave(makeJob({ taskClass: "formal.summarize", privacy: "local-raw" })), false);
  assert.equal(mayLeave(makeJob({ taskClass: "formal.summarize", privacy: "sealed-external" })), true);
});

test("model pin is the override, not the default", () => {
  const unpinned = makeJob({ taskClass: "formal.summarize" });
  assert.equal(unpinned.model, null);
  const pinned = makeJob({ taskClass: "formal.summarize", model: "groq:gpt-oss-120b" });
  assert.equal(pinned.model, "groq:gpt-oss-120b");
});

test("every TASK_CLASSES member validates as itself", () => {
  for (const cls of Object.keys(TASK_CLASSES)) {
    assert.equal(isTaskClass(cls), true, cls);
    const v = validateJob(makeJob({ taskClass: cls }));
    assert.equal(v.ok, true, cls);
  }
});

test("every door has a capability mapping (so requires is never a dead letter)", () => {
  for (const door of Object.keys(DOOR_CAPABILITIES)) assert.ok(DOOR_CAPABILITIES[door]);
});