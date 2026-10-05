// capsule.js — the SEALED CAPSULE (2026-10, docs/SEALED-CAPSULE.md).
//
// Keep the real situation on the device; send a remote model a sealed, ABSTRACT
// reasoning task; resolve its answer locally. This is PSEUDONYMIZATION, not
// cryptography: relationships, request patterns and repeated queries can still
// leak (measured in scripts/capsule-experiment.mjs). Nothing in this file
// claims otherwise.
//
//   (a) ABSTRACT   a local situation (entities, claims, the witnessed set) becomes
//                  opaque symbols and the formal relation `before`. Symbols are
//                  fresh per capsule and never reused (symbol registry).
//   (b) WORLDS     the real prompt's privilege is removed by sending several
//                  possible worlds and asking what follows in EACH, with no marker
//                  of which matches the local evidence. Constructions:
//                    naive-neighbours       decoys are single-edit neighbours of the real world
//                    symmetric-xor          the Fold's toy hidden-centre construction (fold-chat-seal.js)
//                    symmetric-orbit        K isomorphic copies on disjoint symbols (orbit of an automorphism-closed universe)
//                    symmetric-exchangeable decoys drawn from the SAME distribution as the real witness set
//                    symmetric-mismatched   the same, but from a WRONG prior (the failure mode, measured)
//                    constraint-space       send the compact claim universe, no worlds: ask for derivations with their
//                                           supporting claims; the witnessed set never enters the capsule
//   (c) RESOLVE    intersect the answer with the locally witnessed set, reconnect
//                  symbols to referents, and run the acceptance checks. The remote
//                  output is a PROPOSAL (acceptance.js); the gate is exact.
//
// The formal task is ORDER: claims `X<Y` ("X before Y", transitive) as in khora's
// /v1/reason `order`. The situation: sources narrate chains of dated events; two
// sources may disagree about the order of the same events (so the claim universe
// can contain a cycle); the WITNESSED set is the claims of the sources whose quotes
// resolved against local bytes. A world is a subset of claims taken as established.
// Task per world: every pair that follows by chaining two or more of its claims.
//
// Pure: seed, clock and entropy are injected (Constitution IV.2). Zero dependencies.

import { randomBytes } from "node:crypto";
import { registerCheck } from "./acceptance.js";

export const SCHEMA = "SealedCapsule@1";
export const CONSTRUCTIONS = Object.freeze(["naive-neighbours", "symmetric-xor", "symmetric-orbit", "symmetric-exchangeable", "symmetric-mismatched", "constraint-space"]);

// ───────────────────────── randomness ─────────────────────────

/** mulberry32 — seeded, for experiments. NEVER used for production symbols (see cryptoRng). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The production generator: OS entropy, so a symbol or a decoy cannot be predicted from a seed. */
export function cryptoRng() {
  return () => randomBytes(4).readUInt32BE(0) / 4294967296;
}
const pick = (rng, n) => Math.floor(rng() * n);
export function shuffle(a, rng) { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = pick(rng, i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; }

// ───────────────────────── symbols (never reused) ─────────────────────────

const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
export const SYMBOL_RE = /^[ERW][a-z0-9]{5}$/;

/** A registry of every symbol ever issued by this process (or persisted file). `fresh()` NEVER returns one twice —
 *  across capsules, not just within one. registry=null (experiments) only guarantees uniqueness inside one capsule. */
export function createSymbolRegistry({ rng = cryptoRng() } = {}) {
  const issued = new Set();
  return {
    issued,
    fresh(prefix, n, scope = null) {
      const out = [];
      const seen = scope ?? new Set();
      while (out.length < n) {
        let s = prefix;
        for (let i = 0; i < 5; i++) s += ALNUM[pick(rng, 36)];
        if (issued.has(s) || seen.has(s)) continue;
        issued.add(s); seen.add(s); out.push(s);
      }
      return out;
    },
    get size() { return issued.size; },
  };
}
function freshSymbols(registry, rng, prefix, n, scope) {
  if (registry) return registry.fresh(prefix, n, scope);
  const out = [];
  while (out.length < n) { let s = prefix; for (let i = 0; i < 5; i++) s += ALNUM[pick(rng, 36)]; if (!scope.has(s)) { scope.add(s); out.push(s); } }
  return out;
}

// ───────────────────────── the situation (local, private) ─────────────────────────

/** Pair id for "a before b" over n events. */
export const pid = (a, b, n) => a * n + b;

function acyclicPairs(pairs, n) {
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) adj[a].push(b);
  const st = new Array(n).fill(0);
  const dfs = (u) => { st[u] = 1; for (const v of adj[u]) { if (st[v] === 1) return false; if (st[v] === 0 && !dfs(v)) return false; } st[u] = 2; return true; };
  for (let u = 0; u < n; u++) if (st[u] === 0 && !dfs(u)) return false;
  return true;
}

