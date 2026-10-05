// free-bench.js — the pure core of the free-model benchmark (2026-10).
//
// Question it answers about every free / keyless / local model, on randomized tasks that carry SEQUENTIAL follow-ups:
//   (1) ACTIVE   does it answer at all, right now? (and why not: quota, rate limit, 5xx, hang, empty)
//   (2) QUICK    how long until the first token and until the whole answer?
//   (3) ACCURATE & WORTH IT   is the answer right, judged by an EXACT local check, and what does an accepted answer cost in time?
//
// Two task families, both SEALED (nothing but opaque symbols or masked placeholders ever leaves):
//   order   the sealed capsule of capsule.js — K possible worlds of `X<Y` statements over opaque symbols; ask what follows
//           in each. Turn 1 is the capsule; turns 2..n are SYMBOL-ONLY follow-ups in the same conversation that add or
//           retract one statement in every world ("now also…", "now withdraw…", "undo that"). The model must carry state.
//           The answer is recomputed locally (transitive closure) and judged by capsule.js's own acceptance gate.
//   mask    a code edit over a masked snippet (TERM_1, PATH_2, EMAIL_1, SECRET_3, HOST_1, USER_1 …) — what the-fold's
//           de-identifier emits. Every turn asks for one more edit; the check is mechanical: every placeholder survives
//           byte-for-byte, none is renamed / lowercased / digit-dropped / invented, and the requested edit is present.
//
// Pure: seed and clock are injected, no network. The runner is scripts/free-bench.mjs. Tests: free-bench.test.mjs.

import {
  mulberry32, makeSituation, sampleWitness, buildCapsule, renderPrompt, createSymbolRegistry, closureOf, checkDerived,
  proposalFromReply, parseAnswer, CAPSULE_ACCEPTANCE, registerCapsuleChecks, SYMBOL_RE, pid,
} from "./capsule.js";
import { runAcceptance } from "./acceptance.js";
import { wilson } from "./capsule-attack.js";

registerCapsuleChecks();
export { wilson };

const pick = (rng, n) => Math.floor(rng() * n);
const choose = (rng, a) => a[pick(rng, a.length)];
const shuffled = (a, rng) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = pick(rng, i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; };

// ───────────────────────── order family: sealed worlds + symbol-only follow-ups ─────────────────────────

const TAIL = "Same task: for EACH world, give every pair X<Y that follows by chaining two or more of that world's statements and is not itself stated there. Reply with JSON only, in the same format as before.";
export const FOLLOWUP = Object.freeze({
  add: (s) => `Now add this statement to every world: ${s}. If a world already has it, leave that world unchanged. ${TAIL}`,
  retract: (s) => `Now withdraw this statement from every world, it is no longer established: ${s}. If a world does not have it, leave that world unchanged. ${TAIL}`,
  undo: (s) => `Undo your previous change: withdraw ${s} from every world again. ${TAIL}`,
});

const pairKey = (a, b) => `${a}>${b}`;
const acyclic = (n, pairs) => closureOf(n, pairs).acyclic;

