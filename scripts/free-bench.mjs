#!/usr/bin/env node
// free-bench.mjs — are the free models alive, quick, and worth using? Measured, on randomized sealed tasks with follow-ups.
//
//   node scripts/free-bench.mjs                 full run: every keyless/free/local model, 3 chains per family
//   node scripts/free-bench.mjs --quick         probe everything, then ONE chain per family per live model (~minutes)
//   node scripts/free-bench.mjs --probe-only    just "who is alive" (one tiny call per model)
//   node scripts/free-bench.mjs --models gpt-oss,gemma2 --families order,mask --n 5 --seed 42
//   node scripts/free-bench.mjs --reference claude-sonnet-4-6    also run a model on the running bridge as the accuracy ceiling (costs money)
//
// WHAT IT SENDS: only sealed content — opaque symbols and the relation `<` (family "order": capsule.js worlds, then symbol-only
// follow-ups that add / withdraw / undo one statement in a standing conversation) or masked placeholders (family "mask": a code edit
// over TERM_1 / PATH_2 / EMAIL_1 …). Every outbound byte is audited before it leaves; a leak aborts the call.
// WHAT IT JUDGES: each reply by an EXACT local check (the closure is recomputed; placeholders are compared byte for byte), never by
// the model's own confidence. See src/free-bench.js for the bar (fixed before measuring) and src/free-bench.test.mjs for the falsifiers.
// POLITE BY DESIGN: per-(provider,model) pacing, retry-after honored, one retry, a hard call budget and wall-clock deadline.
//
// Output: docs/data/free-bench/{run-<stamp>.json, latest.json, LATEST.md, history.ndjson}. Exit 0 always (a dead provider is a result).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { catalogFor } from "../src/providers.js";
import { fileURLToPath } from "node:url";
import {
  makeOrderTask, scoreOrderTurn, auditOrderMessages, makeMaskTask, scoreMaskTurn, auditMaskMessages, stripThink, classifyFailure, foldDeltas,
  summarizeModel, BAR,
} from "../src/free-bench.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);
const QUICK = flag("--quick"), PROBE_ONLY = flag("--probe-only");
const N = Number(arg("--n", QUICK ? 1 : 3));
const TURNS = Number(arg("--turns", 3));
const K = Number(arg("--K", 3));
const FAMILIES = arg("--families", "order,mask").split(",");
const MAX_MODELS = Number(arg("--max-models", 3));
const SEED = Number(arg("--seed", crypto.randomInt(1, 2 ** 31)));   // randomized per run, printed, stored: a failure is replayable
const CALL_TIMEOUT = Number(arg("--timeout-ms", 90_000));
const MAX_CALLS = Number(arg("--max-calls", 250));
const DEADLINE = Date.now() + Number(arg("--max-minutes", 25)) * 60_000;
const MAX_WAIT = Number(arg("--max-wait-ms", 70_000));            // longest retry-after we will sit out
const OUT = path.resolve(arg("--out", path.join(HERE, "..", "docs", "data", "free-bench")));
const FILTER = arg("--models", "").split(",").filter(Boolean);
const NO_LOCAL = flag("--no-local");
const RECORD = !flag("--no-record");
const BRIDGE = process.env.HEIMDALL_BRIDGE || "http://127.0.0.1:8790";
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434"; // only for the host-contention reading
// minimum gap between two calls to the same (provider, model): OVH documents 2 req/min/IP/model.
const GAP = { ovh: 31_000, llm7: 4_000, pollinations: 4_000, ollama: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let calls = 0;

// ───────────────────────── what to measure: whatever the heimdalls serve ─────────────────────────
//
// Every server runs a heimdall and they coordinate; there is no standalone one and no provider is called directly here.
// The benchmark finds the heimdalls on this machine (anything answering /api/version as a bridge), asks each what it serves,
// and drives every model THROUGH a heimdall, under its sealed-external gate, so its outbound ledger and routing are what is measured.
// A model several heimdalls serve is tested once, through the first in preference order (the primary `heimdall up` port first).

const BRIDGE_PORTS = (process.env.HEIMDALL_BRIDGES || arg("--bridges", "")).split(",").filter(Boolean);
const NOT_CHAT = /whisper|embed|bge-|tts|stable-diffusion|guard|image|video|audio|voxtral|seedance|kling|chroma|krea|jev-|-vl-|vl-|omni|rerank/i;
const PREFER = { ovh: ["gpt-oss-120b", "Meta-Llama-3_3-70B-Instruct", "Qwen3.6-27B", "Mistral-Small-3.2-24B-Instruct-2506", "gpt-oss-20b"] };
const rank = (provider, id) => { const i = (PREFER[provider] || []).indexOf(id); return i < 0 ? 99 : i; };

async function getJson(url, headers = {}, timeoutMs = 20000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status });
  return r.json();
}