/** The pool of VALID witness sets: unions of whole sources' claims that are acyclic and non-trivial (something follows:
 *  at least one pair is derived by chaining, so "nothing follows" is never the right answer to the task).
 *  A witnessed set cannot contradict itself; a source is witnessed or not as a unit (its quotes resolve or they don't). */
function witnessPool(claims, sources, n) {
  const pool = [];
  for (let mask = 1; mask < 1 << sources; mask++) {
    const idx = [];
    claims.forEach((c, i) => { if (mask >> c.source & 1) idx.push(i); });
    const ps = idx.map((i) => [claims[i].a, claims[i].b]);
    if (idx.length >= 2 && acyclicPairs(ps, n) && closureOf(n, ps).derived.length >= 1) pool.push(idx);
  }
  return pool;
}

/** A synthetic Fold situation: `events` dated events, `sources` sources each narrating a short chain consistent with a
 *  hidden true order — except that a source disagrees (swaps two adjacent events) with probability `pDisagree`, so the
 *  claim universe can contain a cycle ("two sources disagree"). Returns { n, claims:[{a,b,source}], pool }. */
export function makeSituation(rng, { events = 7, sources = 6, minLen = 2, maxLen = 3, pDisagree = 0.35, minPool = 20, maxChains = 40 } = {}) {
  for (let tries = 0; tries < 500; tries++) {
    const rank = shuffle([...Array(events).keys()], rng);
    const rk = new Array(events); rank.forEach((e, r) => { rk[e] = r; });
    const claims = [], used = new Set();
    let ok = true;
    for (let s = 0; s < sources && ok; s++) {
      let made = false;
      for (let t = 0; t < 40 && !made; t++) {
        const L = minLen + pick(rng, maxLen - minLen + 1);
        const evs = shuffle([...Array(events).keys()], rng).slice(0, L).sort((x, y) => rk[x] - rk[y]);
        if (rng() < pDisagree) { const i = pick(rng, L - 1); [evs[i], evs[i + 1]] = [evs[i + 1], evs[i]]; }
        const cs = [];
        for (let i = 0; i + 1 < evs.length; i++) cs.push([evs[i], evs[i + 1]]);
        if (cs.some(([a, b]) => used.has(pid(a, b, events)))) continue;
        for (const [a, b] of cs) { used.add(pid(a, b, events)); claims.push({ a, b, source: s }); }
        made = true;
      }
      ok = made;
    }
    if (!ok) continue;
    const pool = witnessPool(claims, sources, events);
    const sit = { n: events, sources, claims, pool, rank: rk };
    if (pool.length >= minPool && allChains(sit).length <= maxChains) return sit;
  }
  throw new Error("could not build a situation with a large enough witness pool");
}

/** The TRUE witness prior: the real witnessed set is one of the pool, uniformly. */
export const sampleWitness = (situation, rng) => situation.pool[pick(rng, situation.pool.length)].slice();

// ───────────────────────── ground truth (local) ─────────────────────────

const pairsOf = (situation, idx) => idx.map((i) => [situation.claims[i].a, situation.claims[i].b]);

/** Transitive closure of a world's claims. Returns { acyclic, closure:Set<pid>, derived:[[a,b]] } — derived = follows by
 *  chaining ≥2 claims and is not itself stated. A cyclic world is inconsistent: no derived set is defined. */
