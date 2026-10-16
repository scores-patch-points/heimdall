// compose.js — a COMPOSITE job: pull the work apart by capability, route each
// part to the model good at it, and MERGE the outputs in the SYSTEM (a pure
// function — never a model draw). The whole is checked AFTER assembly, because
// the cut sees the whole stack (completeness ↔ Gebser, exclusivity ↔ Houdini;
// the Fold's own naming grammar).
//
// The canonical split is tool-calling vs generation: a part whose task class is
// `mechanical.tool` needs the `native-tools` capability, so it can only reach a
// model that advertises tools (a remote/API lane), while the generation part
// stays on the models good at text. Each part is its own VOID (src/void.js), so
// the competence table learns WHO IS GOOD AT TOOL CALLING separately from who is
// good at generation — and the system, not a model, joins the results.
//
// Decomposition is DECLARED (job.parts) or INFERRED mechanically from
// `requires`/`protocols` — never drawn. Parts that overlap a capability or fail
// to cover the job are refused with a typed gap, never run quietly.
import { makeJob, DOOR_CAPABILITIES, capabilitiesOf } from "./job.js";
import { runJob } from "./escalation.js";
import { runAcceptance } from "./acceptance.js";
import { chaseVoid, defVoid, satisfactionOf, learnSatisfaction, routedStats, SATISFACTION } from "./void.js";

/** The capabilities a part spec claims: its task class plus its required doors. */
const capsOfPart = (p) => capabilitiesOf({ taskClass: p.taskClass, requires: p.requires ?? [] });

/**
 * DEF the decomposition. Declared `job.parts` win; otherwise it is inferred
 * mechanically: a door or protocol needing `native-tools` becomes a tool part
 * (`mechanical.tool`), the rest a generation part (the job's own task class). No
 * tool need → a single `whole` part (a plain, non-composite job).
 */
export function partSpecs(job) {
  if (Array.isArray(job.parts) && job.parts.length) return job.parts.map((p, i) => ({ id: p.id ?? `part${i + 1}`, ...p }));
  const doors = job.requires ?? [];
  const toolDoors = doors.filter((d) => DOOR_CAPABILITIES[d] === "native-tools");
  const restDoors = doors.filter((d) => DOOR_CAPABILITIES[d] !== "native-tools");
  const wantsTools = toolDoors.length > 0 || (job.protocols ?? []).includes("native-tools");
  if (!wantsTools)
    return [{ id: "whole", taskClass: job.taskClass, requires: doors, protocols: job.protocols, acceptance: job.acceptance, output: job.output, task: job.task }];
  return [
    { id: "tool", taskClass: "mechanical.tool", requires: toolDoors, protocols: ["native-tools"], acceptance: job.toolAcceptance ?? [], output: { kind: "structured", maxTokens: job.output?.maxTokens ?? 500 }, task: `tool part: ${job.task ?? job.taskClass}` },
    { id: "generation", taskClass: job.taskClass, requires: restDoors, protocols: (job.protocols ?? []).filter((p) => p !== "native-tools"), acceptance: job.generationAcceptance ?? [], output: job.output, task: job.task },
  ];
}

/** Completeness (the parts cover every capability the job needs) and exclusivity
 *  (no capability appears in two parts) — the two conditions on the whole. */
export function coverCheck(job, parts) {
  const want = new Set(capabilitiesOf(job));
  const seen = new Map();
  for (const p of parts) {
    for (const c of capsOfPart(p)) {
      if (seen.has(c)) return { ok: false, gap: { kind: "not-exclusive", about: `capability ${c} appears in both ${seen.get(c)} and ${p.id}`, capability: c } };
      seen.set(c, p.id);
    }
  }
  const missing = [...want].filter((c) => !seen.has(c));
  if (missing.length) return { ok: false, gap: { kind: "not-complete", about: `the parts do not cover: ${missing.join(", ")}`, missing } };
  return { ok: true };
}

const textOf = (proposal) =>
  typeof proposal === "string" ? proposal : proposal && typeof proposal.text === "string" ? proposal.text : "";

/**
 * MERGE — a pure function of the part proposals, never a model draw. Always
 * `{ byPart: { <id>: proposal }, text }`; `merge: "fields"` additionally flattens
 * each object part's keys onto the merged object (collisions disclosed by order).
 */
export function assemble(job, results) {
  const byPart = {};
  for (const r of results) byPart[r.id] = r.proposal;
  const merged = { byPart, text: results.map((r) => textOf(r.proposal)).filter(Boolean).join("\n") };
  if (job.merge === "fields") for (const r of results) if (r.proposal && typeof r.proposal === "object" && !Array.isArray(r.proposal)) Object.assign(merged, r.proposal);
  return merged;
}

