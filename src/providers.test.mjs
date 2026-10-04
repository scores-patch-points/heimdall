// providers.test.mjs — the self-healing catalog and its live/probe transitions.
import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_CATALOG, makeProviderRecord, isLiveDiscovered, catalogFor, LEGITIMATE_SOURCES, loadProviderKeys } from "./providers.js";

test("the catalog seeds the keyless lanes explicitly", () => {
  const providers = PROVIDER_CATALOG.map((p) => p.provider);
  for (const p of ["webllm", "transformers", "ollama", "llamacpp", "lmstudio", "localai", "heimdall-peer", "puter"]) {
    assert.ok(providers.includes(p), p);
  }
});

test("Puter is user_pays with no developer key", () => {
  const rec = makeProviderRecord("puter");
  assert.equal(rec.authClass, "user_pays");
  assert.equal(rec.browser, true);
});

test("Together is not seeded as free", () => {
  const rec = makeProviderRecord("together");
  assert.equal(rec.cardRequired, true);
  assert.match(rec.note, /not free/);
});

test("OpenRouter and Groq seed with free-tier claims, marked as claims", () => {
  const or = makeProviderRecord("openrouter");
  assert.equal(or.authClass, "api_key");
  assert.equal(or.cardRequired, false);
  assert.ok(or.models.includes("openrouter/free"));
  const g = makeProviderRecord("groq");
  assert.ok(g.models.includes("gpt-oss-120b"));
});

test("a record is not live-discovered until a real probe replaces the claims", () => {
  const rec = makeProviderRecord("groq");
  assert.equal(isLiveDiscovered(rec), false);
  const live = makeProviderRecord("groq", { reachable: true, lastVerified: Date.now() });
  live.models = ["gpt-oss-120b"];
  assert.equal(isLiveDiscovered(live), true);
});

test("legitimate sources are declared; random internet servers are not among them", () => {
  const src = LEGITIMATE_SOURCES.join(" ");
  assert.match(src, /ours\/user machine/);
  assert.match(src, /user-authorized LAN/);
  assert.match(src, /heimdall peers/);
  assert.doesNotMatch(src, /port 8080 answered somewhere/);
});

test("unknown providers return null", () => {
  assert.equal(catalogFor("totally-made-up"), null);
  assert.equal(makeProviderRecord("totally-made-up"), null);
});

test("loadProviderKeys merges env HEIMDALL_KEY_* and stored state, lowercased", () => {
  const env = { HEIMDALL_KEY_GROQ: "sk-g", HEIMDALL_KEY_OPENROUTER: "sk-or", HOME: "/x", NOPE: "n" };
  const state = { providerKeys: { anthropic: "sk-a" } };
  const providers = loadProviderKeys({ env, state });
  assert.deepEqual(providers, {
    groq: { key: "sk-g" },
    openrouter: { key: "sk-or" },
    anthropic: { key: "sk-a" },
  });
});

test("loadProviderKeys is empty with nothing configured", () => {
  assert.deepEqual(loadProviderKeys({ env: { HOME: "/x" }, state: {} }), {});
});