export function closureOf(n, pairs) {
  const stated = new Set(pairs.map(([a, b]) => pid(a, b, n)));
  const reach = Array.from({ length: n }, () => new Set());
  for (const [a, b] of pairs) reach[a].add(b);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) if (reach[i].has(k)) for (const j of reach[k]) reach[i].add(j);
  const acyclic = [...Array(n).keys()].every((i) => !reach[i].has(i));
  const derived = [];
  for (let a = 0; a < n; a++) for (const b of reach[a]) if (a !== b && !stated.has(pid(a, b, n))) derived.push([a, b]);
  derived.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return { acyclic, closure: new Set(derived.map(([a, b]) => pid(a, b, n)).concat([...stated])), derived };
}
export const derivedOf = (situation, idx) => closureOf(situation.n, pairsOf(situation, idx));

/** Every SIMPLE chain of ≥2 claims over the universe: [{from,to,via:[claim idx...]}], deterministic order. */
export function allChains(situation, maxChains = 5000) {
  const { n, claims } = situation;
  const out = [];
  const out_edges = Array.from({ length: n }, () => []);
  claims.forEach((c, i) => out_edges[c.a].push(i));
  const dfs = (start, node, via, seen) => {
    if (out.length >= maxChains) return;
    for (const ci of out_edges[node]) {
      const nxt = claims[ci].b;
      if (seen.has(nxt)) continue;
      const v = [...via, ci];
      if (v.length >= 2) out.push({ from: start, to: nxt, via: v });
      seen.add(nxt); dfs(start, nxt, v, seen); seen.delete(nxt);
    }
  };
  for (let s = 0; s < n; s++) dfs(s, s, [], new Set([s]));
  return out;
}

// ───────────────────────── world construction ─────────────────────────

const sortedUniq = (a) => [...new Set(a)].sort((x, y) => x - y);
const key = (idx) => idx.join(",");
const validWorld = (situation, idx) => idx.length >= 2 && acyclicPairs(pairsOf(situation, idx), situation.n);

/** Single-edit neighbours of T: toggle 1..2 claims, kept acyclic and ≥2 claims (a favourable setting for the defender:
 *  the decoys are at least plausible). */
function naiveNeighbours(situation, T, K, rng) {
  const m = situation.claims.length, seen = new Set([key(T)]), out = [];
  let guard = 0;
  while (out.length < K - 1 && guard++ < 5000) {
    const set = new Set(T);
    for (let e = 1 + pick(rng, 2); e > 0; e--) { const c = pick(rng, m); set.has(c) ? set.delete(c) : set.add(c); }
    const w = sortedUniq([...set]);
    if (!validWorld(situation, w) || seen.has(key(w))) continue;
    seen.add(key(w)); out.push(w);
  }
  if (out.length < K - 1) throw new Error("not enough neighbours");
  return out;
}

/** The Fold's toy construction (fold-chat-seal.js makeWorldSet 'symmetric'): masks of equal weight; a hidden centre
 *  = T XOR mask[real]; world j = centre XOR mask[j]. The centre is not a member. No plausibility repair. */
function symmetricXor(situation, T, K, rng, w = 2) {
  const m = situation.claims.length;
  const maskOf = () => { const s = new Set(); while (s.size < w) s.add(pick(rng, m)); return [...s]; };
  const masks = []; const seen = new Set();
  while (masks.length < K) { const mk = maskOf().sort((a, b) => a - b); if (!seen.has(key(mk))) { seen.add(key(mk)); masks.push(mk); } }
  const real = pick(rng, K);
  const bits = new Array(m).fill(0); T.forEach((i) => { bits[i] = 1; });
  const centre = bits.slice(); masks[real].forEach((i) => { centre[i] ^= 1; });
  const worlds = masks.map((mk) => { const b = centre.slice(); mk.forEach((i) => { b[i] ^= 1; }); return b.flatMap((x, i) => (x ? [i] : [])); });
  return { worlds, real };
}

/** Decoys from the SAME distribution as the true witness set (uniform over the valid pool), distinct from T and each other.
 *  Exchangeable: if T ~ pool, the set is invariant to which member is real, so every attacker sits at 1/K. */
