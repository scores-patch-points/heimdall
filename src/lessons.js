// lessons.js — what a stronger model taught the mechanical layer.
//
// When a route answers a code job and the job's own checks ACCEPT the answer, the verified function is appended here
// (content-addressed, append-only, one JSON object per line). Nothing in a lesson is trusted because a model wrote it:
// it is stored because it passed, and it is reused only by passing again. A lesson is used three ways, cheapest first:
//   · exact     the same spec asked again: the stored program is proposed, the checks run again
//   · transfer  a new ask with the same arity: every stored program is run on the new examples; one that satisfies
//               all of them is proposed (a different name or spec wording does not matter)
//   · primitive a one- or two-argument lesson joins the synthesizer's library, so later searches can compose it
// The next time, the mechanical lane answers and no model is asked.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tyOf } from "./synth.js";

export const DEFAULT_LESSONS_FILE = path.join(os.homedir(), ".heimdall", "lessons.jsonl");
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 20);
const norm = (t) => String(t ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const callable = (src, name) => new Function(`${src}\nreturn ${name}`)();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rename = (src, from, to) => (from === to ? src : src.replace(new RegExp(`\\b${from}\\b`, "g"), to));

export function createLessons({ file = null, max = 500 } = {}) {
  const rows = [];
  if (file && fs.existsSync(file))
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped, never repaired */ }
    }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const run = (lesson, args) => { try { return callable(lesson.code, lesson.name)(...structuredClone(args)); } catch { return undefined; } };

  const api = {
    all: () => [...byId.values()],
    /** Append a verified program. Returns the lesson (existing one when the same program was taught before). */
    add({ spec, name, params, code, examples, source }) {
      const id = sha(`${name}|${params.join(",")}|${code}`);
      if (byId.has(id)) return byId.get(id);
      const lesson = { id, spec: String(spec ?? ""), specKey: sha(norm(spec)), name, params, code, examples: examples.length, source, ts: Date.now() };
      // a lesson that does not satisfy its own examples is a bug in the caller, never stored
      if (!examples.every((e) => same(run(lesson, e.args), e.out))) throw new Error("lesson does not satisfy its own examples");
      byId.set(id, lesson);
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(lesson) + "\n"); }
      return lesson;
    },
    /** The same spec taught before. */
    exact(spec) { const k = sha(norm(spec)); return [...byId.values()].find((l) => l.specKey === k) ?? null; },
    /** A stored program that satisfies every new example, renamed to the new function. */
    transfer({ name, params, examples }) {
      for (const l of byId.values()) {
        if (l.params.length !== params.length) continue;
        if (!examples.every((e) => same(run(l, e.args), e.out))) continue;
        return { lesson: l, code: rename(l.code, l.name, name) };
      }
      return null;
    },
    /** One- and two-argument lessons as synthesizer primitives (types read from the examples they were learned on). */
    primitives(types = {}) {
      const out = [];
      for (const l of [...byId.values()].slice(-50)) {
        const t = types[l.id];
        if (!t) continue;
        const fn = callable(l.code, l.name);
        out.push({ name: `lesson_${l.id}`, args: t.args, ret: t.ret, fn, code: (...a) => `(${l.code.replace(/^\s*function\s+\w+/, "function")})(${a.join(", ")})` });
      }
      return out;
    },
    /** Learn the argument and return types of each stored program from a probe example set, for primitives(). */
    typesFor(probes) {
      const out = {};
      for (const l of byId.values()) {
        const p = probes.find((e) => e.args.length === l.params.length);
        if (!p) continue;
        const ret = run(l, p.args);
        if (ret === undefined) continue;
        out[l.id] = { args: p.args.map(tyOf), ret: tyOf(ret) };
      }
      return out;
    },
  };
  return api;
}