/** One randomized order task: a capsule, then `turns - 1` follow-ups. Every turn carries the local ground truth. */
export function makeOrderTask(seed, { K = 3, turns = 3, registry = createSymbolRegistry({ rng: mulberry32(seed ^ 0x9e3779b9) }) } = {}) {
  const rng = mulberry32(seed);
  const situation = makeSituation(rng);
  const T0 = sampleWitness(situation, rng);
  const { capsule, key } = buildCapsule({ situation, witnessed: T0, construction: "symmetric-exchangeable", K, rng, registry });
  const n = situation.n, symOf = capsule.events, claims = situation.claims;
  let real = T0.slice();
  let worlds = capsule.worlds.map((w) => w.claims.map(([a, b]) => [key.eventOf[a], key.eventOf[b]]));
  const statement = (i) => `${symOf[claims[i].a]}<${symOf[claims[i].b]}`;
  const derivedSize = (idx) => closureOf(n, idx.map((i) => [claims[i].a, claims[i].b])).derived.length;
  const snapshot = () => ({ T: real.slice(), truth: worlds.map((w) => { const c = closureOf(n, w); return c.acyclic ? new Set(c.derived.map(([a, b]) => pid(a, b, n))) : null; }) });
  const out = [{ kind: "base", message: renderPrompt(capsule), ...snapshot() }];
  let lastAdded = null;
  const apply = (op, i) => {
    const [a, b] = [claims[i].a, claims[i].b];
    if (op === "add") { real = [...new Set([...real, i])]; worlds = worlds.map((w) => (w.some(([x, y]) => x === a && y === b) ? w : [...w, [a, b]])); lastAdded = i; }
    else { real = real.filter((x) => x !== i); worlds = worlds.map((w) => w.filter(([x, y]) => !(x === a && y === b))); if (lastAdded === i) lastAdded = null; }
  };
  const candidates = {
    add: () => { const base = derivedSize(real); const all = claims.map((_, i) => i).filter((i) => !real.includes(i) && acyclic(n, [...real, i].map((x) => [claims[x].a, claims[x].b]))); const live = all.filter((i) => derivedSize([...real, i]) > base); return live.length ? live : all; },
    retract: () => { const all = real.filter((i) => real.length > 2); const live = all.filter((i) => derivedSize(real.filter((x) => x !== i)) >= 1); return live.length ? live : all; },
    undo: () => (lastAdded != null && real.includes(lastAdded) && real.length > 2 && derivedSize(real.filter((x) => x !== lastAdded)) >= 1 ? [lastAdded] : []),
  };
  for (let t = 1; t < turns; t++) {
    const order = t === 1 ? ["add", "retract"] : shuffled(["add", "retract", "undo"], rng);
    let done = false;
    for (const op of order) {
      const c = candidates[op]();
      if (!c.length) continue;
      const i = choose(rng, c);
      apply(op, i);
      out.push({ kind: op, message: FOLLOWUP[op](statement(i)), ...snapshot() });
      done = true; break;
    }
    if (!done) break;
  }
  return { family: "order", seed, K, capsule, key, situation, turns: out, issued: new Set(symOf) };
}

/** Score one reply to an order turn. Judged by capsule.js's own gate, and cross-checked against an independent recomputation
 *  (gate false-accepts / false-rejects are counted so a broken gate shows up as a number, not a silent pass). */
export async function scoreOrderTurn(task, idx, text) {
  const turn = task.turns[idx];
  const parsed = parseAnswer(text);
  const rep = proposalFromReply({ capsule: task.capsule, key: task.key, situation: task.situation, text });
  if (!rep.proposal) return { parsed: !!parsed, answered: false, exact: false, accepted: false, failure: rep.failure?.kind ?? "unresolved", missing: null, extra: null, allWorldsExact: false };
  const chk = checkDerived(task.situation, turn.T, rep.proposal.pairs);
  const gate = await runAcceptance(CAPSULE_ACCEPTANCE, rep.proposal, { capsuleLocal: { situation: task.situation, T: turn.T } });
  // every consistent world, not only the one that matters
  const n = task.situation.n;
  let allWorldsExact = true;
  for (let j = 0; j < task.capsule.worlds.length; j++) {
    const want = turn.truth[j]; if (want == null) continue; // an inconsistent world has no defined answer
    const ans = parsed?.[String(j + 1)];
    if (!Array.isArray(ans)) { allWorldsExact = false; continue; }
    const got = new Set();
    let bad = false;
    for (const p of ans) { if (!Array.isArray(p) || !(p[0] in task.key.eventOf) || !(p[1] in task.key.eventOf)) { bad = true; break; } got.add(pid(task.key.eventOf[p[0]], task.key.eventOf[p[1]], n)); }
    if (bad || got.size !== want.size || ![...want].every((x) => got.has(x))) allWorldsExact = false;
  }
  return { parsed: true, answered: true, exact: chk.exact, accepted: !!gate.accepted, missing: chk.missing, extra: chk.extra, contradicts: chk.contradicts, allWorldsExact, gateAgrees: !!gate.accepted === chk.exact };
}

