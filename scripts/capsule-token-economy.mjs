#!/usr/bin/env node
// capsule-token-economy.mjs — MEASURE the token economy of the sealed capsule on one realistic workload.
//
//   node scripts/capsule-token-economy.mjs                 full: 5 real Wikipedia articles, 12 variants, models gemma2:2b + remote
//   node scripts/capsule-token-economy.mjs --counts-only   no model calls: sizes only
//   node scripts/capsule-token-economy.mjs --models gemma2:2b,claude-sonnet-4-6 --variants 12
//
// THE WORKLOAD (a stand-in for the chat's grounded turn / a khora reasoning spec over retrieved passages):
//   five public English Wikipedia articles (Apollo 11, Apollo program, Apollo 8, Saturn V, Neil Armstrong), fetched once from the
//   public API into ~/.heimdall/cache/wiki. Each article is a SOURCE. From each, the first six sentences that carry exactly one
//   distinct year become six dated EVENTS in textual order; the source's claims are the chain of "X before Y" between events in
//   year order. So: 30 events, 25 claims, five sources, no source in conflict with another (real articles rarely contradict;
//   this workload therefore has NO cycle — the witnessed set is only a choice of which sources were verified).
//   A VARIANT is a choice of witnessed sources (a valid witness set); 12 variants are drawn.
//   The task is the capsule's: for each world, which pairs follow by chaining two or more claims.
//
// WHAT IS COUNTED (and which counts are measured vs estimated — every cell says which)
//   local reading tokens    the full text of the five articles. MEASURED by gemma2:2b's own tokenizer (Ollama prompt_eval_count over
//                           chunks that fit its context, summed); a chars/4 ESTIMATE is shown beside it.
//   external prompt tokens  the capsule prompt that would leave the machine, counted the same way (gemma2 tokenizer, MEASURED) and,
//                           where a remote model ran, that provider's own prompt_tokens (MEASURED, usage field).
//   external output tokens  the remote model's completion_tokens (MEASURED). For a reasoning model these include thinking tokens.
//   accuracy                real-world exactness against the locally computed closure, and the local gate's verdict.
//   baseline                the SAME task with the real event text as labels instead of opaque symbols (the "raw" arm): its
//                           accuracy and tokens, so the cost of abstraction (if any) is a paired difference.
//
// PRE-REGISTRATION (before any model call here): the illustrative "80,000 local -> ~450 external" is predicted NOT to hold on this
// workload in total (input + output): the capsule input is roughly constant in the number of events and claims (a few hundred
// tokens, independent of passage length), but the ANSWER enumerates derived pairs and dominates the external size; worlds
// multiply the input by K; constraint-space enumerates chains and is the largest. Predicted: local/external ratio in the tens,
// not hundreds, for the abstract arm; accuracy cost of abstraction for the strong remote model <= 10 points.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wilson } from "../src/capsule-attack.js";
import {
  mulberry32, buildCapsule, renderPrompt, parseAnswer, derivedOf, closureOf, pid, registerCapsuleChecks, CAPSULE_ACCEPTANCE,
  proposalFromReply, createSymbolRegistry, checkDerived, chainF1, allChains,
} from "../src/capsule.js";
import { runAcceptance } from "../src/acceptance.js";

