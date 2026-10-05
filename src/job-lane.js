// job-lane.js — POST /api/job: the escalation design as an opt-in bridge route (2026-10).
//
// The bridge's existing doors take a model name; this one takes a JOB (job.js) and a
// PAYLOAD, resolves it to routes (local models, consented devices, remote services),
// runs the decision (escalation.js `runJob`), judges every returned proposal with the
// job's LOCAL acceptance checks (acceptance.js), and returns the whole trace.
//
//   body     { job: { taskClass, disclosure?, requires?, acceptance?, deadlineMs?, maxAttempts?, task?, model? },
//              payload: { capsule } | { messages },
//              context?: { sources?, witnessed?, situation?, key?, witnessedSet? } }
//   response { jobId, disclosure, route, state, proposal, acceptance, attempts[], decision[], routes[] }
//
// Rules it enforces (tested in job-lane.test.mjs against a fake wire):
//   · the capsule payload is RENDERED HERE from validated symbols — a caller cannot smuggle text
//     into an `abstract-capsule-only` job, and a capsule that is not only symbols is refused;
//   · a route outside this machine is eligible only if what it would see (the payload's form)
//     does not exceed the job's disclosure — a `none` job never leaves, and an escalation after a
//     local failure ends in a typed gap, not a looser route;
//   · `context` (the key, the witnessed set, source bytes) stays in this process: it is read by the
//     LOCAL checks and is never placed in any outbound body;
//   · every attempt is written to the dispatch ledger (`record`) with its verdict, and to the
//     persistent per-route × taskClass accept-rate table.

import { makeJob, validateJob, disclosureOf } from "./job.js";
import { runJob, exposureOf } from "./escalation.js";
import { runAcceptance, registerCheck } from "./acceptance.js";
import { validateCapsule, renderPrompt, proposalFromReply, registerCapsuleChecks } from "./capsule.js";
import { parseAnswer } from "./capsule.js";

const BASE_CAPS = ["reasoning", "classification", "composition", "extraction", "verification", "compute", "retrieval", "structured-output"];
const DEFAULTS = Object.freeze({ // labelled ASSUMPTIONS until the lane has measured the route itself (then EWMA of observed ms)
  "local-model": { networkMs: 0, serviceMs: 4000 },
  device: { networkMs: 150, serviceMs: 6000 },
  remote: { networkMs: 400, serviceMs: 2500 },
});

/**
 * deps.routes(payloadKind) → [{ id, kind, trust, model?, capabilities?, queue?, inflight?, run(messages, { maxTokens, signal }) → { text, ms?, tokens? } }]
 * deps.stats      a route-stats object      deps.record(entry)   the dispatch-ledger hook
 */
