// tokens.test.mjs — tokens used and saved, and cancelling a call really stops the provider.
// Stubbed providers and FAKE keys only.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tokenLedger, REFERENCE_FRONTIER } from "./dispatch.js";
import { createBridge } from "./bridge-server.mjs";
import { endpointFor } from "./providers.js";
import { chatOpenAI } from "./remote.js";

const entry = (selected, lane, i, o, extra = {}) => ({ selected, _lane: lane, reason: "frontier", actual: { inputTokens: i, outputTokens: o, exact: true }, ...extra });
const price = (m, lane) => (/^deepinfra:/.test(m) ? { usdInPerM: 0.03, usdOutPerM: 0.05 } : lane === "frontier" ? { usdInPerM: 3, usdOutPerM: 15 } : { usdInPerM: 0, usdOutPerM: 0 });

test("tokenLedger: used is exact per model, local is apart, saved is what the reference frontier would have cost minus what it cost", () => {
  const entries = [
    entry("deepinfra:google/gemma-2-9b-it", "open remote", 1000, 200),
    entry("deepinfra:google/gemma-2-9b-it", "open remote", 3000, 400),
    entry("claude-haiku-4-5", "frontier", 500, 100),
    entry("gemma2:2b", "deterministic/local", 800, 300),
    { selected: "x", _lane: "open remote", reason: "rung-failed", actual: null },
    { selected: "deepinfra:google/gemma-2-9b-it", _lane: "open remote", reason: "cancelled", actual: { inputTokens: 0, outputTokens: 0 } },
  ];
  const t = tokenLedger(entries, { price });
  assert.equal(t.cancelled, 1, "a cancelled call is counted apart and its tokens are in no total");
  assert.deepEqual([t.used.input, t.used.output], [4500, 700], "hosted + frontier, not the local one, not the failed or cancelled ones");
  assert.deepEqual(t.local, { input: 800, output: 300, calls: 1 });
  const di = t.used.byModel.find((r) => r.model.startsWith("deepinfra"));
  assert.deepEqual([di.calls, di.input, di.output], [2, 4000, 600]);
  assert.equal(di.usd, (4000 * 0.03 + 600 * 0.05) / 1e6, "cost at the stated price");
  // saved: hosted (4000 in, 600 out) and local (800 in, 300 out) at sonnet-5 $3/$15, minus the hosted cost; haiku (frontier) saves nothing
  const ref = (i, o) => (i * REFERENCE_FRONTIER.usdInPerM + o * REFERENCE_FRONTIER.usdOutPerM) / 1e6;
  const expected = ref(4000, 600) - (4000 * 0.03 + 600 * 0.05) / 1e6 + ref(800, 300);
  assert.ok(Math.abs(t.saved.usd - expected) < 1e-6, `${t.saved.usd} vs ${expected}`);
  assert.equal(t.saved.tokens, 4600 + 1100);
  assert.equal(t.saved.calls, 3);
  assert.equal(t.exact, 1);
  assert.match(t.saved.versus, /claude-sonnet-5/);
});

test("tokenLedger: an empty or all-frontier ledger saves nothing and divides by nothing", () => {
  const none = tokenLedger([], { price });
  assert.deepEqual([none.saved.tokens, none.saved.usd, none.exact], [0, 0, null]);
  const fr = tokenLedger([entry("claude-haiku-4-5", "frontier", 100, 50)], { price });
  assert.deepEqual([fr.saved.tokens, fr.saved.usd], [0, 0]);
});

/* ---------------- over the wire ---------------- */

const CHAT = { "deepinfra.test": "https://api.deepinfra.com/v1/openai/chat/completions", "openrouter.test": "https://openrouter.ai/api/v1/chat/completions" };
const exec = (provider, model) => ({ executor: `${provider}:${model}`, endpoint: endpointFor(provider).base, model, provider, location: "external", authClass: "api_key", privacyClass: "sealed-only", live: { reachable: true }, auth: { kind: "api_key", apiKey: provider + "-FAKE" } });
const sse = (chunks) => new ReadableStream({ start(c) { for (const j of chunks) c.enqueue(new TextEncoder().encode("data: " + JSON.stringify(j) + "\n\n")); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } });

/** A provider that honours the abort signal like a real HTTP client would, and reports usage when asked. */
function provider({ delays }) {
  const seen = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const host = new URL(url).host;
    const entry = { host, body, aborted: false, finished: false };
    seen.push(entry);
    const ms = delays[host] ?? 10;
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); entry.aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
    });
    entry.finished = true;
    const usage = body.stream_options?.include_usage ? { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } : null;
    return { ok: true, status: 200, body: sse([{ choices: [{ delta: { content: "hello " + host } }] }, ...(usage ? [{ choices: [], usage }] : [])]) };
  };
  fn.seen = seen;
  return fn;
}

