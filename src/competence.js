// competence.js — dispatch by MEASURED competence, not by name.
//
// A coding agent that keeps one big context and one big model pays for the whole
// history on every step. The Fold's alternative is to make each step small — a
// scoped request, not the accumulated transcript — and then send each step to the
// CHEAPEST model that has actually been shown to do that kind of step at that
// size. This module is that decision, and it is deliberately dumb about names:
//
//   · every outcome is an observation: (model, task class, context size) → passed or not
//   · a (model, class, size-bucket) cell is a Beta posterior; its LOWER confidence
//     bound is what dispatch trusts — a model that passed twice is not "competent",
//     it is untested
//   · neighbouring size buckets lend each other evidence at a discount (a model that
//     is good at 2K is probably good at 3K), but never across a model boundary
//   · the plan is a LADDER: the cheapest model whose lower bound clears the bar,
//     then every costlier one above it, so a failed step escalates instead of
//     retrying the same thing
//   · an unmeasured model is not assumed good OR bad: it is explored — tried first on
//     cheap steps with a bounded rate, so the table fills in where it matters
//   · privacy is a hard filter, applied before cost: a job that must stay on this
//     machine never sees a remote model in its ladder
//
// Pure: no network, no clock; randomness is injected so a plan is reproducible.

export const BUCKETS = Object.freeze([1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, Infinity]);
export const bucketOf = (tokens) => { const t = Math.max(0, +tokens || 0); const i = BUCKETS.findIndex((b) => t <= b); return i < 0 ? BUCKETS.length - 1 : i; };
export const bucketLabel = (i) => (BUCKETS[i] === Infinity ? ">128k" : BUCKETS[i] >= 1024 ? BUCKETS[i] / 1024 + "k" : String(BUCKETS[i]));

/** Wilson score lower bound for `s` successes in `n` trials (z = 1.28 ≈ 80% one-sided). Honest about small n. */
export function wilsonLower(s, n, z = 1.28) {
  if (n <= 0) return 0;
  const p = s / n, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n));
}

/** A rough token estimate for text going to a model: code is denser than prose (measured through a real tokenizer: ≈ 3.0 chars/token on code, 3.4 on prose). */
export function estimateTokens(text, { code = true } = {}) { return Math.ceil(String(text ?? "").length / (code ? 3.0 : 3.4)); }
export function messagesTokens(messages, opts) { return (messages || []).reduce((n, m) => n + estimateTokens(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""), opts) + 4, 0); }

const key = (model, cls, b) => `${model}|${cls}|${b}`;

export function createCompetence({ decay = 0.5, now = () => Date.now() } = {}) {
  const cells = new Map(); // key -> { s, f, ms, tokens, usd, last }
  const api = {
    /** Record one outcome. `ok` must come from something that can fail — a test, a ruling — never the model's own word. */
    observe({ model, taskClass = "code.edit", ctxTokens = 0, ok, ms = null, usd = null, outTokens = null }) {
      if (!model || typeof ok !== "boolean") return null;
      const k = key(model, taskClass, bucketOf(ctxTokens));
      const c = cells.get(k) || { s: 0, f: 0, ms: 0, msN: 0, usd: 0, usdN: 0, tokensIn: 0, tokensOut: 0, last: 0 };
      if (ok) c.s++; else c.f++;
      if (ms != null) { c.ms += ms; c.msN++; }
      if (usd != null) { c.usd += usd; c.usdN++; }
      c.tokensIn += ctxTokens; c.tokensOut += outTokens ?? 0; c.last = now();
      cells.set(k, c);
      return c;
    },
    /**
     * What is known about `model` at this class and size: its own bucket plus neighbours, discounted by distance.
     * The transfer is ASYMMETRIC on purpose: a success at a LARGER context is strong evidence for a smaller one, and a
     * failure at a SMALLER context is strong evidence against a larger one; the other two directions count for little.
     */
    estimate(model, taskClass, ctxTokens) {
      const b = bucketOf(ctxTokens);
      let s = 0, f = 0, own = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        const c = cells.get(key(model, taskClass, i)); if (!c) continue;
        const w = i === b ? 1 : Math.pow(decay, Math.abs(i - b));
        if (i === b) { s += c.s; f += c.f; own = c.s + c.f; }
        else if (i > b) { s += c.s * w; f += c.f * w * 0.25; }     // evidence from bigger contexts
        else { f += c.f * w; s += c.s * w * 0.25; }                 // evidence from smaller contexts
      }
      const n = s + f;
      return { mean: n ? s / n : null, lcb: wilsonLower(s, n), n: +n.toFixed(2), own, bucket: bucketLabel(b) };
    },
    cells() { return [...cells.entries()].map(([k, c]) => { const [model, taskClass, b] = k.split("|"); return { model, taskClass, bucket: bucketLabel(+b), ...c, pass: c.s / (c.s + c.f) }; }); },
    toJSON() { return { v: 1, cells: [...cells.entries()] }; },
    load(j) { if (j?.v === 1 && Array.isArray(j.cells)) for (const [k, c] of j.cells) cells.set(k, c); return api; },
    /** Seed from benchmark rows: [{model, taskClass?, ctxTokens, ok, ms?}] */
    seed(rows) { for (const r of rows || []) api.observe(r); return api; },
  };
  return api;
}

