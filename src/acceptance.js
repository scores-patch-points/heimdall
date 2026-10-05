// acceptance.js — the Fold's local gate: a remote result is a PROPOSAL until
// these checks pass (2026-10, docs/ESCALATION.md).
//
// A job declares `acceptance`: a list of typed, machine-checkable checks. The
// proposal that comes back from ANY route (local model, device, remote) is
// run through them HERE, on the machine that holds the evidence. A model's
// statement that it is sure is not an input to any check.
//
// Verdicts are three-valued, never two (FOLD-CONSTITUTION II.10, IV.3):
//   pass  the check ran and the proposal satisfies it
//   fail  the check ran and the proposal does not (carries a failure `kind`
//         the router may escalate on: check_failed | contradiction | unresolved)
//   gap   the check could not run (khora down, nothing to check, no source
//         bytes). A gap is NEVER a pass: a job with a gap is not accepted.
//
// Built-in check types (job.js CHECK_TYPES):
//   schema              a JSON-schema subset (no dependency)
//   equation            mathjs, settled by `POST khora /v1/reason` — a typed gap
//                       when the khora is not up
//   constraint          declarative predicates over the proposal (eq/in/lt/…)
//   contradiction-free  no functional relation takes two values, no order cycle,
//                       and nothing contradicts the locally witnessed claims
//   citation-resolves   each quote resolves to the source's bytes (the
//                       "quote-resolves-to-source-bytes" check)
//   custom              a function by id (registerCheck / ctx.fns)
//
// Every built-in ships its own PROBES: a known-good and a known-bad input.
// `selfTest()` runs them, so each gate is shown to REJECT something (II.10)
// and an unfalsified gate reports `unmeasured`, not `pass`.

export const VERDICT = Object.freeze({ pass: "pass", fail: "fail", gap: "gap" });

const customFns = new Map();
/** Register a custom check by id: fn(proposal, ctx, check) → boolean | { ok, kind?, detail? } (may be async). */
export function registerCheck(id, fn) {
  if (typeof id !== "string" || !id || typeof fn !== "function") throw new Error("registerCheck needs an id and a function");
  customFns.set(id, fn);
}
export const hasCheck = (id) => customFns.has(id);

const res = (check, verdict, detail, extra = {}) => ({ id: check.id ?? check.type, type: check.type, verdict, detail, ...extra });
const pass = (check, detail = "ok") => res(check, VERDICT.pass, detail);
const fail = (check, detail, kind = "check_failed", extra = {}) => res(check, VERDICT.fail, detail, { kind, ...extra });
const gap = (check, detail, gapKind = "not-computed", extra = {}) => res(check, VERDICT.gap, detail, { gap: { kind: gapKind }, ...extra });

// ───────────────────────── JSON-schema subset ─────────────────────────

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (t, v) => (t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

/** Validate `value` against a JSON-schema subset. Returns the list of violations (empty = valid). */
export function validateSchema(schema, value, at = "$") {
  const errs = [];
  if (schema === true || schema == null) return errs;
  if (schema === false) return [`${at}: nothing is allowed here`];
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errs.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => typeMatches(t, value))) { errs.push(`${at}: expected ${ts.join("|")}, got ${typeOf(value)}`); return errs; }
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validateSchema(s, value, at).length === 0)) errs.push(`${at}: matches none of anyOf`);
  if (schema.oneOf && schema.oneOf.filter((s) => validateSchema(s, value, at).length === 0).length !== 1) errs.push(`${at}: must match exactly one of oneOf`);
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) errs.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errs.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) errs.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errs.push(`${at}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errs.push(`${at}: not above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) errs.push(`${at}: not below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errs.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errs.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errs.push(`${at}: items are not unique`);
    if (schema.items) value.forEach((x, i) => errs.push(...validateSchema(schema.items, x, `${at}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value) || value[k] === undefined) errs.push(`${at}.${k}: required`);
    const props = schema.properties || {};
    for (const [k, s] of Object.entries(props)) if (k in value) errs.push(...validateSchema(s, value[k], `${at}.${k}`));
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) if (!(k in props)) errs.push(`${at}.${k}: not allowed`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const k of Object.keys(value)) if (!(k in props)) errs.push(...validateSchema(schema.additionalProperties, value[k], `${at}.${k}`));
    }
  }
  return errs;
}