export function createJobLane({ stats, routes, record = () => {}, saveStats = () => {}, explore = "greedy", exposurePenaltyMs = 0 }) {
  registerCapsuleChecks();
  const observedMs = new Map(); // route id → EWMA service ms (measured)
  const ewma = (id, ms) => observedMs.set(id, observedMs.has(id) ? Math.round(0.6 * observedMs.get(id) + 0.4 * ms) : Math.round(ms));

  async function handle(body) {
    if (!body || typeof body !== "object") return { status: 400, body: { error: "body must be { job, payload }" } };
    const input = body.job || {};
    if (!input.taskClass) return { status: 400, body: { error: "job.taskClass is required" } };
    const job = makeJob({ privacy: input.privacy ?? "sealed-external", ...input });
    const v = validateJob(job);
    if (!v.ok) return { status: 400, body: { error: "invalid job", errors: v.errors } };
    const payload = body.payload || {};
    const context = body.context || {};

    // ── the payload: a capsule (rendered here) or caller messages
    let messages, form, capsule = null;
    if (payload.capsule) {
      const cv = validateCapsule(payload.capsule);
      if (!cv.ok) return { status: 400, body: { error: "not a sealed capsule — only opaque symbols and relations may be sent", errors: cv.errors } };
      capsule = payload.capsule;
      messages = [{ role: "user", content: renderPrompt(capsule) }];
      form = "capsule";
    } else if (Array.isArray(payload.messages) && payload.messages.length) {
      messages = payload.messages.map((m) => ({ role: String(m.role || "user"), content: String(m.content ?? "") }));
      form = "text";
    } else return { status: 400, body: { error: "payload needs { capsule } or { messages }" } };

    if (capsule && !context.key) return { status: 400, body: { error: "a capsule job needs context.key (the local symbol key); it stays in this process and is never sent" } };

    // ── routes: outside-the-machine routes expose the payload's FORM; local routes expose nothing
    const exposure = form === "capsule" ? "abstract-capsule-only" : "sealed-external-text";
    const rs = (await routes(form)).map((r) => {
      const d = DEFAULTS[r.kind] ?? DEFAULTS.remote;
      return {
        capabilities: BASE_CAPS, queue: 0, inflight: 0, ...r,
        exposure: r.trust === "local" ? "none" : exposure,
        networkMs: r.networkMs ?? d.networkMs,
        serviceMs: observedMs.get(r.id) ?? r.serviceMs ?? d.serviceMs,
        measuredService: observedMs.has(r.id),
      };
    });

    // ── execution of one attempt on one route
    const execute = async (route, j, { attempt, remainingMs }) => {
      const t0 = Date.now();
      const ms = remainingMs != null ? Math.max(1000, Math.min(remainingMs, 300000)) : 300000;
      try {
        const out = await route.run(messages, { maxTokens: j.output?.maxTokens ?? 800, signal: AbortSignal.timeout(ms) });
        const took = out.ms ?? Date.now() - t0;
        ewma(route.id, took);
        if (out.status === 429 || (out.status && out.status >= 500)) return { error: { code: `http_${out.status}`, message: out.note || `status ${out.status}` }, ms: took };
        let proposal;
        if (capsule) {
          const rep = proposalFromReply({ capsule, key: context.key, situation: context.situation, text: out.text });
          proposal = rep.proposal ?? undefined; // null/undefined → "unresolved" at the gate
        } else {
          const parsed = parseAnswer(out.text);
          proposal = parsed ?? (out.text && out.text.trim() ? { text: out.text.trim() } : undefined);
        }
        return { proposal, ms: took, tokens: out.tokens ?? null, text: out.text, selfReported: undefined };
      } catch (e) {
        const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
        return { error: { code: timedOut ? (j.deadlineMs != null ? "deadline" : "timeout") : e?.status ? `http_${e.status}` : "exception", message: String(e?.message || e).slice(0, 200) }, ms: Date.now() - t0 };
      }
    };

    // ── the local gate's context: the key and witnessed data stay HERE
    const ctx = {
      sources: context.sources, witnessed: context.witnessed,
      capsuleLocal: context.situation && context.witnessedSet ? { situation: context.situation, T: context.witnessedSet } : undefined,
      khoraUrl: context.khoraUrl, fetchImpl: context.fetchImpl,
    };

    const trace = await runJob(job, {
      routes: rs, stats, execute, ctx, explore, exposurePenaltyMs,
      record: ({ job: j, attempt, route }) => {
        record({ job: j, route, attempt });
      },
    });
    saveStats();
    const last = trace.attempts.at(-1);
    return {
      status: 200,
      body: {
        jobId: trace.jobId, disclosure: disclosureOf(job), form, state: trace.final.state,
        route: trace.final.route ?? last?.route ?? null,
        proposal: trace.final.proposal ?? null,
        acceptance: last?.acceptance ?? null,
        gap: trace.final.gap ?? null,
        attempts: trace.attempts.map((a) => ({ n: a.n, route: a.route, trust: a.trust, exposure: a.exposure, chosenBy: a.chosenBy, verdict: a.verdict, failureKind: a.failureKind, ms: a.ms, tokens: a.tokens, error: a.error, escalation: a.escalation ?? null, acceptance: a.acceptance })),
        decision: trace.attempts.map((a) => ({ n: a.n, candidates: a.candidates, excluded: a.excluded })),
        routes: rs.map((r) => ({ id: r.id, kind: r.kind, trust: r.trust, exposure: r.exposure, networkMs: r.networkMs, serviceMs: r.serviceMs, serviceMeasured: r.measuredService })),
        statsNow: stats.snapshot().cells.filter((c) => c.taskClass === job.taskClass),
      },
    };
  }
  return { handle, observedMs };
}

export { registerCheck, exposureOf, runAcceptance };
