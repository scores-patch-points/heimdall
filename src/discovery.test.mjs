// discovery.test.mjs — the boot sequence and the separate assays.
import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverEndpoint, probeInferenceAuth, assayEndpoint, discoverLocalhost,
  discoverProviders, discoverConfigured, discoverPuter, discoverAll, LOCALHOST_PROBES,
  discoverKeylessExternal, keylessExternalProviders,
} from "./discovery.js";
import { isReachable } from "./executors.js";

/** A fake fetch that answers by URL — tests the assay separation without a wire. */
function fakeFetch(routes) {
  const fn = async (url, opts = {}) => {
    const key = `${opts.method || "GET"} ${url}`;
    const hit = routes[key] || routes[url] || routes[opts.method || "GET"];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.status >= 200 && hit.status < 300, status: hit.status, json: async () => hit.json ?? {} };
  };
  fn._routes = routes;
  return fn;
}

test("discoverEndpoint: the models list is a DISCOVERY assay, nothing more", async () => {
  const ff = fakeFetch({
    "GET http://127.0.0.1:11434/api/tags": { status: 200, json: { models: [{ name: "gemma2:2b" }] } },
  });
  const d = await discoverEndpoint({ base: "http://127.0.0.1:11434", kind: "ollama", fetchImpl: ff });
  assert.equal(d.ok, true);
  assert.deepEqual(d.models, ["gemma2:2b"]);
  assert.equal(d.discoveryKeyless, true);
});

test("LocalAI .well-known is discovered anonymously even when it is the same port", async () => {
  const ff = fakeFetch({
    "GET http://127.0.0.1:8080/.well-known/localai.json": { status: 200, json: { version: "v2", models: [{ id: "qwen2.5:7b" }] } },
  });
  const d = await discoverEndpoint({ base: "http://127.0.0.1:8080", kind: "localai", fetchImpl: ff });
  assert.equal(d.ok, true);
  assert.equal(d.localai, true);
  assert.deepEqual(d.models, ["qwen2.5:7b"]);
});

test("AUTH PROBE is a separate assay: 401/403 means inference needs a key", async () => {
  const ff = fakeFetch({
    "POST http://127.0.0.1:8080/v1/chat/completions": { status: 401 },
  });
  const a = await probeInferenceAuth({ url: "http://127.0.0.1:8080", kind: "openai", fetchImpl: ff });
  assert.equal(a.keyless, false);
  assert.equal(a.tested, true);
});

test("AUTH PROBE: 200 means inference is keyless", async () => {
  const ff = fakeFetch({
    "POST http://127.0.0.1:8080/v1/chat/completions": { status: 200, json: { choices: [] } },
  });
  const a = await probeInferenceAuth({ url: "http://127.0.0.1:8080", kind: "openai", fetchImpl: ff });
  assert.equal(a.keyless, true);
});

test("AUTH PROBE: 404 means reached inference without a key (refused on the model)", async () => {
  const ff = fakeFetch({
    "POST http://127.0.0.1:11434/api/chat": { status: 404 },
  });
  const a = await probeInferenceAuth({ url: "http://127.0.0.1:11434", kind: "ollama", fetchImpl: ff });
  assert.equal(a.keyless, true);
  assert.equal(a.tested, true);
});

test("AUTH PROBE: a timeout is unknown, never a conviction", async () => {
  const ff = async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const a = await probeInferenceAuth({ url: "http://127.0.0.1:11434", kind: "ollama", fetchImpl: ff });
  assert.equal(a.keyless, null);
  assert.equal(a.tested, false);
});

test("AUTH PROBE: 429 is unknown, never a conviction", async () => {
  const ff = fakeFetch({
    "POST http://127.0.0.1:8080/v1/chat/completions": { status: 429 },
  });
  const a = await probeInferenceAuth({ url: "http://127.0.0.1:8080", kind: "openai", fetchImpl: ff });
  assert.equal(a.keyless, null);
  assert.equal(a.tested, false);
});