registerCapsuleChecks();
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const ARM_FILTER = (process.argv.includes("--arms") ? process.argv[process.argv.indexOf("--arms") + 1] : "").split(",").filter(Boolean);
const COUNTS_ONLY = process.argv.includes("--counts-only");
const VARIANTS = Number(arg("--variants", 12));
const LOCAL_VARIANTS = Number(arg("--local-variants", 4)); // gemma2:2b is slow and, on this task, 0/30 in capsule-e2e: a few variants suffice to show it
const MODELS = COUNTS_ONLY ? [] : arg("--models", "gemma2:2b,claude-sonnet-4-6").split(",");
const OLLAMA = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith("http") ? process.env.OLLAMA_HOST : "http://" + process.env.OLLAMA_HOST) : "http://127.0.0.1:11434";
const REMOTE_BASE = process.env.HEIMDALL_REMOTE_BRIDGE || "http://127.0.0.1:8790";
const CACHE = path.join(os.homedir(), ".heimdall", "cache", "wiki");
const TITLES = ["Apollo_11", "Apollo_program", "Apollo_8", "Saturn_V", "Neil_Armstrong"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => (100 * x).toFixed(1) + "%";
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const OUT = { at: new Date().toISOString(), models: {} };

// ── 1. the passages (public text, cached)
fs.mkdirSync(CACHE, { recursive: true });
const passages = [];
for (const t of TITLES) {
  const f = path.join(CACHE, t + ".txt");
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=${t}`, { headers: { "user-agent": "heimdall-capsule-experiment/0.1 (local research)" } });
    const p = Object.values((await r.json()).query.pages)[0];
    fs.writeFileSync(f, p.title + "\n\n" + p.extract);
  }
  passages.push({ title: t.replace(/_/g, " "), text: fs.readFileSync(f, "utf8") });
}
const totalChars = passages.reduce((s, p) => s + p.text.length, 0);

// ── 2. token counting (gemma2:2b's own tokenizer through Ollama; unique prompts so the prompt cache cannot hide tokens)
async function gemmaTokens(text) {
  const nonce = `[${Math.random().toString(36).slice(2, 10)}] `;
  const r = await fetch(OLLAMA + "/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemma2:2b", prompt: nonce + text, stream: false, options: { num_predict: 1, num_ctx: 8192, temperature: 0 } }), signal: AbortSignal.timeout(300000) });
  const j = await r.json();
  if (!Number.isFinite(j.prompt_eval_count)) throw new Error("ollama gave no prompt_eval_count");
  return j.prompt_eval_count;
}
let nonceTokens = 0;
try { nonceTokens = (await gemmaTokens("")) ; } catch (e) { console.log("gemma2 tokenizer unavailable:", e.message); }
async function countTokens(text) { try { return Math.max(0, (await gemmaTokens(text)) - nonceTokens); } catch { return null; } }
async function readingTokens(text) { // chunks that fit the 8k context
  let total = 0; const paras = text.split(/\n\n+/); let cur = "";
  const flush = async () => { if (cur) { const c = await countTokens(cur); if (c == null) return null; total += c; cur = ""; } return total; };
  for (const p of paras) { if ((cur + "\n\n" + p).length > 12000) { if ((await flush()) == null) return null; } cur += (cur ? "\n\n" : "") + p; }
  if ((await flush()) == null) return null;
  return total;
}

// ── 3. the workload situation
const YEAR = /\b(1[5-9]\d\d|20[0-2]\d)\b/g;
function eventsOf(text) {
  const sents = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z])/);
  const seen = new Set(), out = [];
  for (const s of sents) {
    const ys = [...s.matchAll(YEAR)].map((m) => +m[1]);
    if (s.length < 50 || s.length > 280 || new Set(ys).size !== 1 || seen.has(ys[0])) continue;
    seen.add(ys[0]); out.push({ year: ys[0], sentence: s.trim() });
    if (out.length === 6) break;
  }
  return out;
}
const events = [], claims = [];
passages.forEach((p, s) => {
  const ev = eventsOf(p.text).sort((a, b) => a.year - b.year);
  const base = events.length;
  ev.forEach((e) => events.push({ ...e, source: s, label: e.sentence.split(/\s+/).slice(0, 7).join(" ").replace(/["<>]/g, "") + ` (${e.year})` }));
  for (let i = 0; i + 1 < ev.length; i++) claims.push({ a: base + i, b: base + i + 1, source: s });
});
const n = events.length;
const subsets = [];
for (let mask = 1; mask < 1 << passages.length; mask++) { const idx = []; claims.forEach((c, i) => { if (mask >> c.source & 1) idx.push(i); }); if (closureOf(n, idx.map((i) => [claims[i].a, claims[i].b])).derived.length >= 1) subsets.push(idx); }
const situation = { n, sources: passages.length, claims, pool: subsets, rank: null };
const labelOf = events.map((e) => e.label);

console.log(`workload: ${passages.length} public Wikipedia articles, ${totalChars.toLocaleString()} chars → ${n} dated events, ${claims.length} claims, ${subsets.length} valid witness sets; ${allChains(situation).length} chains in the universe`);

// ── 4. local reading size
const localTok = COUNTS_ONLY && !nonceTokens ? null : await readingTokens(passages.map((p) => p.text).join("\n\n"));
OUT.local = { chars: totalChars, tokensGemma2Measured: localTok, tokensCharsOver4Estimated: Math.ceil(totalChars / 4), articles: passages.map((p) => ({ title: p.title, chars: p.text.length })) };
console.log(`LOCAL READING  ${totalChars.toLocaleString()} chars; gemma2 tokenizer (MEASURED): ${localTok?.toLocaleString() ?? "n/a"} tokens; chars/4 (ESTIMATE): ${Math.ceil(totalChars / 4).toLocaleString()}`);

// ── 5. arms
const registry = createSymbolRegistry({ rng: mulberry32(31337) });
const variantRng = mulberry32(2024);
const variants = Array.from({ length: VARIANTS }, () => subsets[Math.floor(variantRng() * subsets.length)].slice());
function rawPrompt(T) {
  const head = 'Statements have the form "X"<"Y", meaning X comes before Y; "<" is transitive. The world below lists ALL of its statements. Give every pair that follows by chaining two or more of its statements and is not itself stated. Reply with JSON only: {"1":[["X","Y"],...]} using the exact labels, [] when nothing follows.';
  return head + "\nWorld 1: " + T.map((i) => `"${labelOf[claims[i].a]}"<"${labelOf[claims[i].b]}"`).join(", ");
}
function scoreRaw(T, text) {
  const parsed = parseAnswer(text); if (!parsed || !Array.isArray(parsed["1"])) return { proposal: null };
  const idx = Object.fromEntries(labelOf.map((l, i) => [l, i])); const pairs = [];
  for (const p of parsed["1"]) { if (!Array.isArray(p) || !(p[0] in idx) || !(p[1] in idx)) return { proposal: { pairs: [[-1, -1]] } }; pairs.push([idx[p[0]], idx[p[1]]]); }
  return { proposal: { pairs } };
}
const ARMS = [
  { id: "raw (text labels, K=1)", kind: "raw", models: true },
  { id: "abstract (symbols, K=1)", kind: "capsule", construction: "symmetric-exchangeable", K: 1, models: true },
  { id: "worlds K=4 exchangeable", kind: "capsule", construction: "symmetric-exchangeable", K: 4, models: true },
  { id: "constraint-space", kind: "capsule", construction: "constraint-space", models: true },
  { id: "worlds K=8 exchangeable", kind: "capsule", construction: "symmetric-exchangeable", K: 8, models: false },
  { id: "naive-neighbours K=4", kind: "capsule", construction: "naive-neighbours", K: 4, models: false },
  { id: "symmetric-orbit K=4", kind: "capsule", construction: "symmetric-orbit", K: 4, models: false },
];

async function ask(model, prompt, maxTokens) {
  const remote = model !== "gemma2:2b";
  for (let attempt = 0; attempt < 5; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch((remote ? REMOTE_BASE : OLLAMA) + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, stream: false, ...(remote ? { heimdall_privacy: "sealed-external" } : { options: { num_ctx: 8192 } }) }), signal: AbortSignal.timeout(420000) });
      const j = await r.json();
      if (r.ok && j.choices?.[0]?.message?.content != null) return { text: j.choices[0].message.content, usage: j.usage ?? null, ms: Date.now() - t0 };
      if (![402, 429].includes(r.status) && r.status < 500) return { error: `${r.status} ${JSON.stringify(j).slice(0, 100)}` };
    } catch (e) { if (attempt === 4) return { error: String(e?.message || e).slice(0, 100) }; }
    await sleep(remote ? 10000 * (attempt + 1) : 2000);
  }
  return { error: "rate-limited" };
}

const sizes = {};
const modelRows = {};
console.log(`\n${"arm".padEnd(26)} ${"prompt chars".padStart(12)} ${"prompt tok (gemma2, measured)".padStart(30)} ${"chars/4 est".padStart(12)}`);
for (const arm of ARMS) {
  const prompts = [];
  for (let v = 0; v < variants.length; v++) {
    const T = variants[v];
    if (arm.kind === "raw") { prompts.push({ prompt: rawPrompt(T), T }); continue; }
    const rng = mulberry32(5000 + v);
    const { capsule, key } = buildCapsule({ situation, witnessed: arm.construction === "constraint-space" ? null : T, construction: arm.construction, K: arm.K, rng, registry });
    if (arm.construction === "constraint-space") key.witnessed = T.slice();
    prompts.push({ prompt: renderPrompt(capsule), capsule, key, T });
  }
  const toks = [];
  for (const p of prompts) { const c = await countTokens(p.prompt); if (c != null) toks.push(c); p.tokens = c; }
  sizes[arm.id] = { chars: mean(prompts.map((p) => p.prompt.length)), tokens: mean(toks), est: mean(prompts.map((p) => Math.ceil(p.prompt.length / 4))) };
  console.log(`${arm.id.padEnd(26)} ${String(Math.round(sizes[arm.id].chars)).padStart(12)} ${String(sizes[arm.id].tokens != null ? Math.round(sizes[arm.id].tokens) : "n/a").padStart(30)} ${String(Math.round(sizes[arm.id].est)).padStart(12)}`);
  modelRows[arm.id] = prompts;
}
OUT.sizes = sizes;

for (const model of MODELS) {
  const remote = model !== "gemma2:2b";
  if (remote) { try { const tags = (await (await fetch(REMOTE_BASE + "/api/tags")).json()).models.map((m) => m.name); if (!tags.includes(model)) { console.log(`${model}: not available on ${REMOTE_BASE} — skipped`); continue; } } catch { console.log(`${REMOTE_BASE} unreachable — ${model} skipped`); continue; } }
  OUT.models[model] = {};
  console.log(`\n── ${model}: ${VARIANTS} paired variants per arm`);
  for (const arm of ARMS.filter((a) => a.models && (!ARM_FILTER.length || ARM_FILTER.some((f) => a.id.startsWith(f))))) {
    const rows = [];
    for (const p of modelRows[arm.id].slice(0, remote ? VARIANTS : LOCAL_VARIANTS)) {
      const maxTokens = arm.construction === "constraint-space" ? 3500 : arm.kind === "raw" ? 1500 : 1200;
      const r = await ask(model, p.prompt, remote ? Math.min(maxTokens * 5, 8000) : Math.min(maxTokens, 1500)); // a cap, not a spend (8000: larger caps were refused for a non-streamed call): a long enumeration must not be truncated
      if (r.error) { rows.push({ error: r.error }); console.log(`   (call failed: ${r.error})`); continue; }
      let rep, exact = false, F1 = null;
      if (arm.kind === "raw") rep = scoreRaw(p.T, r.text);
      else { rep = proposalFromReply({ capsule: p.capsule, key: p.key, situation, text: r.text }); if (arm.construction === "constraint-space") F1 = chainF1(situation, p.key, parseAnswer(r.text)).f1; }
      const gate = await runAcceptance(CAPSULE_ACCEPTANCE, rep.proposal ?? undefined, { capsuleLocal: { situation, T: p.T } });
      exact = rep.proposal ? checkDerived(situation, p.T, rep.proposal.pairs.filter((x) => x[0] >= 0)).exact && !rep.proposal.pairs.some((x) => x[0] < 0) : false;
      // the bridge's completion count for streamed providers is a CHUNK count, not tokens (ACTIVITIES.md): count the reply with gemma2's tokenizer instead
      const outTok = await countTokens(r.text);
      const a0 = r.text.indexOf("{"), a1 = r.text.lastIndexOf("}");
      const jsonTok = a0 >= 0 && a1 > a0 ? await countTokens(r.text.slice(a0, a1 + 1)) : null; // the answer alone, without the prose around it
      rows.push({ exact, accepted: gate.accepted, gate: gate.state, F1, prompt: r.usage?.prompt_tokens ?? null, completion: outTok, jsonTok, replyChars: r.text.length, ms: r.ms });
      if (remote) await sleep(500);
    }
    const ok = rows.filter((r) => !r.error);
    const ex = wilson(ok.filter((r) => r.exact).length, Math.max(1, ok.length));
    const s = { n: rows.length, answered: ok.length, exact: ex, gateAccepted: ok.filter((r) => r.accepted).length, falseAccept: ok.filter((r) => r.accepted && !r.exact).length, falseReject: ok.filter((r) => !r.accepted && r.exact).length, chainF1: mean(ok.filter((r) => r.F1 != null).map((r) => r.F1)), promptTokensProvider: mean(ok.filter((r) => r.prompt != null).map((r) => r.prompt)), completionTokensProvider: mean(ok.filter((r) => r.completion != null).map((r) => r.completion)), jsonOnlyTokens: mean(ok.filter((r) => r.jsonTok != null).map((r) => r.jsonTok)), replyChars: mean(ok.map((r) => r.replyChars)), meanMs: mean(ok.map((r) => r.ms)) };
    OUT.models[model][arm.id] = s;
    console.log(`${arm.id.padEnd(26)} answered ${s.answered}/${s.n}  real-world exact ${pct(ex.p)} [${pct(ex.lo)},${pct(ex.hi)}]  gate accepted ${s.gateAccepted} (false-accept ${s.falseAccept}, false-reject ${s.falseReject})${s.chainF1 != null ? `  chain F1 ${s.chainF1.toFixed(2)}` : ""}${remote ? `  provider tokens in/out ${s.promptTokensProvider != null ? Math.round(s.promptTokensProvider) : "?"}/${s.completionTokensProvider != null ? Math.round(s.completionTokensProvider) : "?"}` : ""}  reply ${Math.round(s.replyChars ?? 0)} chars`);
  }
}

console.log("\n── THE ECONOMY (means over variants; L = local reading tokens, measured with gemma2's tokenizer)");
const L = OUT.local.tokensGemma2Measured ?? OUT.local.tokensCharsOver4Estimated;
for (const model of Object.keys(OUT.models).filter((m) => m !== "gemma2:2b")) {
  console.log(`remote model ${model}: external = provider prompt_tokens + completion_tokens (MEASURED)`);
  for (const [arm, s] of Object.entries(OUT.models[model])) {
    // The bridge reports completion tokens only (provider usage carries no prompt_tokens for Anthropic through it), so the INPUT size
    // is the gemma2-tokenizer count of the exact prompt (MEASURED for gemma2; an approximation of Claude's tokenizer).
    const inTok = s.promptTokensProvider ?? OUT.sizes[arm]?.tokens;
    if (inTok == null) continue;
    const ext = inTok + (s.completionTokensProvider ?? 0);
    console.log(`  ${arm.padEnd(26)} in ${String(Math.round(inTok)).padStart(5)}${s.promptTokensProvider == null ? "~" : " "} out ${String(Math.round(s.completionTokensProvider ?? 0)).padStart(5)}  total ${String(Math.round(ext)).padStart(5)}   local/external ${(L / ext).toFixed(1)}×   input share ${pct(inTok / ext)}   exact ${pct(s.exact.p)}`);
  }
}
console.log(`(for reference, sending the articles raw would cost about ${L.toLocaleString()} input tokens; the illustrative claim is 80,000 → ~450 = 178×)`);
if (!COUNTS_ONLY) { fs.mkdirSync("docs/data", { recursive: true }); fs.writeFileSync("docs/data/token-economy.json", JSON.stringify(OUT, null, 1)); console.log("wrote docs/data/token-economy.json"); }