function exchangeable(situation, T, K, rng) {
  const others = situation.pool.filter((p) => key(p) !== key(T));
  if (others.length < K - 1) throw new Error("witness pool smaller than K");
  return shuffle(others, rng).slice(0, K - 1);
}

/** Decoys from a WRONG prior: independent claims (acyclic, ≥2), with inclusion probability matched to the mean size of the
 *  true witness sets. The only difference from the truth is STRUCTURE (the truth is unions of whole sources). */
function mismatched(situation, T, K, rng) {
  const m = situation.claims.length;
  const meanSize = situation.pool.reduce((s, p) => s + p.length, 0) / situation.pool.length;
  const p = meanSize / m, seen = new Set([key(T)]), out = [];
  let guard = 0;
  while (out.length < K - 1 && guard++ < 20000) {
    const idx = []; for (let i = 0; i < m; i++) if (rng() < p) idx.push(i);
    if (!validWorld(situation, idx) || seen.has(key(idx))) continue;
    seen.add(key(idx)); out.push(idx);
  }
  if (out.length < K - 1) throw new Error("not enough mismatched decoys");
  return out;
}

/** Build the K worlds (claim-index arrays over the shared universe) and the real slot. The real slot is the KEY. */
export function buildWorlds(situation, T, construction, K, rng) {
  if (construction === "symmetric-xor") return symmetricXor(situation, T, K, rng);
  let decoys;
  if (construction === "naive-neighbours") decoys = naiveNeighbours(situation, T, K, rng);
  else if (construction === "symmetric-orbit") decoys = Array.from({ length: K - 1 }, () => T.slice()); // isomorphic copies
  else if (construction === "symmetric-exchangeable") decoys = exchangeable(situation, T, K, rng);
  else if (construction === "symmetric-mismatched") decoys = mismatched(situation, T, K, rng);
  else throw new Error(`construction ${construction} has no worlds`);
  const real = pick(rng, K);
  const worlds = decoys.slice(); worlds.splice(real, 0, T.slice());
  return { worlds, real };
}

// ───────────────────────── abstraction: the capsule ─────────────────────────

/**
 * Abstract a local situation into a sealed capsule.
 * Returns { capsule, key }.
 *   capsule  what may leave: opaque symbols and the relation `before` — and nothing else
 *   key      what must stay: symbol→event, claim id→claim, the real world slot, the witnessed set
 * `fixedWorlds` ({worlds, real}, from buildWorlds) re-sends a memoised world set under fresh symbols.
 * `witnessed` = claim indices (the local witness assignment). It is read to place the real world and NEVER copied into
 * the capsule; constraint-space capsules do not read it at all (their bytes are identical for any witnessed set).
 */
export function buildCapsule({ situation, witnessed = null, construction = "symmetric-exchangeable", K = 4, rng = cryptoRng(), registry = null, fixedWorlds = null }) {
  if (!CONSTRUCTIONS.includes(construction)) throw new Error(`unknown construction ${construction}`);
  const { n, claims } = situation;
  const scope = new Set();
  if (construction === "constraint-space") {
    const events = freshSymbols(registry, rng, "E", n, scope);
    const ids = freshSymbols(registry, rng, "R", claims.length, scope);
    const order = shuffle([...Array(claims.length).keys()], rng); // presentation order carries no source structure
    const capsule = { schema: SCHEMA, construction, task: "supports", events, universe: order.map((i) => ({ id: ids[i], a: events[claims[i].a], b: events[claims[i].b] })) };
    return { capsule, key: { construction, eventOf: Object.fromEntries(events.map((s, e) => [s, e])), claimOf: Object.fromEntries(ids.map((s, i) => [s, i])), witnessed: witnessed ? witnessed.slice() : null } };
  }
  if (!witnessed) throw new Error("a world construction needs the witnessed set to place the real world");
  const T = sortedUniq(witnessed);
  // fixedWorlds = the memoised decoy set for this situation (a mitigation): the SAME worlds, resampled symbols
  const { worlds, real } = fixedWorlds ?? buildWorlds(situation, T, construction, K, rng);
  if (construction === "symmetric-orbit") {
    // every world on its OWN fresh symbols: K isomorphic copies, no shared event between worlds
    const tables = worlds.map(() => freshSymbols(registry, rng, "E", n, scope));
    const capsule = { schema: SCHEMA, construction, task: "worlds", events: [], worlds: worlds.map((w, j) => ({ symbols: tables[j], claims: sortedPairsToSyms(situation, w, tables[j], rng) })) };
    return { capsule, key: { construction, real, witnessed: T, eventOf: tables.map((t) => Object.fromEntries(t.map((s, e) => [s, e]))) } };
  }
  const events = freshSymbols(registry, rng, "E", n, scope);
  const capsule = { schema: SCHEMA, construction, task: "worlds", events, worlds: worlds.map((w) => ({ claims: sortedPairsToSyms(situation, w, events, rng) })) };
  return { capsule, key: { construction, real, witnessed: T, eventOf: Object.fromEntries(events.map((s, e) => [s, e])) } };
}