test("THE TRAP END TO END: keyless discovery + keyed inference = discovery_only, not an executor", async () => {
  // Pollinations-like: /v1/models anonymous, /v1/chat/completions 401.
  const ff = fakeFetch({
    "GET http://gen.example/v1/models": { status: 200, json: { data: [{ id: "openai/gpt-4o-mini" }] } },
    "POST http://gen.example/v1/chat/completions": { status: 401 },
  });
  const rec = await assayEndpoint({ provider: "pollinations", base: "http://gen.example", kind: "openai", location: "external" }, { fetchImpl: ff });
  assert.ok(rec);
  assert.equal(rec.authClass, "discovery_only");
  assert.equal(rec.auth.discoveryKeyless, true);
  assert.equal(rec.auth.inferenceKeyless, false);
  assert.equal(isReachable(rec), true, "discovered, reachable — but not an executor");
});

test("a genuinely keyless local server is local_open and reachable", async () => {
  const ff = fakeFetch({
    "GET http://127.0.0.1:1234/v1/models": { status: 200, json: { data: [{ id: "qwen2.5-7b" }] } },
    "POST http://127.0.0.1:1234/v1/chat/completions": { status: 200, json: { choices: [{ message: { content: "hi" } }] } },
  });
  const rec = await assayEndpoint({ provider: "lmstudio", base: "http://127.0.0.1:1234", kind: "openai", location: "local/LAN" }, { fetchImpl: ff });
  assert.equal(rec.authClass, "local_open");
  assert.equal(rec.auth.inferenceKeyless, true);
  assert.equal(rec.live.reachable, true);
  assert.equal(rec.privacyClass, "local-raw");
});

test("a configured provider with a key probes models and stays api_key", async () => {
  const ff = fakeFetch({
    "GET https://api.groq.com/openai/v1/models": { status: 200, json: { data: [{ id: "gpt-oss-120b" }] } },
    "POST https://api.groq.com/openai/v1/chat/completions": { status: 200, json: { choices: [] } },
  });
  const recs = await discoverProviders({ groq: { key: "sk-test" } }, { fetchImpl: ff });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].provider, "groq");
  assert.equal(recs[0].authClass, "api_key");
  assert.ok(recs[0].models.includes("gpt-oss-120b"));
});

test("named provider models register each as its own sealed frontier executor", async () => {
  // No `/v1/models` route is provided at all — the named list is the truth.
  const named = { anthropic: { key: "sk-ant-test", models: ["claude-sonnet-4-6", "claude-haiku-4-5"] } };
  const recs = await discoverProviders(named, { fetchImpl: fakeFetch({}) });
  assert.equal(recs.length, 2, "one executor per named model");
  const ids = recs.map((r) => r.executor).sort();
  assert.deepEqual(ids, ["anthropic:claude-haiku-4-5", "anthropic:claude-sonnet-4-6"]);
  for (const r of recs) {
    assert.equal(r.provider, "anthropic");
    assert.equal(r.location, "external");
    assert.equal(r.privacyClass, "sealed-only");
    assert.equal(r.authClass, "api_key");
    assert.equal(r.endpoint, "https://api.anthropic.com/v1");
    assert.equal(isReachable(r), true, "a named model is a real executor");
  }
});

test("a provider that discovers but lists no models falls back to its catalog claims", async () => {
  const ff = fakeFetch({
    "GET https://api.groq.com/openai/v1/models": { status: 200, json: { data: [] } },
  });
  const recs = await discoverProviders({ groq: { key: "sk-test" } }, { fetchImpl: ff });
  // Groq's catalog seeds free-tier claims; an empty live list does not erase
  // them (a claim stands until measured), and each claim becomes an executor.
  assert.ok(recs.length >= 1);
  assert.equal(recs[0].provider, "groq");
  assert.equal(isReachable(recs[0]), true);
  assert.ok(recs.map((r) => r.model).includes("gpt-oss-120b"));
});

test("a provider with no discovery and no seeded models is not an executor", async () => {
  // Anthropic seeds no models and its discovery shape is not a data list.
  const ff = fakeFetch({
    "GET https://api.anthropic.com/v1/models": { status: 200, json: { data: [] } },
  });
  const recs = await discoverProviders({ anthropic: { key: "sk-ant-test" } }, { fetchImpl: ff });
  assert.equal(recs.length, 1);
  assert.ok(!recs[0].model, "no model to infer on");
  assert.equal(isReachable(recs[0]), false);
});