// ───────────────────────── paths and constraints ─────────────────────────

/** Read a dotted path with [i] indexes: "a.b[2].c". Returns undefined when absent. */
export function getPath(obj, path) {
  const parts = String(path).replace(/^\$\.?/, "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

const OPS = {
  eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  ne: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  in: (a, b) => Array.isArray(b) && b.some((x) => JSON.stringify(x) === JSON.stringify(a)),
  nin: (a, b) => Array.isArray(b) && !b.some((x) => JSON.stringify(x) === JSON.stringify(a)),
  lt: (a, b) => typeof a === "number" && a < b,
  lte: (a, b) => typeof a === "number" && a <= b,
  gt: (a, b) => typeof a === "number" && a > b,
  gte: (a, b) => typeof a === "number" && a >= b,
  matches: (a, b) => typeof a === "string" && new RegExp(b).test(a),
  exists: (a, b) => (a !== undefined && a !== null) === (b !== false),
  "subset-of": (a, b) => Array.isArray(a) && Array.isArray(b) && a.every((x) => b.some((y) => JSON.stringify(x) === JSON.stringify(y))),
  "len-between": (a, b) => (typeof a === "string" || Array.isArray(a)) && Array.isArray(b) && a.length >= b[0] && a.length <= b[1],
};
export const CONSTRAINT_OPS = Object.freeze(Object.keys(OPS));

function runConstraint(check, proposal) {
  const bad = [];
  for (const c of check.constraints || []) {
    const op = OPS[c.op];
    if (!op) return fail(check, `unknown constraint op ${JSON.stringify(c.op)}`, "check_failed");
    const v = getPath(proposal, c.path);
    if (v === undefined && c.op !== "exists") { bad.push(`${c.path}: absent`); continue; }
    if (!op(v, c.value)) bad.push(`${c.path} ${c.op} ${JSON.stringify(c.value)} is false (got ${JSON.stringify(v)?.slice(0, 60)})`);
  }
  if (!(check.constraints || []).length) return gap(check, "no constraints declared — passed on 0 constraints is not a pass", "computed-and-empty");
  return bad.length ? fail(check, bad.join("; ")) : pass(check, `${check.constraints.length} constraint(s) hold`);
}

// ───────────────────────── contradiction-free ─────────────────────────

function hasCycle(edges) {
  const adj = new Map();
  for (const [a, b] of edges) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (n) => {
    state.set(n, 1);
    for (const m of adj.get(n) || []) {
      if (state.get(m) === 1) return true;
      if (!state.has(m) && visit(m)) return true;
    }
    state.set(n, 2);
    return false;
  };
  for (const n of adj.keys()) if (!state.has(n) && visit(n)) return true;
  return false;
}

/** Claims `{subject, relation, value}`, orders `{before, after}` (or `[a, b]`). Contradictions: a functional
 *  relation with two values, an order cycle, or anything against `ctx.witnessed`. */
function runContradictionFree(check, proposal, ctx) {
  const claims = proposal?.claims ?? [];
  const orders = (proposal?.order ?? []).map((o) => (Array.isArray(o) ? o : [o.before, o.after]));
  if (!claims.length && !orders.length) return gap(check, "the proposal states no claims and no order — nothing to check", "computed-and-empty");
  const functional = new Set(check.functional ?? []);
  const seen = new Map();
  const problems = [];
  const witnessed = ctx?.witnessed ?? { claims: [], order: [] };
  const consider = (cl, from) => {
    if (!(functional.has(cl.relation) || cl.functional)) return;
    const k = `${cl.subject}\u0000${cl.relation}`;
    const prev = seen.get(k);
    if (prev && JSON.stringify(prev.value) !== JSON.stringify(cl.value)) problems.push(`${cl.subject} ${cl.relation}: ${JSON.stringify(prev.value)} (${prev.from}) vs ${JSON.stringify(cl.value)} (${from})`);
    else if (!prev) seen.set(k, { value: cl.value, from });
  };
  for (const w of witnessed.claims ?? []) consider(w, "witnessed");
  for (const c of claims) consider(c, "proposal");
  const edges = [...(witnessed.order ?? []).map((o) => (Array.isArray(o) ? o : [o.before, o.after])), ...orders];
  if (hasCycle(edges)) problems.push("the order relation contains a cycle");
  return problems.length ? fail(check, problems.join("; "), "contradiction") : pass(check, `${claims.length} claim(s), ${orders.length} order edge(s): no contradiction`);
}

// ───────────────────────── citation-resolves ─────────────────────────

/** Each citation `{quote, source, bytes?:[start,end]}` must be found in ctx.sources[source]: at the stated UTF-8 byte
 *  range when given, verbatim anywhere otherwise. A model's paraphrase of a source is not a citation. */
function runCitation(check, proposal, ctx) {
  const cites = proposal?.citations ?? [];
  if (!cites.length) return gap(check, "the proposal cites nothing — nothing to resolve", "computed-and-empty");
  const sources = ctx?.sources;
  if (!sources || typeof sources !== "object") return gap(check, "no local source bytes were supplied to resolve against", "not-present");
  const bad = [];
  cites.forEach((c, i) => {
    const text = sources[c.source];
    if (typeof text !== "string") { bad.push(`citation ${i}: source ${JSON.stringify(c.source)} is not held locally`); return; }
    if (typeof c.quote !== "string" || !c.quote) { bad.push(`citation ${i}: empty quote`); return; }
    if (Array.isArray(c.bytes)) {
      const buf = Buffer.from(text, "utf8");
      const [s, e] = c.bytes;
      if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= buf.length && s < e)) { bad.push(`citation ${i}: byte range ${JSON.stringify(c.bytes)} is outside the source`); return; }
      if (buf.subarray(s, e).toString("utf8") !== c.quote) bad.push(`citation ${i}: the bytes at ${s}..${e} are not the quoted text`);
    } else if (!text.includes(c.quote)) bad.push(`citation ${i}: the quote does not occur in ${c.source}`);
  });
  return bad.length ? fail(check, bad.join("; ")) : pass(check, `${cites.length} quote(s) resolve to source bytes`);
}