// A world's claims in a presentation order that does not depend on claim indices (which would carry source structure).
function sortedPairsToSyms(situation, idx, symOf, rng) {
  return shuffle(idx.map((i) => [symOf[situation.claims[i].a], symOf[situation.claims[i].b]]), rng);
}

// ───────────────────────── what a capsule is allowed to contain ─────────────────────────

/** A capsule that is not ONLY symbols and relations is refused — this is what lets heimdall render the prompt itself
 *  and refuse free text on an `abstract-capsule-only` job. Returns { ok, errors }. */
export function validateCapsule(c, { maxWorlds = 16, maxSymbols = 64, maxClaims = 200 } = {}) {
  const errors = [];
  const symOk = (s, re = SYMBOL_RE) => typeof s === "string" && re.test(s);
  if (!c || typeof c !== "object") return { ok: false, errors: ["not an object"] };
  const allowed = new Set(["schema", "construction", "task", "events", "universe", "worlds"]);
  for (const k of Object.keys(c)) if (!allowed.has(k)) errors.push(`unexpected field ${k}`);
  if (c.schema !== SCHEMA) errors.push("schema");
  if (!CONSTRUCTIONS.includes(c.construction)) errors.push("construction");
  if (!["worlds", "supports"].includes(c.task)) errors.push("task");
  if (!Array.isArray(c.events) || c.events.length > maxSymbols || !c.events.every((s) => symOk(s, /^E[a-z0-9]{5}$/))) errors.push("events must be opaque symbols");
  if (c.task === "worlds") {
    if (!Array.isArray(c.worlds) || c.worlds.length < 1 || c.worlds.length > maxWorlds) errors.push("worlds");
    else for (const w of c.worlds) {
      if (!w || !Array.isArray(w.claims) || w.claims.length > maxClaims || !w.claims.every((p) => Array.isArray(p) && p.length === 2 && p.every((s) => symOk(s, /^E[a-z0-9]{5}$/)))) errors.push("world claims must be pairs of symbols");
      if (w?.symbols !== undefined && !(Array.isArray(w.symbols) && w.symbols.every((s) => symOk(s, /^E[a-z0-9]{5}$/)))) errors.push("world symbols");
      for (const k of Object.keys(w || {})) if (!["claims", "symbols"].includes(k)) errors.push(`unexpected world field ${k}`);
    }
  } else {
    if (!Array.isArray(c.universe) || c.universe.length > maxClaims || !c.universe.every((u) => u && symOk(u.id, /^R[a-z0-9]{5}$/) && symOk(u.a, /^E[a-z0-9]{5}$/) && symOk(u.b, /^E[a-z0-9]{5}$/) && Object.keys(u).length === 3)) errors.push("universe must be {id,a,b} symbols");
  }
  return { ok: errors.length === 0, errors };
}

// ───────────────────────── the prompt (rendered by heimdall, not the caller) ─────────────────────────