const WORD = /[A-Za-z0-9]+/g;
const symRe = /^[E][a-z0-9]{5}$/;
/** The words every legitimate order message is made of: the heimdall-rendered head, the follow-up templates, "World N". */
export const ORDER_VOCAB = (() => {
  const v = new Set();
  const dummy = { schema: "SealedCapsule@1", construction: "symmetric-exchangeable", task: "worlds", events: ["Eaaaaa", "Ebbbbb"], worlds: [{ claims: [["Eaaaaa", "Ebbbbb"]] }] };
  for (const s of [renderPrompt(dummy), ...Object.values(FOLLOWUP).map((f) => f("Eaaaaa<Ebbbbb"))]) for (const w of s.match(WORD) || []) v.add(w.toLowerCase());
  for (let i = 0; i <= 16; i++) v.add(String(i));
  return v;
})();

/** Everything that left, checked: only template words and symbols this task issued. A leak is any other word. */
export function auditOrderMessages(messages, issued) {
  const leaks = [];
  for (const m of messages) {
    if (m.role !== "user") continue; // the model's own replies are not ours to leak
    for (const w of String(m.content).match(WORD) || []) {
      if (symRe.test(w) || SYMBOL_RE.test(w)) { if (!issued.has(w)) leaks.push({ word: w, why: "symbol this task never issued" }); continue; }
      if (!ORDER_VOCAB.has(w.toLowerCase())) leaks.push({ word: w, why: "not template vocabulary" });
    }
  }
  return { ok: leaks.length === 0, leaks };
}

// ───────────────────────── mask family: placeholders must survive a code edit ─────────────────────────

// The de-identifier's format (the-fold, 2026-10): a KIND and six random characters per turn, e.g. PERSON_k3f9ax. The alphabet drops
// i, l, o, 0, 1 (a-h, j-k, m-n, p-z, 2-9). The map home ignores case, so a lowercased id is RECOVERABLE; a changed, dropped or
// added character is not.
export const PLACEHOLDER_KINDS = Object.freeze(["PERSON", "NAME", "ORG", "LOC", "GROUP", "URL", "HANDLE", "ADDRESS", "USER", "PATH", "FILE", "TERM", "EMAIL", "PHONE", "SECRET", "HOST", "ID"]);
export const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const KIND_RE = PLACEHOLDER_KINDS.join("|");
// a placeholder-shaped token: kind, underscore, 4-8 alphanumerics; not glued to a longer word on the left
const PH_ANY = new RegExp(`(?<![A-Za-z0-9])(?:${KIND_RE})_[a-z0-9]{4,8}(?![a-z0-9])`, "gi");

const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };

const MASK_EDITS = [
  { fn: "describe", ask: "add a function named `describe` that returns a list of every string constant defined above, in order" },
  { fn: "paths_only", ask: "add a function named `paths_only` that returns only the constants whose value is a filesystem path" },
  { fn: "summary", ask: "add a function named `summary` that returns a dict mapping each constant's name to the length of its value" },
  { fn: "redact", ask: "add a function named `redact` that returns every string constant with all but its first two characters replaced by asterisks" },
];