// ───────────────────────── equation (khora /v1/reason) ─────────────────────────

const DEFAULT_KHORA = process.env.KHORA_URL || "http://127.0.0.1:11436";

/** "{{a.b}} + 1 == {{c}}" → filled from the proposal; returns null when a placeholder has no number/string value. */
export function fillTemplate(tpl, proposal) {
  let missing = false;
  const out = String(tpl).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, path) => {
    const v = getPath(proposal, path);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && v.trim() !== "") return v;
    missing = true;
    return "";
  });
  return missing ? null : out;
}

async function runEquation(check, proposal, ctx) {
  const statements = (check.statements || []).map((s) => fillTemplate(s, proposal));
  if (statements.some((s) => s === null)) return fail(check, "an equation refers to a value the proposal does not carry", "unresolved");
  const fetchImpl = ctx?.fetchImpl ?? fetch;
  const url = (ctx?.khoraUrl || DEFAULT_KHORA).replace(/\/+$/, "") + "/v1/reason";
  let j;
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-er7-reason-flags": "--json --compact", "x-er7-user": "heimdall", "x-er7-caller": "heimdall-acceptance" },
      body: JSON.stringify({ equations: statements.map((statement, i) => ({ ref: `eq${i + 1}`, statement })) }),
      signal: AbortSignal.timeout(ctx?.timeoutMs ?? 15000),
    });
    j = await r.json();
    if (!r.ok) return gap(check, `khora /v1/reason answered ${r.status}`, "not-computed", { statements });
  } catch (e) {
    // IV.3: a missing oracle is a typed gap, never a silently-passed equation.
    return gap(check, `khora /v1/reason unreachable (${String(e?.message || e).slice(0, 80)}) — the equation was not computed`, "not-computed", { statements });
  }
  const findings = Array.isArray(j?.findings) ? j.findings : [];
  const errors = findings.filter((f) => f.severity === "error");
  if (j?.ok === true && !errors.length) return pass(check, `khora: ${statements.length} equation(s) hold`);
  if (errors.length) return fail(check, errors.map((f) => f.detail).join("; ").slice(0, 400), "check_failed", { statements });
  return gap(check, "khora returned a verdict this gate does not understand", "not-computed", { statements });
}