const HEAD_WORLDS = 'Statements have the form X<Y, meaning X comes before Y; "<" is transitive. Each world below lists ALL of its statements. For EACH world, give every pair X<Y that follows by chaining two or more of that world\'s statements and is not itself stated there. Reply with JSON only: {"1":[["X","Y"],...],"2":[...]} with one key per world, [] when nothing follows.';
const HEAD_SUPPORTS = 'Statements have ids and the form X<Y, meaning X comes before Y; "<" is transitive. List EVERY chain of two or more statements that links one symbol to another through distinct symbols: for each give the first symbol, the last symbol and the ordered statement ids. Reply with JSON only: {"chains":[{"from":"X","to":"Y","via":["R1","R2"]},...]}';

export function renderPrompt(c) {
  const v = validateCapsule(c);
  if (!v.ok) throw new Error("not a sealed capsule: " + v.errors.join("; "));
  if (c.task === "worlds") return [HEAD_WORLDS, ...c.worlds.map((w, j) => `World ${j + 1}: ${w.claims.map(([a, b]) => `${a}<${b}`).join(", ") || "(no statements)"}`)].join("\n");
  return [HEAD_SUPPORTS, ...c.universe.map((u) => `${u.id}: ${u.a}<${u.b}`)].join("\n");
}

/** Extract the first JSON object from a model's reply (models wrap JSON in prose or fences). null when none parses. */
export function parseAnswer(text) {
  const s = String(text ?? "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { /* try a greedy shrink */ }
  for (let end = b; end > a; end = s.lastIndexOf("}", end - 1)) { try { return JSON.parse(s.slice(a, end + 1)); } catch { /* keep shrinking */ } }
  return null;
}

// ───────────────────────── local resolve ─────────────────────────

/** Reconnect symbols and pull out the answer for the REAL world: { ok, pairs:[[a,b]] in event indices } or a typed failure. */
export function answerForReal(capsule, keyObj, parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, kind: "unresolved", detail: "no JSON answer" };
  const w = parsed[String(keyObj.real + 1)];
  if (!Array.isArray(w)) return { ok: false, kind: "unresolved", detail: `no answer for the world that matters` };
  const table = Array.isArray(keyObj.eventOf) ? keyObj.eventOf[keyObj.real] : keyObj.eventOf;
  const pairs = [];
  for (const p of w) {
    if (!Array.isArray(p) || p.length !== 2 || !(p[0] in table) || !(p[1] in table)) return { ok: false, kind: "check_failed", detail: `a pair names a symbol that is not in the world: ${JSON.stringify(p)?.slice(0, 40)}` };
    pairs.push([table[p[0]], table[p[1]]]);
  }
  return { ok: true, pairs };
}

/** Exactness of a proposed derived-pair set against the locally computed closure of the witnessed set. */
export function checkDerived(situation, T, pairs) {
  const truth = derivedOf(situation, T);
  const want = new Set(truth.derived.map(([a, b]) => pid(a, b, situation.n)));
  const got = new Set(pairs.map(([a, b]) => pid(a, b, situation.n)));
  const missing = [...want].filter((x) => !got.has(x));
  const extra = [...got].filter((x) => !want.has(x));
  // an extra pair whose REVERSE is entailed contradicts the witnessed set (as opposed to merely not following)
  const reversed = extra.filter((x) => want.has(pid(x % situation.n, Math.floor(x / situation.n), situation.n)));
  return { exact: !missing.length && !extra.length, sound: !extra.length, complete: !missing.length, missing: missing.length, extra: extra.length, contradicts: reversed.length, wantSize: want.size, gotSize: got.size };
}

/** constraint-space resolve: keep the chains whose claims are ALL witnessed (the local intersection), return their pairs.
 *  Structurally invalid chains (unknown ids, not a path, repeated symbol) make the proposal check_failed. */
