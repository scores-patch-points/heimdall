import test from "node:test";
import assert from "node:assert/strict";
import { createCodeLadder, hostLoad, buildPrompt, extractFunction } from "./code-ladder.js";
import { createLessons } from "./lessons.js";
import { createRouteStats } from "./route-stats.js";

// SAFETY: the models are fakes that answer from a table; what is under test is the routing, the checks, the burden
// handling, and the learning, not any model.
const ex = (name, rows) => rows.map(([args, out]) => ({ args, out }));
const SUM = { name: "sum", params: ["a"], spec: "sum(list): the sum of the numbers in the array; 0 for an empty array", examples: ex("sum", [[[[1, 2, 3]], 6], [[[]], 0], [[[-1, 1]], 0], [[[10, 20]], 30], [[[5]], 5], [[[2, 2, 2, 2]], 8]]) };
const CHUNK = { name: "chunk", params: ["a", "n"], spec: "chunk(arr, n): split arr into consecutive arrays of length n; the last may be shorter", examples: ex("chunk", [[[[1, 2, 3, 4, 5], 2], [[1, 2], [3, 4], [5]]], [[[], 3], []], [[[1, 2], 5], [[1, 2]]], [[[1, 2, 3], 1], [[1], [2], [3]]], [[[1, 2, 3, 4], 2], [[1, 2], [3, 4]]], [[[1, 2, 3, 4, 5, 6, 7], 3], [[1, 2, 3], [4, 5, 6], [7]]]]) };
const CHUNK_OK = "```js\nfunction chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out }\n```";
const CHUNK_BAD = "```js\nfunction chunk(a, n) { return [a] }\n```";
const quiet = { ok: true, reasons: [], loadPerCpu: 0.1, inflight: 0 };
const mk = (over = {}) => {
  const calls = { local: [], remote: [] };
  const ladder = createCodeLadder({
    lessons: createLessons(), stats: createRouteStats(),
    localModels: ["qwen2.5-coder:1.5b"], remoteModels: ["claude-opus-5", "claude-haiku-4-5", "claude-sonnet-5"],
    load: () => quiet,
    infer: {
      local: async (m, p) => { calls.local.push([m, p]); return { text: CHUNK_BAD }; },
      remote: async (m, p) => { calls.remote.push([m, p]); return { text: CHUNK_OK }; },
    },
    ...over,
  });
  return { ladder, calls };
};

test("lane 1 first: a function the search can write is answered with no model asked", async () => {
  const { ladder, calls } = mk();
  const r = await ladder.solve(SUM);
  assert.equal(r.ok, true);
  assert.equal(r.lane, "tool:synth");
  assert.equal(calls.local.length + calls.remote.length, 0);
});

test("too few examples: the search declines (it would fit the examples, not the intent) and a model is asked", async () => {
  const { ladder, calls } = mk();
  const r = await ladder.solve({ ...SUM, examples: SUM.examples.slice(0, 3) });
  assert.notEqual(r.lane, "tool:synth");
  assert.ok(calls.local.length + calls.remote.length > 0);
});

test("a wrong local answer is rejected by the checks and the job escalates to the cheapest frontier model", async () => {
  const { ladder, calls } = mk();
  const r = await ladder.solve(CHUNK);
  assert.equal(r.ok, true);
  assert.equal(calls.local.length, 1);                                 // the free lane was tried
  assert.equal(calls.remote.length, 1);
  assert.equal(calls.remote[0][0], "claude-haiku-4-5");                // the cheapest of the three, not opus
  assert.match(r.lane, /^remote:claude-haiku/);
  assert.equal(r.trace.attempts.find((a) => a.route.startsWith("local:")).verdict, "rejected");
});

