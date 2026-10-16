// compose.test.mjs — a composite job: split by capability, route each part to the
// model good at it, MERGE in the system, and check the whole after assembly.
import test from "node:test";
import assert from "node:assert/strict";
import { makeJob, validateJob, capabilitiesOf } from "./job.js";
import { createRouteStats } from "./route-stats.js";
import { createCompetence } from "./competence.js";
import { partSpecs, coverCheck, assemble, compose } from "./compose.js";

const ALL = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval", "structured-output"];
const local = (id, model, over = {}) => ({ id, kind: "local-model", trust: "local", model, capabilities: ALL, queue: 0, inflight: 0, networkMs: 0, serviceMs: 100, ...over });
const tools = (id, model, over = {}) => ({ id, kind: "remote", trust: "external", model, exposure: "sealed-external-text", capabilities: [...ALL, "native-tools", "long-context"], queue: 0, inflight: 0, networkMs: 100, serviceMs: 500, ...over });

// a job that needs a tool call AND generation; the parts carry their own checks
const toolJob = (over = {}) => makeJob({
  taskClass: "formal.code",
  requires: ["door:tool"],
  parts: [
    { id: "tool", taskClass: "mechanical.tool", acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 7 }] }] },
    { id: "generation", taskClass: "formal.code", acceptance: [{ type: "schema", schema: { type: "object", required: ["text"] } }] },
  ],
  acceptance: [{ type: "constraint", constraints: [{ path: "byPart.tool.value", op: "eq", value: 7 }] }],
  ...over,
});

const execute = async (route, j) => (j.taskClass === "mechanical.tool" ? { proposal: { value: 7 }, ms: 5 } : { proposal: { text: "hello" }, ms: 5 });

test("DEF the decomposition: declared parts win; otherwise inferred tool vs generation; no tool → whole", () => {
  const declared = partSpecs(toolJob());
  assert.deepEqual(declared.map((p) => p.id), ["tool", "generation"]);
  const inferred = partSpecs(makeJob({ taskClass: "formal.code", requires: ["door:tool"] }));
  assert.deepEqual(inferred.map((p) => p.id), ["tool", "generation"]);
  assert.equal(inferred[0].taskClass, "mechanical.tool");
  const whole = partSpecs(makeJob({ taskClass: "formal.code" }));
  assert.deepEqual(whole.map((p) => p.id), ["whole"]);
});

test("coverCheck: completeness and exclusivity are the two conditions on the whole", () => {
  assert.equal(coverCheck(toolJob(), partSpecs(toolJob())).ok, true);
  // exclusivity: two parts claiming composition
  const overlap = [{ id: "a", taskClass: "formal.code", requires: [] }, { id: "b", taskClass: "formal.code", requires: [] }];
  assert.equal(coverCheck(toolJob(), overlap).gap.kind, "not-exclusive");
  // completeness: a part missing the job's capability
  const partial = [{ id: "tool", taskClass: "mechanical.tool", requires: [] }];
  assert.equal(coverCheck(toolJob(), partial).gap.kind, "not-complete");
});

test("assemble is a pure function of the proposals (no model): byPart + text, and fields flattens", () => {
  const results = [{ id: "tool", proposal: { value: 7 } }, { id: "generation", proposal: { text: "hello" } }];
  const m = assemble(makeJob({ taskClass: "formal.code" }), results);
  assert.deepEqual(m.byPart.tool, { value: 7 });
  assert.equal(m.text, "hello");
  assert.equal(m.value, undefined);
  const f = assemble(makeJob({ taskClass: "formal.code", merge: "fields" }), results);
  assert.equal(f.value, 7); // flattened
  assert.equal(f.text, "hello");
});

test("compose: the tool part can only reach a tool-advertising model; generation stays local; whole accepted", async () => {
  const routes = [local("local", "good-gen"), tools("tools", "tool-model")];
  const r = await compose(toolJob(), { routes, stats: createRouteStats({}), execute });
  assert.equal(r.composite, true);
  assert.equal(r.final.state, "accepted");
  assert.equal(r.parts.find((p) => p.id === "tool").route, "tools");
  assert.equal(r.parts.find((p) => p.id === "generation").route, "local");
  assert.equal(r.merged.byPart.tool.value, 7);
});

test("compose: the WHOLE is checked after assembly — parts may pass and the job still be rejected", async () => {
  const routes = [local("local", "good-gen"), tools("tools", "tool-model")];
  const j = toolJob({ acceptance: [{ type: "constraint", constraints: [{ path: "byPart.tool.value", op: "eq", value: 999 }] }] });
  const r = await compose(j, { routes, stats: createRouteStats({}), execute });
  assert.equal(r.parts.every((p) => p.satisfaction === "satisfied"), true); // each part satisfied
  assert.equal(r.final.state, "rejected"); // but the merged whole is not
});

test("compose: an invalid cut (overlap) is refused, never run", async () => {
  let called = 0;
  const j = makeJob({ taskClass: "formal.code", parts: [{ taskClass: "formal.code" }, { taskClass: "formal.code" }], acceptance: [{ type: "schema", schema: {} }] });
  const r = await compose(j, { routes: [local("local", "m")], stats: createRouteStats({}), execute: async () => { called++; return { proposal: {}, ms: 1 }; } });
  assert.equal(r.final.state, "decomposition-refused");
  assert.equal(r.final.gap.kind, "not-exclusive");
  assert.equal(called, 0);
});

test("compose: a non-composite job is a single void (composite false)", async () => {
  const j = makeJob({ taskClass: "formal.check", acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 7 }] }] });
  const r = await compose(j, { routes: [local("local", "m")], stats: createRouteStats({}), execute: async () => ({ proposal: { value: 7 }, ms: 1 }) });
  assert.equal(r.composite, false);
  assert.equal(r.final.state, "accepted");
});

test("learning who is good at what, per part: tool calling and generation are learned apart", async () => {
  const routes = [local("local", "good-gen"), tools("tools", "tool-model")];
  const comp = createCompetence();
  const r = await compose(toolJob(), { routes, stats: createRouteStats({}), comp, execute });
  assert.equal(r.final.state, "accepted");
  assert.equal(comp.estimate("tool-model", "mechanical.tool", 0).mean, 1); // good at TOOL CALLING
  assert.equal(comp.estimate("good-gen", "formal.code", 0).mean, 1); // good at GENERATION
  assert.equal(comp.estimate("good-gen", "mechanical.tool", 0).mean, null); // never tried at tools — unknown, not assumed
});
