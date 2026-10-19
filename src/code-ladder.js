// code-ladder.js — write a function by the cheapest lane that passes the checks, and LEARN from the dearer lanes.
//
// The ladder, cheapest first (escalation.js `choose` with routing "cheapest": cost per accepted answer):
//   1. tool:synth        no model. Lessons (exact, transfer), then an enumerative search from the examples.
//   2. local:<model>     a small local model, asked by a mechanically written prompt (spec, examples, the one failing
//                        case in plain words). Free, but a box can be burdened: a route whose host is loaded, whose
//                        slots are taken, or that recently timed out is set aside BEFORE it is asked (`reachable:false`),
//                        so the job goes straight to the next lane instead of queueing behind it.
//   3. remote:<model>    the cheapest frontier model, sealed-external text only, priced from DEFAULT_PRICES. In practice it
//                        usually answers, so a burdened box costs one cheap call, not a stalled job.
// Every lane returns a PROPOSAL; the job's own checks (the examples, run locally) decide. A model's confidence is never read.
//
// LEARNING. When a lane accepted by the checks is dearer than the mechanical one (a local or remote model), the verified
// program is appended to the lessons store (lessons.js). The next ask that the stored program satisfies, or that can be
// composed from it, is answered by lane 1 and no model is asked. Over time the share answered by lane 1 grows; the trace
// of every job records which lane answered, so that share is measured, not asserted.

import os from "node:os";
import { makeJob, capabilitiesOfTaskClass } from "./job.js";
import { runJob } from "./escalation.js";
import { createRouteStats } from "./route-stats.js";
import { registerCheck } from "./acceptance.js";
import { priceOf } from "./competence.js";
import { synth } from "./synth.js";
import { createLessons } from "./lessons.js";

const TASK_CLASS = "formal.code";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