async function withBridge(execs, frontierFetch, fn) {
  const dir = mkdtempSync(join(tmpdir(), "tokens-"));
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: "http://127.0.0.1:1", frontierExecutors: execs, frontierFetch, linksFile: join(dir, "h.json"), stateFile: join(dir, "s.json"), auditFile: join(dir, "l.ndjson") });
  const addr = await bridge.listen();
  try { await fn(`http://127.0.0.1:${addr.port}`); } finally { await bridge.close(); }
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const msgs = [{ role: "user", content: "hi" }];

test("hosted providers are asked to report usage, and the meter then shows EXACT tokens used and saved", async () => {
  const ff = provider({ delays: {} });
  await withBridge([exec("deepinfra", "google/gemma-2-9b-it")], ff, async (base) => {
    const r = await post(base, "/v1/chat/completions", { model: "deepinfra:google/gemma-2-9b-it", heimdall_privacy: "sealed-external", messages: msgs });
    assert.equal(r.status, 200);
    assert.equal(ff.seen[0].body.stream_options?.include_usage, true, "usage was requested");
    const m = await (await fetch(base + "/api/meter")).json();
    assert.deepEqual([m.tokens.used.input, m.tokens.used.output], [120, 30], "the provider's own counts");
    assert.equal(m.tokens.exact, 1);
    assert.equal(m.tokens.used.byModel[0].model, "deepinfra:google/gemma-2-9b-it");
    assert.ok(m.tokens.used.usd > 0 && m.tokens.used.usd < 0.001, "cents, not dollars: " + m.tokens.used.usd);
    assert.equal(m.tokens.saved.tokens, 150);
    assert.ok(m.tokens.saved.usd > 0.0005, "versus the reference frontier: " + m.tokens.saved.usd);
    assert.equal(m.counts["open remote"], 1);
    assert.equal(m.counts.frontier, 0);
  });
});

test("chatOpenAI: the caller's abort stops the call, is not a timeout, and says so", async () => {
  const ac = new AbortController();
  const ff = provider({ delays: { "api.deepinfra.com": 500 } });
  const p = chatOpenAI({ base: "https://api.deepinfra.com/v1/openai", model: "m", key: "k", stream: true, fetchImpl: ff, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(p, (e) => e.aborted === true && e.timedOut === false);
  assert.equal(ff.seen[0].aborted, true, "the request itself was cancelled");
});

test("race first: the losers are CANCELLED at the provider, put on the record as cancelled, and not counted as tokens", async () => {
  const ff = provider({ delays: { "api.deepinfra.com": 20, "openrouter.ai": 800 } });
  await withBridge([exec("deepinfra", "google/gemma-2-9b-it"), exec("openrouter", "google/gemma-2-9b-it")], ff, async (base) => {
    const r = await post(base, "/api/race", { messages: msgs, heimdall_privacy: "sealed-external" });
    const j = await r.json();
    assert.equal(j.winner.provider, "deepinfra");
    await new Promise((res) => setTimeout(res, 60));
    const loser = ff.seen.find((s) => s.host === "openrouter.ai");
    assert.equal(loser.aborted, true, "the slow provider call was cancelled");
    assert.equal(loser.finished, false);
    const m = await (await fetch(base + "/api/meter")).json();
    assert.equal(m.tokens.cancelled, 1);
    assert.deepEqual([m.tokens.used.input, m.tokens.used.output], [120, 30], "only the winner's tokens");
    const f = await (await fetch(base + "/api/frontier")).json();
    assert.ok(f.providers.every((p) => !p.down), "a cancelled lane is not benched");
    assert.ok(f.providers.every((p) => p.inflight === 0), "slots are released");
  });
});

test("a client that hangs up cancels the provider call behind /v1/chat/completions", async () => {
  const ff = provider({ delays: { "api.deepinfra.com": 1500 } });
  await withBridge([exec("deepinfra", "google/gemma-2-9b-it")], ff, async (base) => {
    const ac = new AbortController();
    const req = fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal, body: JSON.stringify({ model: "deepinfra:google/gemma-2-9b-it", heimdall_privacy: "sealed-external", stream: true, messages: msgs }) }).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    const hungUp = ff.seen.filter((s) => s.aborted);
    assert.ok(hungUp.length >= 1, "the provider call behind the closed connection was cancelled");
    await req;
  });
});