// ───────────────────────── runner ─────────────────────────

/** Run one check against a proposal. Never throws: a throwing check is a `gap`. */
export async function runCheck(check, proposal, ctx = {}) {
  try {
    switch (check.type) {
      case "schema": {
        const errs = validateSchema(check.schema, proposal);
        return errs.length ? fail(check, errs.slice(0, 6).join("; ")) : pass(check, "schema holds");
      }
      case "equation": return await runEquation(check, proposal, ctx);
      case "constraint": return runConstraint(check, proposal);
      case "contradiction-free": return runContradictionFree(check, proposal, ctx);
      case "citation-resolves": return runCitation(check, proposal, ctx);
      case "custom": {
        const fn = ctx.fns?.[check.fn] ?? customFns.get(check.fn);
        if (!fn) return gap(check, `no custom check registered as ${JSON.stringify(check.fn)}`, "not-present");
        const out = await fn(proposal, ctx, check);
        if (out === true) return pass(check, "custom check holds");
        if (out === false) return fail(check, `custom check ${check.fn} rejected the proposal`);
        if (out && typeof out === "object") return out.ok ? pass(check, out.detail || "custom check holds") : fail(check, out.detail || `custom check ${check.fn} rejected the proposal`, out.kind || "check_failed");
        return gap(check, `custom check ${check.fn} returned nothing decidable`, "not-computed");
      }
      default: return gap(check, `unknown check type ${JSON.stringify(check.type)}`, "not-present");
    }
  } catch (e) {
    return gap(check, `check threw: ${String(e?.message || e).slice(0, 120)}`, "not-computed");
  }
}

/** An unusable output (nothing, or not the shape the job asked for) is `unresolved` before any check runs. */
export function isUnresolved(proposal) {
  if (proposal == null) return true;
  if (typeof proposal === "string") return proposal.trim() === "";
  if (typeof proposal === "object") return Object.keys(proposal).length === 0;
  return false;
}

/**
 * Run every acceptance check of a job (or an explicit list) against a proposal.
 * `accepted` is true only when there is at least one check, none failed, and none
 * is a gap. The model's own claims about confidence play no part: callers pass
 * the proposal's CONTENT, and `selfReported` keys are not read here.
 * Returns { accepted, state, verdicts, failures:[kind], gaps }.
 *   state: "accepted" | "rejected" (a check failed) | "unverified" (a gap, or no checks) | "unresolved"
 */
export async function runAcceptance(jobOrChecks, proposal, ctx = {}) {
  const checks = Array.isArray(jobOrChecks) ? jobOrChecks : jobOrChecks?.acceptance ?? [];
  if (isUnresolved(proposal)) return { accepted: false, state: "unresolved", verdicts: [], failures: ["unresolved"], gaps: 0 };
  if (!checks.length) return { accepted: false, state: "unverified", verdicts: [], failures: [], gaps: 1, note: "a job with no acceptance checks cannot be accepted — nothing was able to reject it" };
  const verdicts = [];
  for (let i = 0; i < checks.length; i++) verdicts.push(await runCheck({ id: `a${i + 1}`, ...checks[i] }, proposal, ctx));
  const failed = verdicts.filter((v) => v.verdict === VERDICT.fail);
  const gaps = verdicts.filter((v) => v.verdict === VERDICT.gap).length;
  const failures = [...new Set(failed.map((v) => v.kind || "check_failed"))];
  const state = failed.length ? "rejected" : gaps ? "unverified" : "accepted";
  return { accepted: state === "accepted", state, verdicts, failures, gaps };
}