/** The heimdalls on this machine: explicit --bridges / HEIMDALL_BRIDGES (full URLs), else a scan of the usual ports. */
async function findBridges() {
  const urls = BRIDGE_PORTS.length ? BRIDGE_PORTS : [BRIDGE, ...[8795, 8796, 8791, 8792, 8793, 8794].map((p) => `http://127.0.0.1:${p}`)];
  const found = [];
  await Promise.all([...new Set(urls)].map(async (url) => {
    try { const v = await getJson(url + "/api/version", {}, 2500); if (/heimdall/i.test(v.version ?? "")) found.push(url); } catch {}
  }));
  return urls.filter((u) => found.includes(u)); // keep preference order
}

/** What one heimdall serves: its /api/tags (fleet, local passthrough, frontier lanes) with each model's lane and privacy class. */
async function serves(url) {
  const tags = (await getJson(url + "/api/tags", {}, 8000)).models ?? [];
  return tags.map((m) => ({ id: m.name, frontier: m.heimdall?.frontier ?? null, privacy: m.heimdall?.privacy ?? null, local: !m.heimdall?.frontier }));
}

async function candidates() {
  const out = [], notes = [], coverage = [], deadByPolicy = [];
  const bridges = await findBridges();
  if (!bridges.length) notes.push("no heimdall answered on any scanned port: start one with `heimdall up`");
  // the free tier of LLM7 is a published fact of its public model list (a discovery read: no prompt is sent): only usage_based_only=false chat models.
  // Read lazily: only when some heimdall actually lists llm7 ids.
  let llm7FreeSet = null, llm7Read = false;
  const readLlm7Free = async () => { if (llm7Read) return llm7FreeSet; llm7Read = true; try { llm7FreeSet = new Set(((await getJson("https://api.llm7.io/v1/models")).data ?? []).filter((m) => m.model_type === "chat" && m.usage_based_only === false).map((m) => m.id)); } catch (e) { notes.push(`llm7: could not read its public model list (${e.message}); not filtering by free tier`); } return llm7FreeSet; };
  const seen = new Set();
  const want = (c) => !FILTER.length || FILTER.some((f) => `${c.provider}:${c.model}`.toLowerCase().includes(f.toLowerCase()));
  for (const url of bridges) {
    let list = [];
    try { list = await serves(url); } catch (e) { coverage.push({ bridge: url, error: e.message }); continue; }
    // free-tier comparisons only: a paid lane (cardRequired, or not in the catalog as keyless/free) is never benchmarked here
    const isFree = (prov) => { const c = catalogFor(prov); return !!c && !c.cardRequired && (c.keyless || !!c.freeQuota); };
    const paid = [...new Set(list.filter((m) => m.frontier && !isFree(m.frontier)).map((m) => m.frontier))];
    if (paid.length) notes.push(`${url}: paid/uncatalogued lanes excluded from the free comparison: ${paid.join(", ")}`);
    const frontier = list.filter((m) => m.frontier && isFree(m.frontier)), local = list.filter((m) => m.local && !/embed/i.test(m.id));
    coverage.push({ bridge: url, models: list.length, frontier: frontier.length, frontierProviders: [...new Set(frontier.map((m) => m.frontier))], local: local.map((m) => m.id) });
    const llm7Free = frontier.some((m) => m.frontier === "llm7") ? await readLlm7Free() : null;
    const byProvider = {};
    for (const m of frontier) {
      const bare = m.id.replace(new RegExp(`^${m.frontier}:`), "");
      if (NOT_CHAT.test(bare)) continue;
      if (m.frontier === "llm7" && llm7Free && !llm7Free.has(bare)) { if (!m.id.includes(":")) deadByPolicy.push(`${url} ${m.id}`); continue; }
      const key = `${m.frontier}:${bare}`;
      if (seen.has(key)) continue; seen.add(key);
      (byProvider[m.frontier] ||= []).push({ provider: m.frontier, model: m.id.includes(":") ? m.id : `${m.frontier}:${m.id}`, bare });
    }
    for (const [prov, ms] of Object.entries(byProvider)) for (const m of ms.sort((a, b) => rank(prov, a.bare) - rank(prov, b.bare)).slice(0, MAX_MODELS)) { const c = { ...m, url: url + "/v1/chat/completions", bridge: url, kind: "free-remote", sealedGate: true }; if (want(c)) out.push(c); }
    if (!NO_LOCAL) for (const m of local.slice(0, MAX_MODELS)) { const key = `ollama:${m.id}`; if (seen.has(key)) continue; seen.add(key); const c = { provider: "ollama", model: m.id, url: url + "/v1/chat/completions", bridge: url, kind: "local" }; if (want(c)) out.push(c); }
  }
  if (deadByPolicy.length) notes.push(`${deadByPolicy.length} llm7 ids a heimdall lists are NOT in LLM7's free tier (usage_based_only): not called; the bridge should not list them`);
  const ref = arg("--reference", null);
  if (ref && bridges[0]) out.push({ provider: "bridge", model: ref, url: bridges[0] + "/v1/chat/completions", bridge: bridges[0], kind: "reference", sealedGate: true });
  return { list: out, notes, coverage, bridges, deadByPolicy };
}