/** One randomized masked-code task: a snippet full of placeholders, then follow-up edits, each building on the last. */
export function makeMaskTask(seed, { turns = 3 } = {}) {
  const rng = mulberry32(seed);
  const used = new Set();
  const ph = (kind) => { let id; do { id = Array.from({ length: 6 }, () => ID_ALPHABET[pick(rng, ID_ALPHABET.length)]).join(""); } while (used.has(id)); used.add(id); return `${kind}_${id}`; };
  const P = Object.fromEntries(["PATH", "EMAIL", "SECRET", "HOST", "USER", "PERSON", "NAME"].map((k) => [k, ph(k)]));
  const extraTerms = Array.from({ length: pick(rng, 2) + 1 }, () => ph("TERM"));
  const lines = [
    "import os",
    "",
    `CONFIG_PATH = "${P.PATH}"`,
    `OWNER = "${P.EMAIL}"`,
    `API_KEY = "${P.SECRET}"`,
    `SERVER = "${P.HOST}"`,
    `AUTHOR = "${P.PERSON}"`,
    "",
    `class ${P.NAME}:`,
    `    def __init__(self, user="${P.USER}"):`,
    "        self.user = user",
    "        self.path = CONFIG_PATH",
    "",
    ...extraTerms.flatMap((t) => [`def load_${t}():`, "    return open(CONFIG_PATH).read()", ""]),
  ];
  const code = lines.join("\n").trimEnd() + "\n";
  const placeholders = [...new Set(code.match(PH_ANY) || [])];
  const edits = shuffled(MASK_EDITS, rng).slice(0, Math.max(1, turns));
  const out = edits.map((e, t) => ({
    kind: "edit", fn: e.fn,
    message: t === 0
      ? `Here is a Python file. Some names are masked placeholders such as PERSON_k3f9ax or PATH_6p9zg2; they are opaque, so copy every one exactly as written, never rename, lowercase, expand, shorten or fix them.\n\n\`\`\`python\n${code}\`\`\`\n\nReturn the complete file with one change: ${e.ask}. Output only the code.`
      : `Now, on top of that file: ${e.ask}. Keep every placeholder exactly as written. Return the complete file. Output only the code.`,
    needFns: edits.slice(0, t + 1).map((x) => x.fn),
  }));
  return { family: "mask", seed, code, placeholders, turns: out, tokenCounts: Object.fromEntries(placeholders.map((p) => [p, code.split(p).length - 1])) };
}

