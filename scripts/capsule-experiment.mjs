#!/usr/bin/env node
// capsule-experiment.mjs — how much does a sealed capsule leak, to whom, and how fast?
//
//   node scripts/capsule-experiment.mjs            full run (~10-20 min), writes docs/data/capsule-experiment.json
//   node scripts/capsule-experiment.mjs --quick    small run, for the test suite and a smoke check
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// PRE-REGISTRATION (FOLD-CONSTITUTION II.5 — written BEFORE the structured-model results
// existed; nothing below was changed after seeing them)
//
// Disclosure of what was seen first: the toy binary-vector experiment (Section A) was run
// ONCE during the survey of existing work, using the Fold's own fold-chat-seal.js, and gave
// naive-neighbour centroid identification 96.2% and symmetric ~20% at K=5. Section A's
// predictions below are therefore NOT blind. Sections B-E concern a different, structured
// model (src/capsule.js) whose results did not exist when these predictions were written.
//
// FIXED PARAMETERS
//   K (worlds per capsule)        3, 5, 8            chance = 1/K
//   situations                    7 events, 6 sources (chains of 2-3 claims), P(source disagrees)=0.35,
//                                 valid-witness pool >= 20; a fresh situation per trial
//   true witness prior            uniform over the pool of valid witness sets (unions of whole sources)
//   Section B trials              structural attackers: 4000 capsules per (construction, K);
//                                 learned attackers: train 6000, evaluate on 2000 HELD-OUT capsules
//   Section C trials              1000 situations (oracle alignment) / 250 (search alignment);
//                                 N in {1,2,3,4,6,8,12,16,24}
//   attackers (B)  structural: centroid, outlier, majority, support, degree-odd, degree-typical,
//                              consistency, size-prior, first-slot;  learned: conditional logit,
//                              MLP(12) on 18 per-world features (src/capsule-attack.js FEATURES)
//   attacker (C)   intersection attack over N capsules of one situation (symbols and decoys resampled),
//                  with the single-capsule centroid score as tie-break (AMENDMENT, made after the --quick smoke run
//                  and before any full-run result: without it a cached naive capsule's curve would read 20% although
//                  one capsule already gives 90%. It can only raise the attacker's numbers.)
//   success bar    a construction HOLDS at (K, attacker) iff the Wilson 95% UPPER bound of
//                  identification < 1/K + 0.05; it LEAKS iff the LOWER bound > 1/K + 0.05;
//                  otherwise INCONCLUSIVE. A design claim is "supported" only if it holds against
//                  EVERY attacker in its row, learned included.
//
// PREDICTIONS
//   A  toy: naive centroid >= 85% at K=5; symmetric (hidden-centre XOR) within 2 points of 20%.
//      (The user's reported 88% is expected NOT to reproduce exactly; we report what we get.)
//   B1 naive-neighbours       LEAKS against centroid/majority at every K.
//   B2 symmetric-xor          LEAKS against `consistency` and the learned attackers (its decoys are
//                             random flips, so some are cyclic / implausible), though it holds in the toy.
//   B3 symmetric-orbit        HOLDS against everything (K identical copies) — and hides nothing about
//                             the structure (E2).
//   B4 symmetric-exchangeable HOLDS against everything incl. learned (decoys ~ the true prior).
//   B5 symmetric-mismatched   LEAKS against the learned attackers (prior structure is learnable).
//   C1 repeated queries: with fresh decoys per query, intersection identification rises with N and
//      exceeds 2x chance by N <= 3 and 90% by N <= 8 (oracle alignment); for naive and for exchangeable.
//   C2 a realistic (search) alignment is slower than oracle but reaches the same plateau.
//   C3 caching the capsule (same bytes) keeps the curve FLAT at its N=1 value; memoised decoys under
//      fresh symbols also flat; a query budget B caps the curve at its value at N=B.
//   C4 larger K delays but does not prevent the leak.
//   E1 constraint-space capsules of one situation are LINKABLE (invariant graph hash) with ~100% recall
//      and ~0% false links, even with symbols resampled — request patterns leak.
//   E2 attribute leakage: orbit worlds reveal the real world's size exactly; exchangeable worlds give
//      no better estimate of it than the prior alone.
//   constraint-space is T-independent by construction (a byte-identity test, tested in
//   src/capsule.test.mjs); its identification is not measured because it has no world to identify.
// ══════════════════════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { mulberry32, makeSituation, sampleWitness, buildCapsule, buildWorlds, closureOf } from "../src/capsule.js";
import { viewOf, worldFeatures, STRUCTURAL, FEATURES, tieAware, wilson, trainScorer, truthMap, alignSearch, permuteSet, wlHash, estimateRealSize } from "../src/capsule-attack.js";