/** Build one part's sub-job from the parent (inherits the boundary, not the acceptance). */
const subJobOf = (job, p) =>
  makeJob({
    taskClass: p.taskClass,
    objective: job.objective,
    privacy: job.privacy,
    disclosure: job.disclosure,
    effects: job.effects,
    requires: p.requires ?? [],
    protocols: p.protocols ?? job.protocols ?? ["door-text"],
    output: p.output ?? job.output ?? { kind: "text", maxTokens: 500 },
    model: p.model ?? null,
    deadlineMs: job.deadlineMs,
    task: p.task ?? job.task,
    acceptance: p.acceptance ?? [],
    maxAttempts: job.maxAttempts,
    routing: p.routing ?? job.routing,
  });

/**
 * CHASE the whole composite: run each part as its own void, merge the proposals
 * in the system, then EVA the WHOLE against the job's acceptance. A part with
 * its own acceptance is chased (and teaches the table); a part with none is drawn
 * once and judged only in the whole (so per-part learning needs a per-part check).
 * Returns runJob-shaped `final`/`attempts` plus `parts`/`merged`, so it drops into
 * the same lane as a single job.
 */
export async function compose(job, deps = {}) {
  const parts = partSpecs(job);
  if (parts.length === 1 && parts[0].id === "whole") {
    const r = await chaseVoid(job, deps);
    return { ...r, composite: false };
  }

  const cover = coverCheck(job, parts);
  if (!cover.ok)
    return { jobId: job.id, composite: true, parts: [], merged: null, attempts: [], final: { state: "decomposition-refused", gap: cover.gap, reason: "the decomposition is not a valid cut" }, void: { satisfaction: SATISFACTION.gap, defined: true, slot: { taskClass: job.taskClass, capability: capabilitiesOf(job) } } };

  const byId = new Map((deps.routes || []).map((r) => [r.id, r]));
  const ctxTokens = deps.ctxTokens ?? 0;
  const results = [];
  const attempts = [];
  let elapsedMs = 0;
  for (const p of parts) {
    const pj = subJobOf(job, p);
    const trace = (pj.acceptance ?? []).length
      ? await chaseVoid(pj, { ...deps, ctxTokens })
      : await draw(pj, deps, byId, ctxTokens);
    results.push({
      id: p.id, taskClass: p.taskClass, capability: capsOfPart(p),
      state: trace.final.state, route: trace.final.route ?? null, proposal: trace.final.proposal ?? null,
      satisfaction: trace.void?.satisfaction ?? satisfactionOf(trace.final.acceptance),
      void: trace.void ?? null,
    });
    attempts.push(...(trace.attempts ?? []));
    elapsedMs += trace.final.elapsedMs ?? (trace.attempts ?? []).reduce((s, a) => s + (a.ms ?? 0), 0);
  }

  const merged = assemble(job, results);
  const acceptance = await runAcceptance(job.acceptance, merged, deps.ctx ?? {});
  const satisfaction = satisfactionOf(acceptance);
  return {
    jobId: job.id,
    composite: true,
    merge: job.merge ?? "byPart",
    parts: results,
    merged,
    attempts,
    final: {
      state: acceptance.state,
      route: null,
      proposal: satisfaction === SATISFACTION.satisfied ? merged : null,
      acceptance,
      satisfaction,
      elapsedMs,
    },
    void: {
      satisfaction,
      defined: true,
      slot: { taskClass: job.taskClass, capability: capabilitiesOf(job) },
      parts: results.map((r) => ({ id: r.id, taskClass: r.taskClass, capability: r.capability, satisfaction: r.satisfaction })),
    },
  };
}

/** A part with no acceptance of its own: draw ONE proposal (competence-informed),
 *  judged only in the whole. Nothing is learned here — a part with no check gives
 *  no verdict, and a gap is not evidence. */
async function draw(pj, deps, byId, ctxTokens) {
  const stats = deps.comp ? routedStats(deps.stats, deps.comp, byId, ctxTokens) : deps.stats;
  const trace = await runJob(pj, {
    routes: deps.routes, stats, execute: deps.execute, ctx: deps.ctx ?? {},
    explore: deps.explore, exposurePenaltyMs: deps.exposurePenaltyMs, attemptsLeft: pj.maxAttempts ?? 3,
    record: (entry) => { learnSatisfaction(deps.comp, { voidObj: defVoid(pj, { ctxTokens }), route: entry.route, attempt: entry.attempt }); deps.record?.(entry); },
  });
  return { ...trace, void: { satisfaction: trace.final.state === "accepted" ? SATISFACTION.satisfied : SATISFACTION.gap } };
}