/** The caller-facing shape of a remote result: a PROPOSAL, never a conclusion. */
export function asProposal({ proposal, route, checks = [] }) {
  return { proposal, route, checksToRun: checks.map((c, i) => ({ id: c.id ?? `a${i + 1}`, type: c.type })) };
}

// ───────────────────────── falsifiers (II.10) ─────────────────────────

/** Known-good and known-bad inputs per built-in check, so each gate is shown to reject something. */
export const PROBES = Object.freeze({
  schema: {
    check: { type: "schema", schema: { type: "object", required: ["year"], properties: { year: { type: "integer", minimum: 1000, maximum: 2100 } }, additionalProperties: false } },
    accept: [{ year: 1779 }],
    reject: [{ year: "1779" }, { yr: 1779 }, { year: 1779, extra: 1 }, { year: 3000 }],
  },
  constraint: {
    check: { type: "constraint", constraints: [{ path: "answer.year", op: "in", value: [1779, 1784] }, { path: "answer.n", op: "lt", value: 10 }] },
    accept: [{ answer: { year: 1779, n: 3 } }],
    reject: [{ answer: { year: 1800, n: 3 } }, { answer: { year: 1779, n: 30 } }, { answer: {} }],
  },
  "contradiction-free": {
    check: { type: "contradiction-free", functional: ["founded-in"] },
    accept: [{ claims: [{ subject: "X", relation: "founded-in", value: 1779 }], order: [["a", "b"], ["b", "c"]] }],
    reject: [
      { claims: [{ subject: "X", relation: "founded-in", value: 1779 }, { subject: "X", relation: "founded-in", value: 1784 }] },
      { order: [["a", "b"], ["b", "c"], ["c", "a"]] },
    ],
  },
  "citation-resolves": {
    check: { type: "citation-resolves" },
    ctx: { sources: { S1: "The town was founded in 1779 by settlers." } },
    accept: [{ citations: [{ quote: "founded in 1779", source: "S1" }, { quote: "founded in 1779", source: "S1", bytes: [13, 28] }] }],
    reject: [{ citations: [{ quote: "founded in 1784", source: "S1" }] }, { citations: [{ quote: "founded in 1779", source: "S9" }] }, { citations: [{ quote: "founded in 1779", source: "S1", bytes: [0, 15] }] }],
  },
  equation: {
    check: { type: "equation", statements: ["{{a}} + {{b}} == {{sum}}"] },
    accept: [{ a: 2, b: 3, sum: 5 }],
    reject: [{ a: 2, b: 3, sum: 6 }],
    needsKhora: true,
  },
});

/** Run every probe. Returns { type: { accepts, rejects, falsified, unmeasured } } — `falsified` only when every
 *  known-bad input was rejected AND every known-good one accepted; `unmeasured` when the oracle was not up. */
export async function selfTest(ctx = {}) {
  const out = {};
  for (const [type, p] of Object.entries(PROBES)) {
    const c = { ...(p.ctx || {}), ...ctx };
    let accepts = 0, rejects = 0, unmeasured = false;
    for (const a of p.accept) { const v = await runCheck(p.check, a, c); if (v.verdict === VERDICT.pass) accepts++; else if (v.verdict === VERDICT.gap) unmeasured = true; }
    for (const r of p.reject) { const v = await runCheck(p.check, r, c); if (v.verdict === VERDICT.fail) rejects++; else if (v.verdict === VERDICT.gap) unmeasured = true; }
    out[type] = { accepts, of_accept: p.accept.length, rejects, of_reject: p.reject.length, unmeasured, falsified: !unmeasured && accepts === p.accept.length && rejects === p.reject.length };
  }
  return out;
}