const QUICK = process.argv.includes("--quick");
const P = QUICK
  ? { toyTrials: 600, structTrials: 400, train: 600, test: 300, epochs: 25, repOracle: 120, repSearch: 24, linkM: 12, attrN: 300, Ns: [1, 2, 4, 8], Ks: [3, 5] }
  : { toyTrials: 4000, structTrials: 4000, train: 6000, test: 2000, epochs: 60, repOracle: 1000, repSearch: 250, linkM: 40, attrN: 2000, Ns: [1, 2, 3, 4, 6, 8, 12, 16, 24], Ks: [3, 5, 8] };
const OUT = {};
const pct = (x) => (100 * x).toFixed(1) + "%";
const cell = (w) => `${pct(w.p)} [${pct(w.lo)},${pct(w.hi)}]`;
const verdict = (w, K) => (w.hi < 1 / K + 0.05 ? "HOLDS" : w.lo > 1 / K + 0.05 ? "LEAKS" : "inconclusive");
const t0 = Date.now();
const log = (...a) => console.log(...a);

// ═════════════ A. the toy (the Fold's fold-chat-seal.js construction, ported verbatim in behaviour) ═════════════
function toy() {
  const hamming = (a, b) => a.reduce((d, x, i) => d + (x ^ b[i]), 0);
  const randBits = (k, rng) => Array.from({ length: k }, () => (rng() < 0.5 ? 1 : 0));
  const flipSome = (v, w, rng) => { const o = v.slice(), s = new Set(); while (s.size < Math.min(w, v.length)) s.add(Math.floor(rng() * v.length)); for (const i of s) o[i] ^= 1; return o; };
  const maskOf = (k, w, rng) => { const m = new Array(k).fill(0), s = new Set(); while (s.size < Math.min(w, k)) s.add(Math.floor(rng() * k)); for (const i of s) m[i] = 1; return m; };
  const shuffle = (a, rng) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };
  const make = (mode, k, n, flips, rng) => {
    const truth = randBits(k, rng);
    if (mode === "naive") { const ws = [truth]; while (ws.length < n) ws.push(flipSome(truth, 1 + Math.floor(rng() * (flips + 1)), rng)); const ord = shuffle(ws.map((_, i) => i), rng); return { worlds: ord.map((i) => ws[i]), real: ord.indexOf(0) }; }
    const w = Math.max(1, flips), masks = Array.from({ length: n }, () => maskOf(k, w, rng)), real = Math.floor(rng() * n);
    const centre = truth.map((x, i) => x ^ masks[real][i]);
    return { worlds: masks.map((m) => centre.map((x, i) => x ^ m[i])), real };
  };
  const best = (W, score) => { let bi = 0, bs = -Infinity; W.forEach((w, i) => { const s = score(w, i); if (s > bs) { bs = s; bi = i; } }); return bi; };
  const attacks = {
    centroid: (W) => best(W, (w, i) => -W.reduce((s, x, j) => s + (j === i ? 0 : hamming(w, x)), 0)),
    outlier: (W) => best(W, (w, i) => W.reduce((s, x, j) => s + (j === i ? 0 : hamming(w, x)), 0)),
    majority: (W) => { const k = W[0].length; const maj = Array.from({ length: k }, (_, c) => (W.reduce((s, w) => s + w[c], 0) * 2 > W.length ? 1 : 0)); return best(W, (w) => -hamming(w, maj)); },
    position: () => 0,
    lexicographic: (W) => best(W, (w) => -parseInt(w.slice(0, 20).join("") || "0", 2)),
  };
  const run = (mode, k, n, flips, trials, seed) => {
    const rng = mulberry32(seed), hits = Object.fromEntries(Object.keys(attacks).map((a) => [a, 0]));
    for (let t = 0; t < trials; t++) { const { worlds, real } = make(mode, k, n, flips, rng); for (const [a, f] of Object.entries(attacks)) if (f(worlds) === real) hits[a]++; }
    return Object.fromEntries(Object.entries(hits).map(([a, h]) => [a, wilson(h, trials)]));
  };
  log("\n══ A. TOY (binary fact vectors, the Fold's own construction), K=5, k=16, flips=1, n=" + P.toyTrials + " per mode  [chance 20.0%]");
  const res = {};
  for (const mode of ["naive", "symmetric"]) {
    res[mode] = run(mode, 16, 5, 1, P.toyTrials, 11);
    log(mode.padEnd(10) + Object.entries(res[mode]).map(([a, w]) => `${a} ${cell(w)}`).join("  "));
  }
  log("exploratory (post-hoc, NOT pre-registered): where does the reported ~88% appear? naive, centroid attacker, by (k, flips):");
  res.sweep = [];
  for (const k of [8, 12, 16, 32]) for (const flips of [1, 2, 3, 5]) { const r = run("naive", k, 5, flips, Math.min(P.toyTrials, 2000), 5); res.sweep.push({ k, flips, centroid: r.centroid.p, majority: r.majority.p }); }
  log(res.sweep.map((s) => `k=${s.k} flips=${s.flips}: centroid ${pct(s.centroid)} majority ${pct(s.majority)}`).join("\n"));
  OUT.toy = res;
}