// ───────────────────────── one call ─────────────────────────

const lastCall = new Map();
async function pace(c) {
  const key = `${c.provider}:${c.model}`, gap = GAP[c.provider] ?? 2000;
  const wait = (lastCall.get(key) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(key, Date.now());
}
const locks = new Map(); // one local model at a time: they share this machine's CPU and would time each other
const withLock = async (provider, fn) => { if (provider !== "ollama") return fn(); const prev = locks.get(provider) ?? Promise.resolve(); let rel; const mine = new Promise((r) => (rel = r)); locks.set(provider, prev.then(() => mine)); await prev; try { return await fn(); } finally { rel(); } };

/** One streamed chat call. Returns { status:"ok"|kind, ms, ttftMs, content, reasoning, detail, retryAfterMs, bytes, sha256 }. */
async function chatOnce(c, messages, maxTokens, audit) {
  calls++;
  const body = JSON.stringify({ model: c.model, messages, temperature: 0, max_tokens: maxTokens, stream: true, ...(c.sealedGate ? { heimdall_privacy: "sealed-external" } : {}) });
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const t0 = Date.now(); let ttftMs = null;
  try {
    const r = await fetch(c.url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "x-fold-audit": `bench-${SEED}-${calls}` }, body, signal: AbortSignal.timeout(CALL_TIMEOUT) });
    if (!r.ok) { const text = await r.text().catch(() => ""); return { ...classifyFailure({ status: r.status, body: text, headers: r.headers }), status: classifyFailure({ status: r.status, body: text, headers: r.headers }).kind, ms: Date.now() - t0, ttftMs: null, bytes: body.length, sha256 }; }
    const ctype = r.headers.get("content-type") || "";
    let content = "", reasoning = "";
    if (/text\/event-stream/.test(ctype) && r.body) {
      const dec = new TextDecoder(); let buf = ""; const payloads = [];
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const p = line.slice(5).trim(); payloads.push(p);
          if (ttftMs == null && p !== "[DONE]") { const f = foldDeltas([p]); if (f.content || f.reasoning) ttftMs = Date.now() - t0; }
        }
      }
      ({ content, reasoning } = foldDeltas(payloads));
    } else {
      const j = await r.json().catch(() => ({}));
      content = j.choices?.[0]?.message?.content ?? ""; reasoning = j.choices?.[0]?.message?.reasoning_content ?? "";
      ttftMs = Date.now() - t0; // not streamed: first token and last token coincide
    }
    const ms = Date.now() - t0;
    if (!stripThink(content)) return { status: "empty", detail: reasoning ? "reasoning only, no answer inside the token limit" : "200 with no answer text", ms, ttftMs, content: "", reasoning, bytes: body.length, sha256 };
    return { status: "ok", ms, ttftMs, content, reasoning, bytes: body.length, sha256 };
  } catch (e) { const f = classifyFailure({ error: e }); return { status: f.kind, detail: f.detail, ms: Date.now() - t0, ttftMs, bytes: body.length, sha256 }; }
}