export function resolveSupports(capsule, keyObj, situation, parsed) {
  if (!parsed || !Array.isArray(parsed.chains)) return { ok: false, kind: "unresolved", detail: "no chains array" };
  const T = new Set(keyObj.witnessed);
  const pairs = new Map();
  let invalid = 0;
  for (const ch of parsed.chains) {
    const via = Array.isArray(ch?.via) ? ch.via : null;
    if (!via || via.length < 2 || !via.every((id) => id in keyObj.claimOf)) { invalid++; continue; }
    const idx = via.map((id) => keyObj.claimOf[id]);
    let good = true, node = situation.claims[idx[0]].a;
    const seen = new Set([node]);
    for (const ci of idx) { const c = situation.claims[ci]; if (c.a !== node || seen.has(c.b)) { good = false; break; } node = c.b; seen.add(node); }
    const from = keyObj.eventOf[ch.from], to = keyObj.eventOf[ch.to];
    if (!good || from !== situation.claims[idx[0]].a || to !== node) { invalid++; continue; }
    if (idx.every((ci) => T.has(ci))) pairs.set(pid(from, to, situation.n), [from, to]);
  }
  // a pair the witnessed set STATES outright is not "derived" (same definition as the worlds task)
  for (const ci of T) pairs.delete(pid(situation.claims[ci].a, situation.claims[ci].b, situation.n));
  return { ok: true, pairs: [...pairs.values()], invalid, chains: parsed.chains.length };
}

/** F1 of a returned chain list against every chain of the universe (T-independent: what the remote was asked). */
export function chainF1(situation, keyObj, parsed) {
  const truth = allChains(situation);
  const tk = new Set(truth.map((c) => c.via.join(">")));
  const got = new Set();
  for (const ch of parsed?.chains ?? []) { if (Array.isArray(ch?.via) && ch.via.every((id) => id in keyObj.claimOf)) got.add(ch.via.map((id) => keyObj.claimOf[id]).join(">")); }
  const tp = [...got].filter((x) => tk.has(x)).length;
  const p = got.size ? tp / got.size : 0, r = tk.size ? tp / tk.size : 1;
  return { f1: p + r ? (2 * p * r) / (p + r) : 0, precision: p, recall: r, truth: tk.size, got: got.size };
}

// ───────────────────────── acceptance checks (registered by id) ─────────────────────────

/** ctx.capsuleLocal = { situation, T } — the LOCAL witness data. It never leaves this process; the checks run here. */
export function registerCapsuleChecks() {
  registerCheck("capsule-sound", (proposal, ctx) => {
    const L = ctx?.capsuleLocal; if (!L) return { ok: false, kind: "check_failed", detail: "no local witness data" };
    const r = checkDerived(L.situation, L.T, proposal.pairs ?? []);
    if (r.contradicts) return { ok: false, kind: "contradiction", detail: `${r.contradicts} pair(s) contradict the witnessed order` };
    return r.sound ? { ok: true, detail: "every proposed pair follows from the witnessed claims" } : { ok: false, kind: "check_failed", detail: `${r.extra} pair(s) do not follow from the witnessed claims` };
  });
  registerCheck("capsule-complete", (proposal, ctx) => {
    const L = ctx?.capsuleLocal; if (!L) return { ok: false, kind: "check_failed", detail: "no local witness data" };
    const r = checkDerived(L.situation, L.T, proposal.pairs ?? []);
    return r.complete ? { ok: true, detail: "nothing that follows was left out" } : { ok: false, kind: "check_failed", detail: `${r.missing} entailed pair(s) missing` };
  });
}
export const CAPSULE_ACCEPTANCE = Object.freeze([
  { type: "schema", schema: { type: "object", required: ["pairs"], properties: { pairs: { type: "array", items: { type: "array", minItems: 2, maxItems: 2 } } } } },
  { type: "custom", fn: "capsule-sound" },
  { type: "custom", fn: "capsule-complete" },
]);

/** The Fold's whole local step for one reply: parse → reconnect → {proposal} ready for runAcceptance. */
export function proposalFromReply({ capsule, key: keyObj, situation, text }) {
  const parsed = parseAnswer(text);
  const r = capsule.task === "worlds" ? answerForReal(capsule, keyObj, parsed) : resolveSupports(capsule, keyObj, situation, parsed);
  return r.ok ? { proposal: { pairs: r.pairs }, parsed, invalid: r.invalid ?? 0 } : { proposal: null, parsed, failure: r };
}