test("a provider with no key configured is skipped entirely", async () => {
  const recs = await discoverProviders({ anthropic: { models: ["claude-sonnet-4-6"] } }, { fetchImpl: fakeFetch({}) });
  assert.equal(recs.length, 0, "a named model without a key is never an executor");
});

test("configured LAN endpoints are assayed, never assumed keyless", async () => {
  const ff = fakeFetch({
    "GET http://192.168.1.50:8080/v1/models": { status: 200, json: { data: [{ id: "llama-3.2-3b" }] } },
    "POST http://192.168.1.50:8080/v1/chat/completions": { status: 403 },
  });
  const recs = await discoverConfigured([{ provider: "llamacpp", base: "http://192.168.1.50:8080", kind: "openai" }], { fetchImpl: ff });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].authClass, "discovery_only", "discovered but inference 403 → not an executor");
});

test("discoverPuter: no session, no record; a signed-in session yields user_pays", async () => {
  assert.equal(await discoverPuter({ puter: null }), null);
  const rec = await discoverPuter({
    puter: { auth: { isSignedIn: true }, ai: { getModels: async () => [{ id: "gpt-4o" }, { id: "qwen/qwen-2.5-72b" }] } },
  });
  assert.ok(rec);
  assert.equal(rec.authClass, "user_pays");
  assert.equal(rec.provider, "puter");
  assert.equal(rec.location, "external");
  assert.equal(rec.privacyClass, "sealed-only");
  assert.equal(rec.auth.developerKey, false);
});

test("discoverAll in a browser declares in-process lanes and probes localhost", async () => {
  const ff = fakeFetch({}); // nothing on localhost answers
  const recs = await discoverAll({ config: { providers: {} }, browser: true }, { fetchImpl: ff });
  const inProcess = recs.filter((r) => r.authClass === "in_process");
  assert.equal(inProcess.length, 2);
  assert.ok(inProcess.every((r) => r.location === "local"));
});

test("the localhost probe set is the declared boot list", () => {
  const ports = LOCALHOST_PROBES.map((p) => p.base);
  assert.ok(ports.includes("http://127.0.0.1:11434")); // Ollama
  assert.ok(ports.includes("http://127.0.0.1:1234")); // LM Studio
  assert.ok(ports.includes("http://127.0.0.1:8080")); // llama.cpp / LocalAI
  assert.ok(ports.includes("http://127.0.0.1:8000")); // vLLM
});

test("the keyless external lane is exactly the keyless+external catalog entries", () => {
  const names = keylessExternalProviders().map((p) => p.provider).sort();
  assert.deepEqual(names, ["llm7", "ovh", "pollinations"]);
});

test("discoverKeylessExternal: a keyless endpoint that infers yields executors, no key", async () => {
  const ff = fakeFetch({
    "GET https://api.llm7.io/v1/models": { status: 200, json: { data: [{ id: "turbo" }] } },
    "POST https://api.llm7.io/v1/chat/completions": { status: 200, json: { choices: [] } },
  });
  const recs = await discoverKeylessExternal({ fetchImpl: ff, only: ["llm7"] });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].executor, "llm7:turbo");
  assert.equal(recs[0].location, "external");
  assert.equal(recs[0].privacyClass, "sealed-only");
  assert.equal(recs[0].live.reachable, true);
});

test("discoverKeylessExternal: a keyless endpoint that demands a key after all is dropped", async () => {
  const ff = fakeFetch({
    "GET https://api.llm7.io/v1/models": { status: 200, json: { data: [{ id: "turbo" }] } },
    "POST https://api.llm7.io/v1/chat/completions": { status: 401 },
  });
  const recs = await discoverKeylessExternal({ fetchImpl: ff, only: ["llm7"] });
  assert.equal(recs.length, 0, "401 means it is not actually keyless; never an executor here");
});

test("discoverAll includes keyless external only when the caller opts in", async () => {
  const ff = fakeFetch({});
  const off = await discoverAll({ config: { providers: {} } }, { fetchImpl: ff });
  assert.equal(off.filter((r) => r.provider === "llm7").length, 0);
  const on = await discoverAll({ config: { providers: {}, keylessExternal: true } }, { fetchImpl: ff });
  // nothing answers in this fake, so no executors — but the lane was attempted
  assert.ok(Array.isArray(on));
});