// ═════════════ B. the structured model: single-capsule identification ═════════════
const WORLD_CONSTRUCTIONS = ["naive-neighbours", "symmetric-xor", "symmetric-orbit", "symmetric-exchangeable", "symmetric-mismatched"];
function gen(construction, K, rng) {
  for (;;) {
    try {
      const situation = makeSituation(rng);
      const T = sampleWitness(situation, rng);
      const { capsule, key } = buildCapsule({ situation, witnessed: T, construction, K, rng });
      const view = viewOf(capsule);
      return { situation, T, capsule, key, view, X: worldFeatures(view), real: key.real };
    } catch (e) { if (!/enough|smaller|large enough/.test(e.message)) throw e; }
  }
}
function priorMeanSize() { const rng = mulberry32(777); let s = 0, c = 0; for (let i = 0; i < 400; i++) { const sit = makeSituation(rng); for (const p of sit.pool) { s += p.length; c++; } } return s / c; }

function singleCapsule() {
  const pms = priorMeanSize();
  log(`\n══ B. SINGLE-CAPSULE IDENTIFICATION  (structural n=${P.structTrials}; learned train ${P.train} / held-out ${P.test})  prior mean witness size ${pms.toFixed(2)} claims`);
  const table = {};
  for (const K of P.Ks) {
    log(`\n-- K=${K} (chance ${pct(1 / K)})`);
    for (const c of WORLD_CONSTRUCTIONS) {
      const rng = mulberry32(1000 + K);
      const struct = Object.fromEntries(Object.keys(STRUCTURAL).map((a) => [a, 0]));
      for (let t = 0; t < P.structTrials; t++) { const g = gen(c, K, rng); for (const [a, f] of Object.entries(STRUCTURAL)) struct[a] += tieAware(f(g.view, g.X, { priorMeanSize: pms }), g.real); }
      const row = Object.fromEntries(Object.entries(struct).map(([a, h]) => [a, wilson(h, P.structTrials)]));
      // learned: train on one seed, evaluate on held-out capsules from a DIFFERENT seed
      const trRng = mulberry32(5000 + K), teRng = mulberry32(9000 + K);
      const train = Array.from({ length: P.train }, () => { const g = gen(c, K, trRng); return { X: g.X, y: g.real }; });
      const test = Array.from({ length: P.test }, () => { const g = gen(c, K, teRng); return { X: g.X, y: g.real }; });
      for (const [name, hidden] of [["learned-logit", 0], ["learned-mlp", 12]]) {
        const m = trainScorer(train, { hidden, epochs: P.epochs, seed: 3 });
        const acc = test.reduce((s, { X, y }) => s + tieAware(m.score(X), y), 0);
        row[name] = wilson(acc, P.test);
        row[name].trainAcc = m.trainAcc;
      }
      table[`${c}@K${K}`] = row;
      const worst = Object.entries(row).sort((a, b) => b[1].p - a[1].p)[0];
      const verdicts = Object.entries(row).map(([a, w]) => [a, verdict(w, K)]);
      const leaks = verdicts.filter(([, v]) => v === "LEAKS").map(([a]) => a);
      log(`${c.padEnd(24)} worst: ${worst[0]} ${cell(worst[1])}   ${leaks.length ? "LEAKS vs " + leaks.join(",") : verdicts.every(([, v]) => v === "HOLDS") ? "HOLDS vs all" : "no leak proven; inconclusive vs " + verdicts.filter(([, v]) => v === "inconclusive").map(([a]) => a).join(",")}`);
      log("   " + Object.entries(row).map(([a, w]) => `${a} ${pct(w.p)}`).join(" · "));
    }
  }
  OUT.single = table;
  OUT.priorMeanSize = pms;
}