/** chatOnce with pacing, one polite retry on a rate limit, and the outbound audit BEFORE any byte leaves. */
async function call(c, messages, maxTokens, audit) {
  const a = audit(messages);
  if (!a.ok) return { status: "LEAK_BLOCKED", detail: JSON.stringify(a.leaks.slice(0, 3)), ms: 0, ttftMs: null, attempts: [] };
  const attempts = [];
  for (let k = 0; k < 2; k++) {
    if (calls >= MAX_CALLS || Date.now() > DEADLINE) return { status: "budget", detail: "call budget or deadline reached", ms: 0, ttftMs: null, attempts };
    await pace(c);
    const r = await withLock(c.provider, () => chatOnce(c, messages, maxTokens, audit));
    attempts.push({ status: r.status, ms: r.ms, detail: r.detail ?? null });
    if (r.status === "ok") return { ...r, attempts };
    if ((r.status === "rate_limited" || r.status === "quota") && r.retryAfterMs && r.retryAfterMs <= MAX_WAIT && k === 0) { await sleep(r.retryAfterMs + 500); continue; }
    if (r.status === "rate_limited" && k === 0) { await sleep(Math.min(MAX_WAIT, GAP[c.provider] ?? 5000)); continue; }
    return { ...r, attempts };
  }
  return { status: attempts.at(-1)?.status ?? "unknown", ms: 0, ttftMs: null, attempts };
}

// ───────────────────────── one model ─────────────────────────

const label = (x) => (String(x.model).startsWith(x.provider + ":") ? x.model : `${x.provider}:${x.model}`);
const clip = (s, n = 1500) => (String(s ?? "").length > n ? String(s).slice(0, n) + "…" : String(s ?? ""));

async function probe(c) {
  const msgs = [{ role: "user", content: "Reply with the single word: ok" }];
  const r = await call(c, msgs, 600, () => ({ ok: true, leaks: [] }));
  return { ok: r.status === "ok", status: r.status, ms: r.ms, ttftMs: r.ttftMs, detail: r.detail ?? null, attempts: r.attempts, reply: clip(r.content, 80) };
}

async function runTrial(c, family, i) {
  const seed = SEED + (family === "order" ? 1000 : 2000) * 1 + i * 7919;
  const task = family === "order" ? makeOrderTask(seed, { K, turns: TURNS }) : makeMaskTask(seed, { turns: TURNS });
  const audit = family === "order" ? (m) => auditOrderMessages(m, task.issued) : auditMaskMessages;
  const messages = [], turns = [];
  let dead = null;
  for (let t = 0; t < task.turns.length; t++) {
    const spec = task.turns[t];
    if (dead) { turns.push({ kind: spec.kind, status: "skipped", reason: dead }); continue; }
    messages.push({ role: "user", content: spec.message });
    const r = await call(c, messages, family === "order" ? 3000 : 2500, audit);
    const rec = { kind: spec.kind, status: r.status, ms: r.ms, ttftMs: r.ttftMs, chars: r.content?.length ?? 0, retries: Math.max(0, (r.attempts?.length ?? 1) - 1), detail: r.detail ?? null, sha256: r.sha256 ?? null, bytesOut: r.bytes ?? null };
    if (r.status === "ok") {
      const reply = stripThink(r.content);
      Object.assign(rec, family === "order" ? await scoreOrderTurn(task, t, reply) : scoreMaskTurn(task, t, reply));
      rec.reply = clip(reply);
      messages.push({ role: "assistant", content: clip(reply, 3000) });   // the conversation carries what the model actually said
    } else dead = `turn ${t + 1} ${r.status}`;
    turns.push(rec);
  }
  return { family, seed, K: family === "order" ? K : null, turns };
}