/** Pull one function out of a model's reply: the first code block if there is one, else the text. */
export function extractFunction(text, name) {
  const m = /```(?:\w+)?\n([\s\S]*?)```/.exec(String(text ?? ""));
  let src = (m ? m[1] : String(text ?? "")).trim().replace(/^export\s+(default\s+)?/gm, "");
  const arrow = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=\\s*(\\([^)]*\\)|\\w+)\\s*=>\\s*([\\s\\S]*?);?\\s*$`).exec(src);
  if (arrow && !/^function\b/.test(src)) {
    const body = arrow[2].trim();
    src = `function ${name}${arrow[1].startsWith("(") ? arrow[1] : `(${arrow[1]})`} ${body.startsWith("{") ? body : `{ return ${body} }`}`;
  }
  return src;
}
const compile = (code, name) => new Function(`${code}\nreturn ${name}`)();

/** The one check every code job carries: run the function on the examples, locally. */
const failuresOf = (code, name, cases) => {
  let fn;
  try { fn = compile(code, name); } catch (e) { return [`the code does not run: ${e.message}`]; }
  const fails = [];
  for (const c of cases) {
    try {
      const got = fn(...structuredClone(c.args));
      if (!same(got, c.out)) fails.push(`${name}(${c.args.map(show).join(", ")}) should return ${show(c.out)} but returned ${show(got)}`);
    } catch (e) { fails.push(`${name}(${c.args.map(show).join(", ")}) threw ${e.message}`); }
  }
  return fails;
};
const lastFails = new Map(); // job key -> failing cases of the latest rejected proposal (feeds the next prompt)
registerCheck("code-ladder.examples", (proposal, _ctx, check) => {
  const code = proposal?.code;
  if (typeof code !== "string") return { ok: false, detail: "no code in the proposal" };
  const fails = failuresOf(code, check.name, check.cases);
  lastFails.set(check.key, fails);
  return fails.length ? { ok: false, kind: "check_failed", detail: fails.slice(0, 3).join("; ") } : { ok: true, detail: `${check.cases.length} examples hold` };
});

/** The prompt, written by rule: the spec, the examples as plain statements, and the latest failure if there was one. */
export function buildPrompt({ name, params, spec, examples, previous = null, fails = [] }) {
  const lines = [`Write a JavaScript function ${name}(${params.join(", ")}).`, spec, "", "Examples:", ...examples.map((e) => `- ${name}(${e.args.map(show).join(", ")}) returns ${show(e.out)}`)];
  if (previous) lines.push("", "Your previous attempt:", "```js", previous, "```", `It is wrong. ${fails.slice(0, 1).join(" ")} Write a corrected version.`);
  lines.push("", "Reply with only the code in one code block.");
  return lines.join("\n");
}

/** How burdened this machine is right now. Pure data, so a test can inject it. */
export function hostLoad({ inflight = 0, maxInflight = 1, cpus = os.cpus().length, loadavg = os.loadavg()[0], maxLoadPerCpu = 1.25, freeMemRatio = os.freemem() / os.totalmem() } = {}) {
  const loadPerCpu = loadavg / Math.max(1, cpus);
  const reasons = [];
  if (inflight >= maxInflight) reasons.push(`slots full (${inflight}/${maxInflight})`);
  if (loadPerCpu > maxLoadPerCpu) reasons.push(`load ${loadPerCpu.toFixed(2)}/cpu`);
  if (freeMemRatio < 0.08) reasons.push("memory tight");
  return { ok: reasons.length === 0, reasons, loadPerCpu, inflight };
}

/** The cheapest model of a list, by its declared price per million tokens (in + out). */
export const cheapest = (models) => [...models].sort((a, b) => { const pa = priceOf(a), pb = priceOf(b); return pa.usdInPerM + pa.usdOutPerM - (pb.usdInPerM + pb.usdOutPerM); })[0];

/**
 * The ladder. Injected, so tests and the fleet share it:
 *   infer.local(model, prompt)    → { text, ms?, tokens? }   throws on timeout/error
 *   infer.remote(model, prompt)   → { text, ms?, tokens? }
 *   localModels, remoteModels     model ids; the cheapest remote one is the frontier lane
 *   load()                        → hostLoad(...) shape; default reads this machine
 */
export function createCodeLadder({
  lessons = createLessons(),
  stats = createRouteStats(),
  infer = {},
  localModels = [],
  remoteModels = [],
  load = () => hostLoad(),
  minExamples = 6,
  searchMs = 1500,
  cooldownMs = 60_000,
  now = () => Date.now(),
  record = () => {},
} = {}) {
  const cap = capabilitiesOfTaskClass(TASK_CLASS);
  const cooling = new Map(); // route id -> until
  let inflight = 0;
  let seq = 0;

  const routesNow = (examples) => {
    const l = load({ inflight });
    const routes = [{ id: "tool:synth", kind: "local-tool", trust: "local", capabilities: cap, serviceMs: 50, reachable: true }];
    for (const m of localModels) {
      const id = `local:${m}`;
      const cool = (cooling.get(id) ?? 0) > now();
      routes.push({ id, kind: "local-model", model: m, trust: "local", capabilities: cap, serviceMs: 4000, queue: inflight, reachable: l.ok && !cool && !!infer.local, burden: cool ? "cooling down" : l.reasons.join(", ") });
    }
    const f = remoteModels.length ? cheapest(remoteModels) : null;
    if (f) {
      const p = priceOf(f);
      routes.push({ id: `remote:${f}`, kind: "remote", model: f, trust: "external", exposure: "sealed-external-text", capabilities: cap, serviceMs: 3000, reachable: !!infer.remote, usdInPerM: p.usdInPerM, usdOutPerM: p.usdOutPerM, inputTokens: 400, outputTokens: 200 });
    }
    return routes;
  };

  const attemptState = new Map(); // job id -> { previous, key }
  const execute = (spec) => async (route, job) => {
    const st = attemptState.get(job.id);
    if (route.id === "tool:synth") {
      const t0 = now();
      const exact = lessons.exact(spec.spec);
      const hit = exact && exact.params.length === spec.params.length ? { code: exact.code.replace(new RegExp(`\\b${exact.name}\\b`, "g"), spec.name), via: "lesson:exact" } : null;
      const moved = !hit && lessons.transfer(spec);
      if (hit || moved) return { proposal: { code: (hit ?? moved).code ?? moved.code, via: hit ? hit.via : `lesson:transfer:${moved.lesson.id}` }, ms: now() - t0 };
      if (spec.examples.length < minExamples) return { error: { code: "too_few_examples", message: `${spec.examples.length} examples underdetermine the function (needs ${minExamples}); a search would fit the examples, not the intent` }, ms: now() - t0 };
      const types = lessons.typesFor(spec.examples);
      const r = synth(spec.params, spec.examples, { budgetMs: searchMs, maxSize: 8, learned: lessons.primitives(types) });
      if (!r.code) return { error: { code: "no_program", message: r.timeout ? "search budget spent" : "search space exhausted" }, ms: now() - t0 };
      return { proposal: { code: `function ${spec.name}(${spec.params.join(", ")}) { return ${r.code} }`, via: "synth" }, ms: now() - t0 };
    }
    const kind = route.kind === "remote" ? "remote" : "local";
    const prompt = buildPrompt({ ...spec, previous: st.previous, fails: lastFails.get(st.key) ?? [] });
    const t0 = now();
    if (kind === "local") inflight++;
    try {
      const out = await infer[kind](route.model, prompt);
      const code = extractFunction(out.text, spec.name);
      st.previous = code;
      return { proposal: { code, via: route.id }, ms: out.ms ?? now() - t0, tokens: out.tokens ?? null };
    } catch (e) {
      if (kind === "local") cooling.set(route.id, now() + cooldownMs); // a timeout or error: leave this box alone for a while
      return { error: { code: /timeout/i.test(String(e?.message)) ? "timeout" : "route_error", message: String(e?.message ?? e) }, ms: now() - t0 };
    } finally {
      if (kind === "local") inflight--;
    }
  };

  return {
    lessons,
    stats,
    /** Solve { name, params, spec, examples:[{args,out}] }. Returns { code, lane, trace, learned }. */
    async solve(spec) {
      const key = `k${++seq}`;
      const routes = routesNow(spec.examples);
      const job = makeJob({
        taskClass: TASK_CLASS,
        routing: "cheapest",
        privacy: routes.some((r) => r.trust === "external") ? "sealed-external" : "local-raw",
        task: { spec: spec.spec, name: spec.name },
        maxAttempts: Math.max(1, routes.length),
        acceptance: [{ type: "custom", fn: "code-ladder.examples", name: spec.name, cases: spec.examples, key }],
      });
      attemptState.set(job.id, { previous: null, key });
      const trace = await runJob(job, { routes, stats, execute: execute(spec), record });
      attemptState.delete(job.id);
      lastFails.delete(key);
      const final = trace.final;
      const lane = final.route ?? null;
      let learned = null;
      const fromLessons = String(final.proposal?.via ?? "").startsWith("lesson:");
      if (final.state === "accepted" && !fromLessons) {
        // taught by a dearer lane, or found by search: store the verified program so lane 1 answers next time
        learned = lessons.add({ spec: spec.spec, name: spec.name, params: spec.params, code: final.proposal.code, examples: spec.examples, source: { lane, via: final.proposal.via } }).id;
      }
      return { ok: final.state === "accepted", code: final.proposal?.code ?? null, lane, via: final.proposal?.via ?? null, learned, trace, routes: routes.map((r) => ({ id: r.id, reachable: r.reachable, burden: r.burden })) };
    },
  };
}