/**
 * Plan the dispatch of one job.
 *
 * @param job         { taskClass, ctxTokens, privacy: "local-only" | "sealed-external" | "any", reserveOut?: tokens the answer needs }
 * @param candidates  [{ model, tier: "local"|"fleet"|"remote"|"hosted"|"frontier", usdInPerM, usdOutPerM, ctxWindow, sealedOnly?, healthy? }]
 * @param comp        a competence table
 * @param opts        { minPass: the lower bound a model must clear (default 0.7), explore: 0..1 share of cheap unmeasured tries,
 *                      rng, outTokens }
 * @returns { ladder:[{model, tier, why, lcb, mean, n, usd}], chosen, excluded:[{model, why}], bucket }
 */
export function plan(job, candidates, comp, { minPass = 0.7, explore = 0.15, rng = Math.random, outTokens = 600 } = {}) {
  const ctx = Math.max(0, job.ctxTokens || 0), cls = job.taskClass || "code.edit";
  const excluded = [], ok = [];
  for (const c of candidates || []) {
    const remote = c.tier === "remote" || c.tier === "hosted" || c.tier === "frontier";
    if (c.healthy === false) { excluded.push({ model: c.model, why: "unhealthy (throttled or down)" }); continue; }
    if (job.privacy === "local-only" && remote) { excluded.push({ model: c.model, why: "the job must stay on this machine" }); continue; }
    if (c.ctxWindow && ctx + (job.reserveOut ?? outTokens) > c.ctxWindow) { excluded.push({ model: c.model, why: `context ${ctx} + answer does not fit its ${c.ctxWindow}-token window` }); continue; }
    ok.push(c);
  }
  // ties on price go to the model that stays closest to home: local, then fleet, then remote, then frontier
  const TIER = { local: 0, fleet: 1, remote: 2, hosted: 3, frontier: 4 };
  const tierOf = (r) => TIER[r.c.tier] ?? 2;
  const usdOf = (c) => ((ctx * (c.usdInPerM ?? 0)) + (outTokens * (c.usdOutPerM ?? 0))) / 1e6;
  const rows = ok.map((c) => { const e = comp.estimate(c.model, cls, ctx); return { c, e, usd: usdOf(c) }; });
  // cost-to-success: what one PASS costs at this model's measured rate. Unmeasured = unknown, handled below.
  const proven = rows.filter((r) => r.e.lcb >= minPass).sort((a, b) => (a.usd / Math.max(a.e.mean, 0.05)) - (b.usd / Math.max(b.e.mean, 0.05)) || a.usd - b.usd || tierOf(a) - tierOf(b));
  const unproven = rows.filter((r) => r.e.lcb < minPass);
  const untested = unproven.filter((r) => r.e.n < 1).sort((a, b) => a.usd - b.usd || tierOf(a) - tierOf(b));
  const tested = unproven.filter((r) => r.e.n >= 1).sort((a, b) => b.e.lcb - a.e.lcb || a.usd - b.usd || tierOf(a) - tierOf(b));

  const ladder = [];
  const row = (r, why) => ({ model: r.c.model, tier: r.c.tier, why, lcb: +r.e.lcb.toFixed(3), mean: r.e.mean == null ? null : +r.e.mean.toFixed(3), n: r.e.n, usd: +r.usd.toFixed(6) });
  // exploration: the cheapest UNMEASURED model gets a bounded share of cheap jobs, so the table fills in where it is cheap to be wrong
  const cheapestProven = proven[0]?.usd ?? Infinity;
  const tryFirst = untested.find((r) => r.usd < cheapestProven) && rng() < explore ? untested.find((r) => r.usd < cheapestProven) : null;
  if (tryFirst) ladder.push(row(tryFirst, "unmeasured and cheaper than every proven model — explored on a share of cheap steps"));
  for (const r of proven) ladder.push(row(r, `measured: lower bound ${r.e.lcb.toFixed(2)} ≥ ${minPass} at ${r.e.bucket}`));
  // above the proven rungs: first the measured-but-not-yet-proven that still look promising, then the unmeasured
  // (cheapest first), and LAST the ones measured to fail — a model that has been shown to pass under 40% of the time
  // (with enough trials to say so) ranks below one nobody has tried yet.
  const weak = (r) => r.e.n >= 5 && r.e.mean < 0.4;
  for (const r of tested) if (!weak(r) && !ladder.some((x) => x.model === r.c.model)) ladder.push(row(r, `measured but not yet proven (lower bound ${r.e.lcb.toFixed(2)}, n=${r.e.n}) — an escalation, not a default`));
  for (const r of untested) if (!ladder.some((x) => x.model === r.c.model)) ladder.push(row(r, "unmeasured — a last resort until it has data"));
  for (const r of tested) if (weak(r) && !ladder.some((x) => x.model === r.c.model)) ladder.push(row(r, `measured to fail (passes ${Math.round(r.e.mean * 100)}% over ${r.e.n} trials) — used only if nothing else is left`));
  // the ladder is walked in order, so keep proven models ahead of unproven ones, each group cheapest-first
  return { ladder, chosen: ladder[0] || null, excluded, bucket: bucketLabel(bucketOf(ctx)), taskClass: cls, ctxTokens: ctx, minPass };
}

/** A realistic default price table (USD per million tokens). Local and keyless tiers are free; paid tiers are listed so cost is never hidden. */
export const DEFAULT_PRICES = Object.freeze({
  local: { usdInPerM: 0, usdOutPerM: 0 }, fleet: { usdInPerM: 0, usdOutPerM: 0 }, remote: { usdInPerM: 0, usdOutPerM: 0 }, hosted: { usdInPerM: 0.1, usdOutPerM: 0.2 },
  "claude-haiku-4-5": { usdInPerM: 1, usdOutPerM: 5 }, "claude-sonnet-5": { usdInPerM: 3, usdOutPerM: 15 }, "claude-sonnet-5-5": { usdInPerM: 3, usdOutPerM: 15 }, "claude-sonnet-4-6": { usdInPerM: 3, usdOutPerM: 15 },
  "claude-opus-5": { usdInPerM: 15, usdOutPerM: 75 }, "claude-opus-5-5": { usdInPerM: 15, usdOutPerM: 75 },
});
export function priceOf(model, tier) { return DEFAULT_PRICES[String(model).replace(/^anthropic:/, "")] || DEFAULT_PRICES[tier] || { usdInPerM: 0, usdOutPerM: 0 }; }