/** Pull the code out of a reply (a fenced block if there is one). */
export function extractCode(text) {
  const t = stripThink(text);
  const m = t.match(/```(?:[a-z]*)\n([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

/** Score one masked-code reply. Every issued id is classed: intact (byte for byte), case (lowercased/uppercased: the map home ignores
 *  case, so RECOVERABLE), typo (1-2 characters changed, dropped or added: NOT recoverable), or dropped (gone, e.g. "fixed" into a word).
 *  Anything else placeholder-shaped with a six-character id is an invented id. */
export function scoreMaskTurn(task, idx, text) {
  const turn = task.turns[idx];
  const code = extractCode(text);
  if (!code) return { answered: false, exact: false, accepted: false, lost: null, mangled: null, invented: null, caseOnly: null, editDone: false };
  const issued = task.placeholders, issuedSet = new Set(issued);
  const foundAll = code.match(PH_ANY) || [];
  const foldedCount = (p) => foundAll.filter((f) => f.toLowerCase() === p.toLowerCase()).length;
  const exactCount = (p) => code.split(p).length - 1;
  const intact = [], caseOnly = [], typo = [], dropped = [];
  for (const p of issued) {
    if (exactCount(p) >= task.tokenCounts[p]) intact.push(p);
    else if (foldedCount(p) >= task.tokenCounts[p]) caseOnly.push(p);
    else {
      const near = foundAll.find((f) => !issuedSet.has(f) && f.split("_")[0].toUpperCase() === p.split("_")[0] && lev(f.toLowerCase(), p.toLowerCase()) <= 2);
      (near ? typo : dropped).push(near ? { was: p, now: near } : p);
    }
  }
  const nearAny = (f) => issued.some((p) => f.split("_")[0].toUpperCase() === p.split("_")[0] && lev(f.toLowerCase(), p.toLowerCase()) <= 2);
  const invented = [...new Set(foundAll.filter((f) => !issuedSet.has(f) && !issued.some((p) => p.toLowerCase() === f.toLowerCase()) && !nearAny(f) && f.split("_")[1].length === 6))];
  const lost = dropped, mangled = typo.map((t) => t.now);
  const editDone = turn.needFns.every((fn) => new RegExp(`def\\s+${fn}\\s*\\(`).test(code));
  const placeholdersIntact = !caseOnly.length && !typo.length && !dropped.length && !invented.length;
  const placeholdersRecoverable = !typo.length && !dropped.length && !invented.length;
  const exact = placeholdersRecoverable && editDone;       // a lowercased id still maps home, so it does not fail the turn
  return { answered: true, exact, accepted: exact, lost, mangled, invented, caseOnly, typo, editDone, placeholdersIntact, placeholdersRecoverable, failureKinds: { case: caseOnly.length, typo: typo.length, dropped: dropped.length, invented: invented.length } };
}

/** What may be in a masked request: placeholders and code, never a real path, email, key or home directory. */
export function auditMaskMessages(messages) {
  const leaks = [];
  const bad = [["real email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/], ["home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+/], ["key-like token", /\b(?:sk-|ghp_|AKIA|AIza)[A-Za-z0-9_-]{8,}/]];
  for (const m of messages) if (m.role === "user") for (const [why, re] of bad) { const x = String(m.content).match(re); if (x) leaks.push({ word: x[0].slice(0, 20), why }); }
  return { ok: leaks.length === 0, leaks };
}

// ───────────────────────── reading a reply, classifying a failure ─────────────────────────

/** Reasoning models wrap their thinking in <think>; its braces and quotes must not be mistaken for the answer. */
export const stripThink = (t) => String(t ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();

/** Why a call did not produce an answer: one of the kinds a person can act on. */
export function classifyFailure({ status = null, body = "", error = null, headers = null } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  const retryHdr = headers && (typeof headers.get === "function" ? headers.get("retry-after") : headers["retry-after"]);
  const m = /retry after (\d+) seconds?/i.exec(text);
  const retryAfterMs = retryHdr && Number(retryHdr) ? Number(retryHdr) * 1000 : m ? Number(m[1]) * 1000 : null;
  if (error) {
    const e = String(error?.name || error) + " " + String(error?.message || "");
    if (/abort|timeout|timed out/i.test(e)) return { kind: "timeout", detail: "no answer within the time limit", retryAfterMs: null };
    return { kind: "network", detail: e.slice(0, 120), retryAfterMs: null };
  }
  if (status === 429 || status === 402) {
    if (/quota|insufficient|daily|exceeded.*token|credit/i.test(text)) return { kind: "quota", detail: (text.match(/"message":"([^"]+)"/)?.[1] ?? "quota exhausted").slice(0, 120), retryAfterMs };
    return { kind: "rate_limited", detail: "rate limit", retryAfterMs };
  }
  if (status === 401 || status === 403) return { kind: "auth", detail: `${status}: a credential is needed`, retryAfterMs: null };
  if (status === 400 || status === 404 || status === 422) return { kind: "bad_request", detail: `${status} ${text.slice(0, 100)}`, retryAfterMs: null };
  if (status >= 500) return { kind: "server", detail: `${status} ${(text.match(/"error":"([^"]+)"/)?.[1] ?? text).slice(0, 100)}`, retryAfterMs: null };
  if (status === 200) return { kind: "empty", detail: "200 with no answer text", retryAfterMs: null };
  return { kind: "unknown", detail: `${status} ${text.slice(0, 80)}`, retryAfterMs: null };
}

/** Parse an SSE chunk stream (OpenAI shape) into { content, reasoning }. `lines` are raw `data: …` payload strings. */
export function foldDeltas(payloads) {
  let content = "", reasoning = "", usage = null;
  for (const p of payloads) {
    if (p === "[DONE]") continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    const d = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
    if (typeof d.content === "string") content += d.content;
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string") reasoning += r;
    if (j.usage) usage = j.usage;
  }
  return { content, reasoning, usage };
}

// ───────────────────────── summary and verdict ─────────────────────────

export const pctile = (xs, p) => { const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The bar, fixed BEFORE the first measurement (Constitution II.5). Change it only in a commit that says why. */
export const BAR = Object.freeze({
  worthIt: { availability: 0.8, accuracyOfAnswered: 0.7, p50TotalMs: 20_000, p95TotalMs: 60_000 },
  marginal: { availability: 0.5, accuracyOfAnswered: 0.4 },
});

/** Turn a model's raw trials into the three answers. A turn is { status:"ok"|kind|"skipped", ms, ttftMs, answered, exact, … }. */
export function summarizeModel({ probe, trials }) {
  const turns = trials.flatMap((t) => t.turns);
  const attempted = turns.filter((t) => t.status !== "skipped");
  const ok = attempted.filter((t) => t.status === "ok");
  const answered = ok.filter((t) => t.answered);
  const exact = answered.filter((t) => t.exact);
  const byKind = {};
  for (const t of attempted) if (t.status !== "ok") byKind[t.status] = (byKind[t.status] || 0) + 1;
  for (const r of probe?.attempts ?? []) if (r.status !== "ok") byKind[r.status] = (byKind[r.status] || 0) + 1;
  const bySeq = (i) => { const xs = trials.map((t) => t.turns[i]).filter(Boolean); const a = xs.filter((t) => t.status !== "skipped"); return { attempted: a.length, exact: a.filter((t) => t.exact).length }; };
  const seqLen = Math.max(0, ...trials.map((t) => t.turns.length));
  const chains = trials.filter((t) => t.turns.length);
  const chainsAllExact = chains.filter((t) => t.turns.every((x) => x.exact)).length;
  const totalMs = ok.map((t) => t.ms), ttft = ok.map((t) => t.ttftMs);
  const spent = attempted.reduce((s, t) => s + (t.ms || 0), 0);
  const gateDisagree = answered.filter((t) => t.gateAgrees === false).length;
  const s = {
    probeOk: !!probe?.ok,
    calls: attempted.length, ok: ok.length, answered: answered.length, exact: exact.length,
    availability: attempted.length ? ok.length / attempted.length : 0,
    accuracyOfAnswered: answered.length ? exact.length / answered.length : null,
    accuracyEndToEnd: attempted.length ? wilson(exact.length, attempted.length) : null,
    answeredCI: answered.length ? wilson(exact.length, answered.length) : null,
    firstTurnExact: bySeq(0), followUpExact: seqLen > 1 ? Array.from({ length: seqLen - 1 }, (_, i) => bySeq(i + 1)) : [],
    chains: chains.length, chainsAllExact,
    p50TotalMs: pctile(totalMs, 0.5), p95TotalMs: pctile(totalMs, 0.95), p50TtftMs: pctile(ttft, 0.5), meanChars: mean(ok.map((t) => t.chars ?? 0)),
    msPerAccepted: exact.length ? Math.round(spent / exact.length) : null,
    failures: byKind, gateDisagreements: gateDisagree,
  };
  s.verdict = verdictOf(s);
  return s;
}

/** DOWN / NOT_WORTH_IT / MARGINAL / WORTH_IT with the reasons that decided it. */
export function verdictOf(s) {
  const reasons = [];
  if (!s.probeOk && !s.ok) return { grade: "DOWN", reasons: ["no call to it succeeded"] };
  const W = BAR.worthIt, M = BAR.marginal;
  const acc = s.accuracyOfAnswered ?? 0;
  const fastEnough = (s.p50TotalMs ?? Infinity) <= W.p50TotalMs && (s.p95TotalMs ?? Infinity) <= W.p95TotalMs;
  if (s.availability < W.availability) reasons.push(`answers ${(100 * s.availability).toFixed(0)}% of calls (bar ${100 * W.availability}%)`);
  if (acc < W.accuracyOfAnswered) reasons.push(`${(100 * acc).toFixed(0)}% of its answers pass the exact check (bar ${100 * W.accuracyOfAnswered}%)`);
  if (!fastEnough) reasons.push(`p50 ${s.p50TotalMs ?? "?"} ms / p95 ${s.p95TotalMs ?? "?"} ms (bar ${W.p50TotalMs}/${W.p95TotalMs})`);
  if (s.gateDisagreements) reasons.push(`the local gate disagreed with an independent recomputation ${s.gateDisagreements}×: DO NOT TRUST THIS RUN`);
  if (!reasons.length) return { grade: "WORTH_IT", reasons: ["available, accurate and quick enough"] };
  if (s.availability >= M.availability && acc >= M.accuracyOfAnswered) return { grade: "MARGINAL", reasons };
  return { grade: "NOT_WORTH_IT", reasons };
}