async function runModel(c) {
  const p = await probe(c);
  const res = { provider: c.provider, model: c.model, kind: c.kind, probe: p, trials: [] };
  process.stdout.write(`  ${label(c).padEnd(52)} probe ${p.ok ? "ALIVE " + String(p.ms).padStart(6) + "ms" : "DEAD  " + p.status + (p.detail ? " (" + p.detail.slice(0, 70) + ")" : "")}\n`);
  if (!p.ok && !p.attempts.some((a) => a.status === "ok")) { res.summary = summarizeModel({ probe: p, trials: [] }); return res; }
  if (PROBE_ONLY) { res.summary = summarizeModel({ probe: p, trials: [] }); return res; }
  for (const family of FAMILIES) for (let i = 0; i < N; i++) { res.trials.push(await runTrial(c, family, i)); }
  res.summary = summarizeModel({ probe: p, trials: res.trials });
  res.byFamily = Object.fromEntries(FAMILIES.map((f) => [f, summarizeModel({ probe: p, trials: res.trials.filter((t) => t.family === f) })]));
  return res;
}

// ───────────────────────── the machine, so a slow answer is not blamed on the provider ─────────────────────────

/** Who else is using this box, and is Ollama busy with someone's job? A timeout measured while the host is thrashing says little about the provider. */
async function hostView() {
  const h = { cpus: os.cpus().length, load1: +os.loadavg()[0].toFixed(1), cpuIdlePct: null, memFreePct: null, ollamaResident: null, contended: false, why: [] };
  try { const t = execFileSync("top", ["-l", "1", "-n", "0"], { encoding: "utf8", timeout: 8000 }); h.cpuIdlePct = Number(/([\d.]+)% idle/.exec(t)?.[1] ?? NaN) || null; } catch {}
  try { const m = execFileSync("memory_pressure", [], { encoding: "utf8", timeout: 8000 }); h.memFreePct = Number(/free percentage: (\d+)%/.exec(m)?.[1] ?? NaN) || null; } catch {}
  try { h.ollamaResident = ((await getJson(OLLAMA + "/api/ps", {}, 3000)).models ?? []).map((m) => m.name); } catch {}
  if (h.cpuIdlePct != null && h.cpuIdlePct < 15) h.why.push(`CPU ${h.cpuIdlePct}% idle`);
  if (h.memFreePct != null && h.memFreePct < 15) h.why.push(`only ${h.memFreePct}% memory free`);
  h.contended = h.why.length > 0;
  return h;
}

// ───────────────────────── report ─────────────────────────

