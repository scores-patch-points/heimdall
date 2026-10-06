// hosted.test.mjs — the small hosted open-model tier: URL join, model choice, key → lanes, tiering, and the parallel race.
// Stubbed providers and FAKE keys only; nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { joinBase } from "./url.js";
import { selectSmallModels, pickHostedModels, hostedHello, paramsB, isHostedOpen, HOSTED_OPEN } from "./hosted.js";
import { addProviderKey, verifiedModelsToRegister } from "./keycheck.js";
import { endpointFor, catalogFor, loadProviderKeys } from "./providers.js";
import { normalizeHello } from "./peers.js";
import { plan, createCompetence } from "./competence.js";
import { createBridge } from "./bridge-server.mjs";

test("joinBase: a /v1 base never doubles, an origin base still gets /v1", () => {
  assert.equal(joinBase("https://openrouter.ai/api/v1", "/v1/chat/completions"), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(joinBase("https://api.together.xyz/v1/", "/v1/models"), "https://api.together.xyz/v1/models");
  assert.equal(joinBase("https://api.llm7.io", "/v1/chat/completions"), "https://api.llm7.io/v1/chat/completions");
  assert.equal(joinBase("https://text.pollinations.ai/openai", "/models"), "https://text.pollinations.ai/openai/models");
  assert.equal(joinBase("https://x.test/v1", "/v1beta/foo"), "https://x.test/v1/v1beta/foo", "only a whole /v1 segment collapses");
  // DeepInfra's OpenAI root is …/v1/openai and Google's is …/v1beta/openai: both already carry the version
  assert.equal(joinBase("https://api.deepinfra.com/v1/openai", "/v1/chat/completions"), "https://api.deepinfra.com/v1/openai/chat/completions");
  assert.equal(joinBase("https://api.deepinfra.com/v1/openai", "/models"), "https://api.deepinfra.com/v1/openai/models");
  assert.equal(joinBase("https://generativelanguage.googleapis.com/v1beta/openai", "/v1/chat/completions"), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(joinBase("https://text.pollinations.ai/openai", "/v1/chat/completions"), "https://text.pollinations.ai/openai/v1/chat/completions", "an unversioned /openai root is left as it was");
});

test("providers: all four hosted providers are catalogued with an OpenAI-wire endpoint", () => {
  for (const p of ["openrouter", "together", "fireworks", "deepinfra"]) {
    assert.ok(isHostedOpen(p), p);
    assert.equal(endpointFor(p).kind, "openai", p);
    assert.ok(endpointFor(p).base.startsWith("https://"), p);
    assert.equal(catalogFor(p).authClass, "api_key", p);
    assert.equal(catalogFor(p).trust, "sealed-only", p);
  }
});

test("paramsB / selectSmallModels: small chat models only, no reasoning, no embeddings, no vision", () => {
  assert.equal(paramsB("google/gemma-2-9b-it"), 9);
  assert.equal(paramsB("meta-llama/llama-3.2-3b-instruct"), 3);
  assert.equal(paramsB("Qwen/Qwen2.5-7B-Instruct-Turbo"), 7);
  assert.equal(paramsB("some-model"), null);
  const listed = [
    "meta-llama/Llama-3.3-70B-Instruct", "google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct", "deepseek-ai/DeepSeek-R1-Distill-Llama-8B",
    "BAAI/bge-large-en-v1.5", "Qwen/Qwen2.5-VL-7B-Instruct", "meta-llama/Llama-Guard-3-8B", "meta-llama/Llama-3.1-8B-Instruct", "no-size-here-instruct",
  ];
  assert.deepEqual(selectSmallModels(listed), ["google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct", "meta-llama/Llama-3.1-8B-Instruct"]);
  assert.deepEqual(selectSmallModels(listed, { max: 1 }), ["google/gemma-2-9b-it"]);
});

test("pickHostedModels: confirmed defaults win; moved ids fall back to what the list shows; unknown list keeps the defaults", () => {
  const d = HOSTED_OPEN.deepinfra.defaultModels;
  assert.deepEqual(pickHostedModels("deepinfra", [d[0], "x/other-70b"]), [d[0]]);
  assert.deepEqual(pickHostedModels("deepinfra", ["google/gemma-3-12b-it", "big/model-405b"]), ["google/gemma-3-12b-it"]);
  assert.deepEqual(pickHostedModels("deepinfra", []), d);
});

test("keycheck: a working hosted key registers a few small models the key's own list confirms (never the whole catalogue)", async () => {
  const many = Array.from({ length: 300 }, (_, i) => `vendor/huge-model-${i}-400b`);
  const listed = [...many, "google/gemma-2-9b-it", "qwen/qwen-2.5-7b-instruct"];
  const fetchImpl = async (url, opts) => {
    assert.equal(url, "https://openrouter.ai/api/v1/models", "no doubled /v1");
    assert.equal(opts.headers.authorization, "Bearer sk-or-FAKE-0000");
    return { status: 200, ok: true, json: async () => ({ data: listed.map((id) => ({ id })) }) };
  };
  const state = {};
  const out = await addProviderKey(state, "openrouter", "sk-or-FAKE-0000", { fetchImpl });
  assert.equal(out.saved, true);
  assert.deepEqual(state.providerModels.openrouter, ["google/gemma-2-9b-it", "qwen/qwen-2.5-7b-instruct"]);
  assert.equal(JSON.stringify(out.check).includes("sk-or-FAKE-0000"), false, "the key is never in the result");
  assert.deepEqual(verifiedModelsToRegister("openrouter", { status: "rejected" }), []);
  assert.deepEqual(verifiedModelsToRegister("openrouter", { status: "works", listed }, ["mine"]), [], "named models are never overridden");
});

test("keycheck: a rejected hosted key is not stored", async () => {
  const fetchImpl = async () => ({ status: 401, ok: false, json: async () => ({ error: { message: "bad key" } }) });
  const state = {};
  const out = await addProviderKey(state, "fireworks", "fw-FAKE-0000", { fetchImpl });
  assert.equal(out.saved, false);
  assert.equal(state.providerKeys?.fireworks, undefined);
});

test("loadProviderKeys carries the registered small models so discovery builds lanes without a model list call", () => {
  const k = loadProviderKeys({ env: {}, state: { providerKeys: { deepinfra: "di-FAKE" }, providerModels: { deepinfra: ["google/gemma-2-9b-it"] } } });
  assert.deepEqual(k.deepinfra, { key: "di-FAKE", models: ["google/gemma-2-9b-it"] });
});

test("dispatch: a hosted tier is remote for privacy, cheaper than frontier, and ranked between remote and frontier on ties", () => {
  const comp = createCompetence();
  const cands = [
    { model: "claude-haiku-4-5", tier: "frontier", usdInPerM: 1, usdOutPerM: 5 },
    { model: "openrouter:gemma", tier: "hosted", usdInPerM: 0.05, usdOutPerM: 0.1 },
  ];
  const p = plan({ taskClass: "chat", ctxTokens: 500, privacy: "sealed-external" }, cands, comp, { rng: () => 1 });
  assert.equal(p.ladder[0].model, "openrouter:gemma", "the cheap hosted lane is tried first");
  const q = plan({ taskClass: "chat", ctxTokens: 500, privacy: "local-only" }, cands, comp);
  assert.equal(q.chosen, null, "a local-only job may use neither");
  assert.equal(q.excluded.length, 2);
});

test("hostedHello: the key-holding lanes read as one sealed peer in the peer layer's own validator (no key in it)", () => {
  const h = hostedHello({ id: "fold-a/hosted", models: ["openrouter:google/gemma-2-9b-it", "deepinfra:google/gemma-2-9b-it"], slots: 8 });
  const n = normalizeHello(h);
  assert.equal(n.ok, true);
  assert.equal(n.hello.privacyClass, "sealed-external");
  assert.deepEqual(n.hello.models.length, 2);
  assert.equal(JSON.stringify(h).toLowerCase().includes("key"), false);
});

/* ---------------- the bridge: tiering, ledger lane, and the parallel race ---------------- */

const hostedExec = (provider, model, key = `${provider}-FAKE`) => ({
  executor: `${provider}:${model}`, endpoint: endpointFor(provider).base, model, provider,
  location: "external", authClass: "api_key", privacyClass: "sealed-only", live: { reachable: true }, auth: { kind: "api_key", apiKey: key },
});

/** The URLs the real providers actually serve (docs, 2026-10). Anything else is a 404, as it would be for real. */
const REAL_CHAT = {
  "openrouter.ai": "https://openrouter.ai/api/v1/chat/completions",
  "api.together.xyz": "https://api.together.xyz/v1/chat/completions",
  "api.fireworks.ai": "https://api.fireworks.ai/inference/v1/chat/completions",
  "api.deepinfra.com": "https://api.deepinfra.com/v1/openai/chat/completions",
};
/** A stub provider fetch: each provider answers after its own delay, or fails. STRICT about the URL. */
function stubFetch(plan) {
  const seen = [];
  const fn = async (url, opts) => {
    const host = new URL(url).host;
    const spec = plan.find((p) => host.includes(p.host));
    seen.push({ url, host, auth: opts.headers?.authorization, body: JSON.parse(opts.body) });
    if (!spec || (REAL_CHAT[host] && url !== REAL_CHAT[host])) return { ok: false, status: 404, json: async () => ({}), text: async () => "no such endpoint" };
    (fn.starts ||= []).push(Date.now());
    await new Promise((r) => setTimeout(r, spec.ms ?? 0));
    (fn.ends ||= []).push(Date.now());
    if (spec.status && spec.status !== 200) return { ok: false, status: spec.status, json: async () => ({ error: { message: "boom" } }), text: async () => "boom" };
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: spec.say } }] })}\n\ndata: [DONE]\n\n`;
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
  };
  fn.seen = seen;
  return fn;
}

async function withBridge(execs, plan, fn, extra = {}) {
  const ff = stubFetch(plan);
  const bridge = createBridge({ ...extra, port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: "http://127.0.0.1:1", frontierExecutors: execs, frontierFetch: ff, linksFile: join(tmpdir(), "hosted-test-hosts-" + Date.now() + Math.random() + ".json"), auditFile: join(mkdtempSync(join(tmpdir(), "hosted-audit-")), "ledger.ndjson") });
  const addr = await bridge.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  try { await fn(base, ff); } finally { await bridge.close(); }
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const msgs = [{ role: "user", content: "hi" }];

test("race: refused without the Fold's privacy mode", async () => {
  await withBridge([hostedExec("deepinfra", "google/gemma-2-9b-it")], [{ host: "deepinfra", say: "x" }], async (base, ff) => {
    const r = await post(base, "/api/race", { messages: msgs });
    assert.equal(r.status, 400);
    assert.equal(ff.seen.length, 0, "nothing left the machine");
  });
});

test("race: mode all hits every hosted provider in parallel, one lane per provider first, with each provider's own key", async () => {
  const execs = [hostedExec("openrouter", "google/gemma-2-9b-it"), hostedExec("together", "Qwen/Qwen2.5-7B-Instruct-Turbo"), hostedExec("deepinfra", "google/gemma-2-9b-it"), hostedExec("deepinfra", "Qwen/Qwen2.5-7B-Instruct")];
  const plan = [{ host: "openrouter", say: "or", ms: 120 }, { host: "together", say: "tg", ms: 120 }, { host: "deepinfra", say: "di", ms: 120 }];
  await withBridge(execs, plan, async (base, ff) => {
    const j = await (await post(base, "/api/race", { messages: msgs, mode: "all", heimdall_privacy: "sealed-external" })).json();
    assert.equal(j.asked, 3);
    assert.deepEqual(j.results.map((r) => r.provider).sort(), ["deepinfra", "openrouter", "together"], "three different providers, not three models of one");
    assert.ok(j.results.every((r) => r.ok), JSON.stringify(j.results));
    assert.ok(Math.max(...ff.starts) < Math.min(...ff.ends), "all three calls were in flight at the same moment (parallel, however loaded the machine is)");
    const byHost = Object.fromEntries(ff.seen.map((s) => [s.host, s.auth]));
    assert.equal(byHost["openrouter.ai"], "Bearer openrouter-FAKE");
    assert.equal(byHost["api.together.xyz"], "Bearer together-FAKE");
    assert.equal(byHost["api.deepinfra.com"], "Bearer deepinfra-FAKE");
    assert.ok(ff.seen.every((s) => !s.url.includes("/v1/v1/")), "no doubled /v1: " + ff.seen.map((s) => s.url).join(" "));
    assert.deepEqual(ff.seen.map((s) => s.url).sort(), [REAL_CHAT["api.deepinfra.com"], REAL_CHAT["api.together.xyz"], REAL_CHAT["openrouter.ai"]].sort(), "each provider was called at the URL it really serves");
  });
});

test("race: mode first returns the first success and does not wait on the slow lane; a failing lane never wins", async () => {
  const execs = [hostedExec("openrouter", "google/gemma-2-9b-it"), hostedExec("together", "meta-llama/Llama-3.2-3B-Instruct-Turbo"), hostedExec("deepinfra", "google/gemma-2-9b-it")];
  const plan = [{ host: "openrouter", say: "slow", ms: 600 }, { host: "together", say: "dead", status: 500, ms: 10 }, { host: "deepinfra", say: "fast", ms: 60 }];
  await withBridge(execs, plan, async (base, ff) => {
    const r = await post(base, "/api/race", { messages: msgs, heimdall_privacy: "explicit" });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.winner.provider, "deepinfra");
    assert.equal(j.winner.text, "fast");
    assert.ok((ff.ends || []).length < 3, "the answer came back while the slow lane was still running");
    assert.ok(j.pending >= 1);
  });
});

test("race: every lane failing is a 502 with each reason; unknown or absent lanes are plain errors", async () => {
  await withBridge([hostedExec("deepinfra", "google/gemma-2-9b-it")], [{ host: "deepinfra", say: "x", status: 500 }], async (base) => {
    const r = await post(base, "/api/race", { messages: msgs, heimdall_privacy: "sealed-external" });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).winner, null);
    const u = await post(base, "/api/race", { messages: msgs, models: ["nope:model"], heimdall_privacy: "sealed-external" });
    assert.equal(u.status, 400);
  });
  await withBridge([], [], async (base) => {
    const r = await post(base, "/api/race", { messages: msgs, heimdall_privacy: "sealed-external" });
    assert.equal(r.status, 404, "no hosted model loaded");
  });
});

test("race: explicit models can name the same model on two providers (hedging) and a hosted call is ledgered as open remote, not frontier", async () => {
  const execs = [hostedExec("openrouter", "google/gemma-2-9b-it"), hostedExec("deepinfra", "google/gemma-2-9b-it")];
  const plan = [{ host: "openrouter", say: "a", ms: 20 }, { host: "deepinfra", say: "b", ms: 20 }];
  await withBridge(execs, plan, async (base) => {
    const j = await (await post(base, "/api/race", { messages: msgs, mode: "all", models: ["openrouter:google/gemma-2-9b-it", "deepinfra:google/gemma-2-9b-it"], heimdall_privacy: "sealed-external" })).json();
    assert.deepEqual(j.results.map((r) => r.model).sort(), ["deepinfra:google/gemma-2-9b-it", "openrouter:google/gemma-2-9b-it"]);
    const meter = await (await fetch(base + "/api/meter")).json();
    assert.equal(meter.counts.frontier, 0, "small hosted open models are not frontier");
    assert.equal(meter.counts["open remote"], 2);
  });
});

/* ---------------- saving several keys in quick succession ---------------- */

test("keys saved at the same moment all end up loaded (an older refresh never overwrites a newer one)", async () => {
  const lists = {
    "openrouter.ai": ["google/gemma-2-9b-it", "qwen/qwen-2.5-7b-instruct"],
    "api.together.xyz": ["Qwen/Qwen2.5-7B-Instruct-Turbo"],
    "api.deepinfra.com": ["google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct"],
  };
  const MODELS = { "openrouter.ai": "https://openrouter.ai/api/v1/models", "api.together.xyz": "https://api.together.xyz/v1/models", "api.deepinfra.com": "https://api.deepinfra.com/v1/openai/models" };
  const frontierFetch = async (url, opts = {}) => {
    const host = new URL(url).host;
    await new Promise((r) => setTimeout(r, host === "openrouter.ai" ? 90 : 10)); // the first provider is the slow one
    if (url === MODELS[host]) return { ok: true, status: 200, json: async () => ({ data: lists[host].map((id) => ({ id })) }) };
    if (url === REAL_CHAT[host]) return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n")); c.close(); } }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "no such endpoint" };
  };
  const dir = mkdtempSync(join(tmpdir(), "hosted-keys-"));
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: "http://127.0.0.1:1", frontierFetch, linksFile: join(dir, "hosts.json"), stateFile: join(dir, "state.json"), auditFile: join(dir, "ledger.ndjson") });
  const addr = await bridge.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const hdr = { "content-type": "application/json", "x-heimdall-token": bridge.token };
  try {
    const save = (provider, key) => fetch(base + "/api/providers/keys", { method: "POST", headers: hdr, body: JSON.stringify({ provider, key }) });
    const rs = await Promise.all([save("openrouter", "sk-or-FAKE-0001"), save("together", "tg-FAKE-0002"), save("deepinfra", "di-FAKE-0003")]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    const j = await (await fetch(base + "/api/providers/keys", { headers: hdr })).json();
    const byName = Object.fromEntries(j.providers.map((p) => [p.provider, p]));
    for (const p of ["openrouter", "together", "deepinfra"]) assert.equal(byName[p]?.loaded, true, `${p} is loaded: ${JSON.stringify(j.providers)}`);
    assert.deepEqual(byName.deepinfra.models, ["google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct"]);
  } finally { await bridge.close(); }
});

test("race: a lane that is full is left out, /api/frontier reports inflight and slots, and when every lane is full the least loaded one still answers", async () => {
  const execs = [hostedExec("openrouter", "google/gemma-2-9b-it"), hostedExec("deepinfra", "google/gemma-2-9b-it")];
  const plan = [{ host: "openrouter", say: "or", ms: 400 }, { host: "deepinfra", say: "di", ms: 20 }];
  await withBridge(execs, plan, async (base, ff) => {
    const body = { messages: msgs, mode: "all", heimdall_privacy: "sealed-external" };
    // hold OpenRouter's single slot with a slow call
    const slow = post(base, "/api/race", { ...body, models: ["openrouter:google/gemma-2-9b-it"] });
    await new Promise((r) => setTimeout(r, 80));
    const f = await (await fetch(base + "/api/frontier")).json();
    const or = f.providers.find((p) => p.model === "openrouter:google/gemma-2-9b-it");
    assert.deepEqual([or.inflight, or.slots], [1, 1]);
    const j = await (await post(base, "/api/race", body)).json();
    assert.deepEqual(j.results.map((r) => r.provider), ["deepinfra"], "the full lane was skipped");
    await (await slow).json();
    const after = await (await fetch(base + "/api/frontier")).json();
    assert.equal(after.providers.find((p) => p.model === "openrouter:google/gemma-2-9b-it").inflight, 0, "the slot is released");
    // both full -> the least loaded one still takes it
    const hold = [post(base, "/api/race", { ...body, models: ["openrouter:google/gemma-2-9b-it"] }), post(base, "/api/race", { ...body, models: ["deepinfra:google/gemma-2-9b-it"] })];
    await new Promise((r) => setTimeout(r, 5));
    const k = await (await post(base, "/api/race", body)).json();
    assert.equal(k.results.length, 1, "one lane, not zero");
    await Promise.all(hold.map(async (h) => (await h).json()));
  }, { laneSlots: { openrouter: 1, deepinfra: 1 } });
});