test("a burdened box is never asked: the local lane is set aside before it is called, the job goes straight to the frontier", async () => {
  const { ladder, calls } = mk({ load: () => ({ ok: false, reasons: ["load 2.40/cpu"], loadPerCpu: 2.4, inflight: 0 }) });
  const r = await ladder.solve(CHUNK);
  assert.equal(r.ok, true);
  assert.equal(calls.local.length, 0);
  assert.equal(r.routes.find((x) => x.id.startsWith("local:")).reachable, false);
  assert.match(r.routes.find((x) => x.id.startsWith("local:")).burden, /load/);
});

test("a local timeout puts the box in cooldown: the next job does not touch it", async () => {
  let t = 1_000;
  const calls = { local: 0, remote: 0 };
  const { ladder } = mk({ now: () => t, infer: { local: async () => { calls.local++; throw new Error("timeout after 120s"); }, remote: async () => { calls.remote++; return { text: CHUNK_OK }; } } });
  await ladder.solve(CHUNK);
  assert.equal(calls.local, 1);
  const again = await ladder.solve({ ...CHUNK, name: "chunk2", spec: "chunk2: same thing again, new words" });
  assert.equal(calls.local, 1);                                        // cooled down, not asked again
  assert.equal(again.routes.find((x) => x.id.startsWith("local:")).burden, "cooling down");
  t += 61_000;
  const third = await ladder.solve({ ...CHUNK, name: "chunk3", spec: "chunk3: a third wording" });
  assert.equal(third.routes.find((x) => x.id.startsWith("local:")).reachable, true); // the cooldown ended, the box is eligible again
});

test("a wrong frontier answer is not accepted and nothing is learned from it", async () => {
  const { ladder } = mk({ infer: { local: async () => ({ text: CHUNK_BAD }), remote: async () => ({ text: CHUNK_BAD }) } });
  const r = await ladder.solve(CHUNK);
  assert.equal(r.ok, false);
  assert.equal(r.learned, null);
  assert.equal(ladder.lessons.all().length, 0);
});

test("LEARNING: what the frontier taught is answered mechanically next time, with no model", async () => {
  const { ladder, calls } = mk();
  const first = await ladder.solve(CHUNK);
  assert.equal(first.ok, true);
  assert.ok(first.learned);
  assert.equal(calls.remote.length, 1);
  // the same ask again, a different name, different wording, a different example set
  const second = await ladder.solve({
    name: "splitEvery", params: ["items", "size"], spec: "break a list into pieces of a given size",
    examples: ex("splitEvery", [[[[1, 2, 3, 4], 3], [[1, 2, 3], [4]]], [[["a", "b"], 1], [["a"], ["b"]]], [[[], 2], []], [[[9], 4], [[9]]], [[[1, 2, 3, 4, 5, 6], 2], [[1, 2], [3, 4], [5, 6]]], [[[1, 2, 3, 4, 5], 5], [[1, 2, 3, 4, 5]]]]),
  });
  assert.equal(second.ok, true);
  assert.equal(second.lane, "tool:synth");
  assert.match(second.via, /^lesson:transfer/);
  assert.equal(calls.remote.length, 1);                                // no new frontier call
  assert.equal(calls.local.length, 1);                                 // no new local call
  assert.match(second.code, /function splitEvery/);
});

test("lessons persist as an append-only file and survive a restart", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lessons-")), "l.jsonl");
  const { ladder } = mk({ lessons: createLessons({ file }) });
  await ladder.solve(CHUNK);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(createLessons({ file }).all().length, 1);
  await ladder.solve(CHUNK);                                           // again: exact lesson, no duplicate line
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1);
});

test("the prompt is written by rule and carries only the spec, the examples and the latest failure", () => {
  const p = buildPrompt({ ...SUM, previous: "function sum(a){return 0}", fails: ["sum([1]) should return 1 but returned 0"] });
  assert.match(p, /sum\(\[1,2,3\]\) returns 6/);
  assert.match(p, /should return 1 but returned 0/);
  assert.match(extractFunction("const f = (x) => x + 1", "f"), /function f\(x\) \{ return x \+ 1 \}/);
  assert.equal(hostLoad({ inflight: 1, maxInflight: 1 }).ok, false);
});