const pc = (x) => (x == null ? "  -  " : (100 * x).toFixed(0).padStart(3) + "%");
const sec = (ms) => (ms == null ? "   -  " : (ms / 1000).toFixed(1).padStart(5) + "s");
const topFail = (s) => Object.entries(s.failures ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k}×${v}`).join(" ") || "-";

function table(results) {
  const rows = [["model", "grade", "avail", "ttft", "p50", "p95", "order✓", "mask✓", "follow-up✓", "chains✓", "s/accepted", "failures"]];
  for (const r of results) {
    const s = r.summary, o = r.byFamily?.order, m = r.byFamily?.mask;
    const fu = s.followUpExact.reduce((a, x) => ({ n: a.n + x.attempted, k: a.k + x.exact }), { n: 0, k: 0 });
    rows.push([`${label(r)}`.slice(0, 44), s.verdict.grade, s.probeOk || s.ok ? pc(s.availability) : "  0%", sec(s.p50TtftMs), sec(s.p50TotalMs), sec(s.p95TotalMs), o ? pc(o.accuracyOfAnswered) : " - ", m ? pc(m.accuracyOfAnswered) : " - ", fu.n ? pc(fu.k / fu.n) : " - ", s.chains ? `${s.chainsAllExact}/${s.chains}` : "-", s.msPerAccepted != null ? (s.msPerAccepted / 1000).toFixed(1) + "s" : "-", topFail(s)]);
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((x, i) => String(x).padEnd(w[i])).join("  ")).join("\n");
}

/** What the mask family says about placeholder fidelity — the number the de-identifier needs. */
function maskFidelity(results) {
  const rows = [];
  for (const r of results) {
    const ts = r.trials.filter((t) => t.family === "mask").flatMap((t) => t.turns).filter((t) => t.status === "ok");
    if (!ts.length) continue;
    const intact = ts.filter((t) => t.placeholdersIntact).length, recoverable = ts.filter((t) => t.placeholdersRecoverable).length;
    const ex = (k) => [...new Set(ts.flatMap((t) => t[k] ?? []))].slice(0, 6);
    const sum = (k) => ts.reduce((a, t) => a + (t.failureKinds?.[k] ?? 0), 0);
    rows.push({ model: `${label(r)}`, turns: ts.length, intact, recoverable, kinds: { case: sum("case"), typo: sum("typo"), dropped: sum("dropped"), invented: sum("invented") }, editDone: ts.filter((t) => t.editDone).length, lost: ex("lost"), mangled: ex("mangled"), invented: ex("invented") });
  }
  return rows;
}

function markdown(run, prev) {
  const L = [];
  L.push(`# Free-model benchmark — ${run.at}`, "", `seed \`${run.seed}\` · n=${run.n} chains/family · ${run.turns} turns/chain · K=${run.K} worlds · ${run.callsMade} calls in ${(run.wallMs / 60000).toFixed(1)} min`, "");
  if (run.host?.contended) L.push(`> ⚠ host was contended (${run.host.why.join("; ")}): timeouts and local latencies in this run are suspect.`, "");
  L.push("Sealed: only opaque symbols (`order`) or masked placeholders (`mask`) were sent; every outbound request was audited first. Each reply is judged by an exact local check.", "");
  L.push(`Bar (fixed before measuring): WORTH_IT = answers ≥${100 * BAR.worthIt.availability}% of calls, ≥${100 * BAR.worthIt.accuracyOfAnswered}% of answers exact, p50 ≤${BAR.worthIt.p50TotalMs / 1000}s, p95 ≤${BAR.worthIt.p95TotalMs / 1000}s. MARGINAL = ≥${100 * BAR.marginal.availability}% / ≥${100 * BAR.marginal.accuracyOfAnswered}%.`, "");
  L.push("```", table(run.results), "```", "");
  for (const r of run.results) L.push(`- **${label(r)}** — ${r.summary.verdict.grade}: ${r.summary.verdict.reasons.join("; ")}`);
  const mf = maskFidelity(run.results);
  if (mf.length) { L.push("", "## Placeholder fidelity (mask family)", "", "| model | turns | byte-for-byte | recoverable | edit done | case | typo | dropped | invented |", "|---|---|---|---|---|---|---|---|---|"); for (const m of mf) L.push(`| ${m.model} | ${m.turns} | ${m.intact}/${m.turns} | ${m.recoverable}/${m.turns} | ${m.editDone}/${m.turns} | ${m.kinds.case} | ${m.kinds.typo} | ${m.kinds.dropped} | ${m.kinds.invented} |`); }
  L.push("", "## What each heimdall serves", "");
  for (const c of run.coverage ?? []) L.push(c.error ? `- ${c.bridge}: unreadable (${c.error})` : `- ${c.bridge}: ${c.models} models — ${c.frontier} free/sealed lanes (${c.frontierProviders.join(", ") || "none"}), local: ${c.local.join(", ") || "none"}`);
  for (const n of run.notes) L.push(`- ${n}`);
  if (prev) {
    const was = new Map(prev.results.map((r) => [`${label(r)}`, r.summary.verdict.grade]));
    const ch = run.results.map((r) => [`${label(r)}`, was.get(`${label(r)}`), r.summary.verdict.grade]).filter(([, a, b]) => a && a !== b);
    L.push("", `## Changed since ${prev.at}`, "", ...(ch.length ? ch.map(([m, a, b]) => `- ${m}: ${a} → ${b}`) : ["- nothing changed grade"]));
  }
  return L.join("\n") + "\n";
}

