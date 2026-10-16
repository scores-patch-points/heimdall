#!/usr/bin/env node
// falsify-compose.mjs — try to break the composite job (split by capability, merge in the system).
//
// Claims under test, each a way to fail:
//   F1  the MERGE is a model call in disguise  — assemble must be a pure function, adding no route/execute
//   F2  the tool part reaches a model that cannot call tools, or a tool job is "filled" without one
//   F3  a composite is ACCEPTED when the whole check did not hold after assembly
//   F4  an overlapping or incomplete cut is run anyway (a bad cut is not refused)
//   F5  "who is good at tool calling" is confused with "who is good at generation"
import { makeJob } from "../src/job.js";
import { createRouteStats } from "../src/route-stats.js";
import { createCompetence } from "../src/competence.js";
import { partSpecs, coverCheck, assemble, compose } from "../src/compose.js";

const ALL = ["verification", "reasoning", "composition", "extraction", "classification", "compute", "retrieval", "structured-output"];
const local = (id, model, over = {}) => ({ id, kind: "local-model", trust: "local", model, capabilities: ALL, queue: 0, inflight: 0, networkMs: 0, serviceMs: 100, ...over });
const tools = (id, model, over = {}) => ({ id, kind: "remote", trust: "external", model, exposure: "sealed-external-text", capabilities: [...ALL, "native-tools", "long-context"], queue: 0, inflight: 0, networkMs: 100, serviceMs: 500, ...over });
const job = (over = {}) => makeJob({
  taskClass: "formal.code",
  requires: ["door:tool"],
  parts: [
    { id: "tool", taskClass: "mechanical.tool", acceptance: [{ type: "constraint", constraints: [{ path: "value", op: "eq", value: 7 }] }] },
    { id: "generation", taskClass: "formal.code", acceptance: [{ type: "schema", schema: { type: "object", required: ["text"] } }] },
  ],
  acceptance: [{ type: "constraint", constraints: [{ path: "byPart.tool.value", op: "eq", value: 7 }] }],
  ...over,
});
const tracer = () => { const calls = []; const execute = async (route, j) => { calls.push({ route: route.id, taskClass: j.taskClass }); return j.taskClass === "mechanical.tool" ? { proposal: { value: 7 }, ms: 5 } : { proposal: { text: "hi" }, ms: 5 }; }; return { calls, execute }; };

// F1: the merge adds no call — assemble is pure, and total calls equal the parts drawn
{
  const { calls, execute } = tracer();
  const r = await compose(job(), { routes: [local("local", "g"), tools("tools", "t")], stats: createRouteStats({}), execute });
  const merged = assemble(job(), r.parts.map((p) => ({ id: p.id, proposal: p.proposal })));
  const pureOk = merged.byPart.tool && merged.text !== undefined && calls.length === 2; // one draw per part, none for the merge
  console.log(`F1 merge is model-free: ${calls.length} model call(s) for 2 parts, assemble pure = ${!!merged.byPart.tool}. ${pureOk ? "PASS" : "FALSIFIED"}`);
}

// F2: the tool part only ever reaches a tool-advertising model; with no tool model, it is never invented
{
  const { calls, execute } = tracer();
  const r = await compose(job(), { routes: [local("local", "g"), tools("tools", "t")], stats: createRouteStats({}), execute });
  const leaked = calls.some((c) => c.taskClass === "mechanical.tool" && c.route !== "tools");
  const onlyTool = calls.filter((c) => c.taskClass === "mechanical.tool").every((c) => c.route === "tools");
  console.log(`F2a tool part only reaches tool models: ${leaked ? "LEAKED — FALSIFIED" : onlyTool ? "PASS" : "—"}`);

  const c2 = tracer();
  const noTool = await compose(job(), { routes: [local("local", "g")], stats: createRouteStats({}), execute: c2.execute });
  const toolToLocal = c2.calls.some((c) => c.taskClass === "mechanical.tool");
  const notFilled = noTool.final.state !== "accepted";
  console.log(`F2b no tool model → tool part never faked on a non-tool model: tool sent to local = ${toolToLocal}, job accepted = ${noTool.final.state === "accepted"}. ${!toolToLocal && notFilled ? "PASS" : "FALSIFIED"}`);
}

// F3: never accepted when the whole did not hold after assembly
{
  const j = job({ acceptance: [{ type: "constraint", constraints: [{ path: "byPart.tool.value", op: "eq", value: 999 }] }] });
  const r = await compose(j, { routes: [local("local", "g"), tools("tools", "t")], stats: createRouteStats({}), execute: tracer().execute });
  const partsOk = r.parts.every((p) => p.satisfaction === "satisfied");
  console.log(`F3 whole checked after assembly: parts satisfied=${partsOk}, job accepted=${r.final.state === "accepted"}. ${partsOk && r.final.state !== "accepted" ? "PASS" : "FALSIFIED"}`);
}

// F4: an overlapping or incomplete cut is refused, never run
{
  const bad = partSpecs(job({ parts: [{ taskClass: "formal.code" }, { taskClass: "formal.code" }] }));
  const cov = coverCheck(job({ parts: [{ taskClass: "formal.code" }] }), bad);
  const incomplete = coverCheck(job(), [{ id: "tool", taskClass: "mechanical.tool", requires: [] }]);
  console.log(`F4 bad cuts refused: overlap=${!cov.ok ? cov.gap.kind : "ran"} incomplete=${!incomplete.ok ? incomplete.gap.kind : "ran"}. ${!cov.ok && !incomplete.ok ? "PASS" : "FALSIFIED"}`);
}

// F5: tool-calling competence is not generation competence
{
  const comp = createCompetence();
  await compose(job(), { routes: [local("local", "gen-model"), tools("tools", "tool-model")], stats: createRouteStats({}), comp, execute: tracer().execute });
  const genAtTools = comp.estimate("gen-model", "mechanical.tool", 0).mean; // never tried at tools
  const toolAtTools = comp.estimate("tool-model", "mechanical.tool", 0).mean;
  const genAtGen = comp.estimate("gen-model", "formal.code", 0).mean;
  console.log(`F5 tool≠generation competence: gen-model@tools=${genAtTools} (must be null/unknown) tool-model@tools=${toolAtTools} gen-model@gen=${genAtGen}. ${genAtTools === null && toolAtTools === 1 && genAtGen === 1 ? "PASS" : "FALSIFIED"}`);
}