// ═════════════ C/D. repeated queries and mitigations ═════════════
function contribs(views, perms) {
  // perms[i]: view i symbol position -> ref symbol position. contrib[i][j] = best Jaccard of ref world j to any aligned world of view i.
  const ref = views[0], n = ref.n, out = [];
  const jac = (A, B) => { let i = 0; for (const x of A) if (B.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 1; };
  for (let i = 1; i < views.length; i++) {
    const al = views[i].worlds.map((w) => permuteSet(w.set, perms[i], n));
    out.push(ref.worlds.map((w) => Math.max(...al.map((a) => jac(w.set, a)))));
  }
  return out;
}

/** mode: fresh | cache | memo-fresh-symbols. Returns per-N identification (oracle or search alignment). */
function repeated({ construction, K, mode = "fresh", align = "oracle", trials, Ns, seed }) {
  const rng = mulberry32(seed);
  const Nmax = Math.max(...Ns);
  const hit = Object.fromEntries(Ns.map((N) => [N, 0]));
  const alignOK = [];
  for (let t = 0; t < trials; t++) {
    let situation, T, first;
    for (;;) { try { situation = makeSituation(rng); T = sampleWitness(situation, rng); first = buildCapsule({ situation, witnessed: T, construction, K, rng }); break; } catch (e) { if (!/enough|smaller|large enough/.test(e.message)) throw e; } }
    const caps = [first];
    // the worlds of the first capsule, as claim-index sets, for memoisation
    const idxOfPair = (i) => situation.claims.findIndex((c) => c.a === i[0] && c.b === i[1]);
    for (let i = 1; i < Nmax; i++) {
      if (mode === "cache") caps.push(first);
      else if (mode === "memo-fresh-symbols") {
        const w0 = first.capsule.worlds.map((w) => w.claims.map(([a, b]) => idxOfPair([first.key.eventOf[a], first.key.eventOf[b]])).sort((x, y) => x - y));
        caps.push(buildCapsule({ situation, witnessed: T, construction, K, rng, fixedWorlds: { worlds: w0, real: first.key.real } }));
      } else caps.push(buildCapsule({ situation, witnessed: T, construction, K, rng }));
    }
    const views = caps.map((c) => viewOf(c.capsule));
    const maps = caps.map((c) => truthMap(c.capsule, c.key));
    const inv0 = new Map(maps[0].map((e, p) => [e, p]));
    const perms = views.map((v, i) => {
      if (i === 0) return [...Array(v.n).keys()];
      if (align === "oracle") return maps[i].map((e) => inv0.get(e));
      const p = alignSearch(v, views[0], rng);
      const truth = maps[i].map((e) => inv0.get(e));
      alignOK.push(p.every((x, k) => x === truth[k]) ? 1 : 0);
      return p;
    });
    const cs = contribs(views, perms);
    const real = first.key.real;
    const X0 = worldFeatures(views[0]), MD = FEATURES.indexOf("meanDist");
    for (const N of Ns) {
      // intersection score; the single-capsule centroid ("closest to the others") breaks ties, so a curve is never
      // below what one capsule already gives away (naive-neighbours: 90%+ at N=1).
      const sc = views[0].worlds.map((_, j) => 1 + cs.slice(0, N - 1).reduce((s, c) => s + c[j], 0) - 1e-3 * X0[j][MD]);
      hit[N] += tieAware(sc, real);
    }
  }
  return { curve: Object.fromEntries(Ns.map((N) => [N, wilson(hit[N], trials)])), alignAccuracy: alignOK.length ? alignOK.reduce((a, b) => a + b, 0) / alignOK.length : null, trials };
}
const breakEven = (curve, K, rule) => { for (const [N, w] of Object.entries(curve)) if (rule(w, K)) return +N; return null; };

function repeatedAll() {
  log(`\n══ C. REPEATED QUERIES — intersection attack over N capsules of ONE situation (symbols and decoys resampled each time)`);
  log(`   oracle alignment n=${P.repOracle} situations; search alignment n=${P.repSearch}; chance = 1/K`);
  const res = {};
  const show = (label, r, K) => {
    log(label.padEnd(44) + P.Ns.map((N) => `N=${N}:${pct(r.curve[N].p)}`).join(" ") + (r.alignAccuracy != null ? `  (alignment exact ${pct(r.alignAccuracy)})` : ""));
    return { ...r, doubleChanceAtN: breakEven(r.curve, K, (w, k) => w.lo > 2 / k), ninetyAtN: breakEven(r.curve, K, (w) => w.lo > 0.9), majorityAtN: breakEven(r.curve, K, (w) => w.lo > 0.5) };
  };
  for (const c of ["naive-neighbours", "symmetric-xor", "symmetric-exchangeable", "symmetric-mismatched"]) {
    res[`${c}@K5/oracle`] = show(`${c} K=5 oracle`, repeated({ construction: c, K: 5, trials: P.repOracle, Ns: P.Ns, seed: 31 }), 5);
  }
  for (const c of ["naive-neighbours", "symmetric-exchangeable"]) {
    res[`${c}@K5/search`] = show(`${c} K=5 search-align`, repeated({ construction: c, K: 5, align: "search", trials: P.repSearch, Ns: P.Ns, seed: 41 }), 5);
  }
  log("-- C4: effect of K (symmetric-exchangeable, oracle)");
  for (const K of P.Ks) res[`symmetric-exchangeable@K${K}/oracle`] = K === 5 ? res["symmetric-exchangeable@K5/oracle"] : show(`symmetric-exchangeable K=${K}`, repeated({ construction: "symmetric-exchangeable", K, trials: P.repOracle, Ns: P.Ns, seed: 51 + K }), K);
  log("-- C: orbit (K isomorphic copies): all worlds identical, nothing to intersect");
  log("   (symmetric-orbit capsules are K copies of the same structure: every attacker is at chance by construction; not run through alignment)");

  log(`\n══ D. MITIGATIONS (symmetric-exchangeable K=5, and naive-neighbours K=5)`);
  for (const c of ["symmetric-exchangeable", "naive-neighbours"]) {
    res[`${c}/cache`] = show(`${c}: cache (same bytes resent), oracle`, repeated({ construction: c, K: 5, mode: "cache", trials: P.repOracle, Ns: P.Ns, seed: 61 }), 5);
    res[`${c}/memo-fresh-symbols`] = show(`${c}: memoised decoys, fresh symbols, oracle`, repeated({ construction: c, K: 5, mode: "memo-fresh-symbols", trials: P.repOracle, Ns: P.Ns, seed: 62 }), 5);
    res[`${c}/memo-fresh-symbols/search`] = show(`${c}: memoised decoys, fresh symbols, search`, repeated({ construction: c, K: 5, mode: "memo-fresh-symbols", align: "search", trials: P.repSearch, Ns: P.Ns, seed: 63 }), 5);
  }
  const fr = res["symmetric-exchangeable@K5/oracle"].curve;
  for (const B of [1, 2, 3, 4]) if (fr[B]) log(`query budget B=${B}: the situation is refused after ${B} capsule(s) -> identification capped at ${cell(fr[B])} (fresh-decoy curve value at N=${B}); cost: the ${B + 1}th query on that situation is not answered remotely`);
  log("padding (larger K), exchangeable fresh: see C4 above — larger K lowers the early-N values but the curve still converges.");
  log("batching: sending several queries on the SAME situation in one request is the cache (same worlds, one call); batching DIFFERENT situations hides which belong together only if their structures cannot be separated — see E1 (they can).");
  OUT.repeated = res;
}

// ═════════════ E. linkage and attribute leakage ═════════════
function linkage() {
  log(`\n══ E1. LINKAGE of constraint-space capsules (T-independent, symbols resampled): invariant-hash linking over ${P.linkM} situations × 3 capsules`);
  const rng = mulberry32(88);
  let sameEq = 0, sameN = 0, diffEq = 0, diffN = 0;
  for (let rep = 0; rep < (QUICK ? 4 : 12); rep++) {
    const caps = [];
    for (let s = 0; s < P.linkM; s++) { const sit = makeSituation(rng); for (let q = 0; q < 3; q++) { const { capsule } = buildCapsule({ situation: sit, construction: "constraint-space", rng }); const idx = Object.fromEntries(capsule.events.map((e, i) => [e, i])); caps.push({ s, h: wlHash(capsule.events.length, capsule.universe.map((u) => [idx[u.a], idx[u.b]])) }); } }
    for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) { const same = caps[i].s === caps[j].s; const eq = caps[i].h === caps[j].h; if (same) { sameN++; if (eq) sameEq++; } else { diffN++; if (eq) diffEq++; } }
  }
  const rec = wilson(sameEq, sameN), fl = wilson(diffEq, diffN);
  log(`same-situation capsule pairs linked: ${cell(rec)} (n=${sameN});  different-situation pairs falsely linked: ${cell(fl)} (n=${diffN})`);
  OUT.linkage = { recall: rec, falseLink: fl };

  log(`\n══ E2. ATTRIBUTE LEAKAGE: how well does the remote estimate the REAL witness set's size (claims)? mean |error| (n=${P.attrN}); prior-only estimator = pool mean`);
  const rows = {};
  const pm = OUT.priorMeanSize ?? priorMeanSize();
  for (const [label, c, K] of [["abstract only (K=1)", "symmetric-exchangeable", 1], ["symmetric-orbit K=5", "symmetric-orbit", 5], ["naive-neighbours K=5", "naive-neighbours", 5], ["symmetric-xor K=5", "symmetric-xor", 5], ["symmetric-exchangeable K=5", "symmetric-exchangeable", 5], ["symmetric-mismatched K=5", "symmetric-mismatched", 5]]) {
    const r2 = mulberry32(99);
    const err = [], base = [];
    for (let i = 0; i < P.attrN; i++) { const g = gen(c, K, r2); const truth = g.T.length; err.push(Math.abs(estimateRealSize(g.view) - truth)); base.push(Math.abs(pm - truth)); }
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length, h = (a) => 1.96 * Math.sqrt(a.reduce((s, x) => s + (x - m(a)) ** 2, 0) / (a.length - 1)) / Math.sqrt(a.length);
    rows[label] = { mae: m(err), ci: h(err), priorMae: m(base), priorCi: h(base) };
    log(`${label.padEnd(30)} MAE ${m(err).toFixed(2)}±${h(err).toFixed(2)}   prior-only MAE ${m(base).toFixed(2)}±${h(base).toFixed(2)}`);
  }
  OUT.attribute = rows;
}

toy();
singleCapsule();
repeatedAll();
linkage();
log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (!QUICK) { fs.mkdirSync("docs/data", { recursive: true }); fs.writeFileSync(path.join("docs", "data", "capsule-experiment.json"), JSON.stringify({ params: P, at: new Date().toISOString(), ...OUT }, null, 1)); log("wrote docs/data/capsule-experiment.json"); }