// ───────────────────────── main ─────────────────────────

const t0 = Date.now();
log(`free-bench  seed=${SEED}  n=${N}/family  families=${FAMILIES.join(",")}  turns=${TURNS}  K=${K}  budget=${MAX_CALLS} calls / ${arg("--max-minutes", 25)} min`);
const host = await hostView();
log(`host: ${host.cpus} cpus, load ${host.load1}, CPU ${host.cpuIdlePct ?? "?"}% idle, ${host.memFreePct ?? "?"}% memory free, ollama resident: ${(host.ollamaResident ?? []).join(", ") || "none/unknown"}${host.contended ? "  ⚠ CONTENDED: " + host.why.join("; ") + " — local timings and timeouts are suspect" : ""}`);
const { list, notes, coverage, bridges, deadByPolicy } = await candidates();
log(`\n${list.length} candidate models (${[...new Set(list.map((c) => c.kind))].join(", ")}):`);
// providers in parallel; models of one provider also in parallel (pacing is per model), local models serialized by the lock
const results = await Promise.all(list.map((c, i) => sleep(i * 300).then(() => runModel(c))));
const run = { at: new Date().toISOString(), seed: SEED, n: N, turns: TURNS, K, families: FAMILIES, bar: BAR, callsMade: calls, wallMs: Date.now() - t0, host, notes, coverage, deadByPolicy, results };

log("\n" + table(results));
const mf = maskFidelity(results);
if (mf.length) { log("\nplaceholder fidelity (mask family):"); for (const m of mf) log(`  ${m.model.padEnd(52)} byte-exact ${m.intact}/${m.turns}  recoverable ${m.recoverable}/${m.turns}  edit ${m.editDone}/${m.turns}  case ${m.kinds.case} typo ${m.kinds.typo} dropped ${m.kinds.dropped} invented ${m.kinds.invented}`); }
log("\nwhat each heimdall serves:"); for (const c of run.coverage) log(c.error ? `  ${c.bridge}: unreadable (${c.error})` : `  ${c.bridge}: ${c.models} models, ${c.frontier} free/sealed lanes (${c.frontierProviders.join(", ") || "none"}), local: ${c.local.join(", ") || "none"}`);
for (const n of notes) log("note:", n);

if (RECORD) {
  fs.mkdirSync(OUT, { recursive: true });
  let prev = null; try { prev = JSON.parse(fs.readFileSync(path.join(OUT, "latest.json"), "utf8")); } catch {}
  const stamp = run.at.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(OUT, `run-${stamp}.json`), JSON.stringify(run, null, 1));
  fs.writeFileSync(path.join(OUT, "latest.json"), JSON.stringify(run, null, 1));
  fs.writeFileSync(path.join(OUT, "LATEST.md"), markdown(run, prev));
  const hist = results.map((r) => JSON.stringify({ at: run.at, seed: run.seed, provider: r.provider, model: r.model, grade: r.summary.verdict.grade, alive: r.probe.ok, hostContended: run.host.contended, probeStatus: r.probe.status, availability: r.summary.availability, accuracyOfAnswered: r.summary.accuracyOfAnswered, p50TotalMs: r.summary.p50TotalMs, p50TtftMs: r.summary.p50TtftMs, msPerAccepted: r.summary.msPerAccepted, failures: r.summary.failures })).join("\n") + "\n";
  fs.appendFileSync(path.join(OUT, "history.ndjson"), hist);
  if (prev) { const was = new Map(prev.results.map((r) => [`${label(r)}`, r.summary.verdict.grade])); for (const r of results) { const a = was.get(`${label(r)}`); if (a && a !== r.summary.verdict.grade) log(`CHANGED  ${label(r)}  ${a} → ${r.summary.verdict.grade}`); } }
  log(`\nwrote ${path.relative(process.cwd(), OUT)}/LATEST.md (+ run-${stamp}.json, history.ndjson)`);
}
