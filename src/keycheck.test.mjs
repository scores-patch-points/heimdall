// keycheck.test.mjs — what a person sees when they add an API key.
// FAKE keys and STUB providers only: nothing here touches a real provider or a real bridge.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { maskKey, redactKey, checkProviderKey, keyReport, addProviderKey, listAnthropicModels, nextSteps, unlockLines, verifiedModelsToRegister } from "./keycheck.js";
import { keyCommand, pingBridge } from "./key-cli.js";
import { discoverProviders } from "./discovery.js";

const KEY = "sk-ant-api03-FAKEFAKEFAKE-abcd";
const TAIL = "••••abcd";

/** A response-shaped object. */
const res = (status, body = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] ?? null } });
/** A stub Anthropic: `verdict` answers POST /messages; the model list answers GET /models. */
function anthropicStub({ verdict = () => res(200, { content: [] }), models = ["claude-sonnet-4-6", "claude-haiku-4-5"], seen = [] } = {}) {
  const f = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
    if (/\/models/.test(url)) return res(200, { data: models.map((id) => ({ id })) });
    return verdict(JSON.parse(opts.body || "{}"));
  };
  f.seen = seen;
  return f;
}
const everything = (x) => JSON.stringify(x);

test("maskKey: only provider-side tail ••••abcd; short keys show no tail; never the whole key", () => {
  assert.equal(maskKey(KEY), TAIL);
  assert.equal(maskKey("  " + KEY + "\n"), TAIL, "whitespace around a pasted key is ignored");
  assert.equal(maskKey("short-key"), "••••", "a short key shows no tail at all");
  assert.equal(maskKey(""), "");
  assert.ok(!maskKey(KEY).includes("FAKE"));
});

test("redactKey: the key is scrubbed out of any text a provider sends back", () => {
  const out = redactKey(`invalid x-api-key: ${KEY} (and again ${KEY})`, KEY);
  assert.ok(!out.includes(KEY) && !out.includes("FAKEFAKE"));
  assert.ok(out.includes(TAIL));
});

test("check: a working Anthropic key reports 'works', sends a ONE-token message, and uses x-api-key", async () => {
  const f = anthropicStub();
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: f });
  assert.equal(c.status, "works");
  assert.equal(c.label, "works");
  const post = f.seen.find((s) => s.method === "POST");
  assert.match(post.url, /\/messages$/);
  assert.equal(JSON.parse(post.body).max_tokens, 1, "a one-token check, not a real generation");
  assert.equal(post.headers["x-api-key"], KEY);
  assert.ok(c.models.includes("claude-haiku-4-5"));
  assert.ok(!everything(c).includes(KEY), "the key is not in the result");
});

test("check: a 401 is 'rejected (wrong or expired key)' and NOT works", async () => {
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(401, { error: { message: `invalid x-api-key ${KEY}` } }) }) });
  assert.equal(c.status, "rejected");
  assert.equal(c.label, "rejected (wrong or expired key)");
  assert.equal(c.http, 401);
  assert.match(c.reason, /not valid/);
  assert.ok(!everything(c).includes(KEY));
});

test("check: a key not shaped like an Anthropic key gets a hint, still rejected", async () => {
  const c = await checkProviderKey("anthropic", "totally-wrong-key-1234", { fetchImpl: anthropicStub({ verdict: () => res(401, {}) }) });
  assert.equal(c.status, "rejected");
  assert.match(c.reason, /sk-ant-/);
});

test("check: 403 is rejected with a different reason (permissions, not a typo)", async () => {
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(403, { error: { message: "forbidden" } }) }) });
  assert.equal(c.status, "rejected");
  assert.match(c.reason, /will not let it/);
});

test("check: 429 is 'rate limited' (the key is probably fine), with the wait it asked for", async () => {
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(429, {}, { "retry-after": "30" }) }) });
  assert.equal(c.status, "rate_limited");
  assert.equal(c.label, "rate limited");
  assert.match(c.reason, /30 seconds/);
});

test("check: no credit left is its own plain answer, not 'works' and not 'rejected'", async () => {
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } }) }) });
  assert.equal(c.status, "no_credit");
  assert.match(c.reason, /no credit/);
});

test("check: a network failure is 'no network', never 'rejected' and never 'works'", async () => {
  const f = async () => { throw new TypeError("fetch failed: ENOTFOUND api.anthropic.com"); };
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: f });
  assert.equal(c.status, "no_network");
  assert.match(c.reason, /could not reach/);
  assert.match(c.reason, /not the key/);
});

test("check: a timeout is 'no network' with the wait named", async () => {
  const f = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: f, timeoutMs: 3000 });
  assert.equal(c.status, "no_network");
  assert.match(c.reason, /3 seconds/);
});

test("check: a 5xx is the provider's problem, not the key's", async () => {
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(529, { error: { message: "Overloaded" } }) }) });
  assert.equal(c.status, "provider_error");
  assert.match(c.reason, /their side/);
});

test("check: an unknown test model (404) falls back to a model the key can see and re-tests", async () => {
  let first = true;
  const f = anthropicStub({ verdict: (b) => { if (first) { first = false; return res(404, { error: { message: "model not found" } }); } return res(200, {}); } });
  const c = await checkProviderKey("anthropic", KEY, { fetchImpl: f });
  assert.equal(c.status, "works");
  assert.equal(c.model, "claude-sonnet-4-6", "the retry used a listed model");
});

test("check: an OpenAI-style provider is tested with its model list; 401 is rejected", async () => {
  const ok = await checkProviderKey("openai", "sk-FAKE-openai-key-wxyz", { fetchImpl: async (u, o) => { assert.match(String(u), /\/models$/); assert.equal(o.headers.authorization, "Bearer sk-FAKE-openai-key-wxyz"); return res(200, { data: [{ id: "gpt-x" }] }); } });
  assert.equal(ok.status, "works");
  assert.deepEqual(ok.models, ["gpt-x"]);
  const bad = await checkProviderKey("openai", "sk-FAKE-openai-key-wxyz", { fetchImpl: async () => res(401, { error: { message: "Incorrect API key provided: sk-FAKE-openai-key-wxyz" } }) });
  assert.equal(bad.status, "rejected");
  assert.ok(!everything(bad).includes("sk-FAKE-openai-key-wxyz"));
});

test("report: a rejected key says rejected and NOT SAVED, says what to do, and never contains the key", async () => {
  const check = await checkProviderKey("anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(401, {}) }) });
  const r = keyReport({ provider: "anthropic", key: KEY, check, saved: false });
  assert.equal(r.ok, false);
  assert.equal(r.tone, "bad");
  assert.match(r.headline, /Anthropic rejected this key/);
  assert.match(r.headline, /NOT saved/);
  assert.match(r.text, /Received, but not stored/);
  assert.match(r.text, /console\.anthropic\.com\/settings\/keys/);
  assert.match(r.text, /rejected \(wrong or expired key\)/);
  assert.ok(!/Unlocked|now use/.test(r.text), "a rejected key unlocks nothing");
  assert.ok(!r.text.includes(KEY) && !r.text.includes("FAKEFAKE"));
  assert.ok(r.text.includes(TAIL));
});

test("report: a working key shows the masked tail, the live check, what it unlocks, and what stays private", () => {
  const r = keyReport({ provider: "anthropic", key: KEY, check: { status: "works", label: "works", reason: "Anthropic accepted the key and answered a one-word test with claude-haiku-4-5." }, saved: true, models: ["claude-sonnet-4-6", "claude-haiku-4-5"], heimdall: "ready" });
  assert.equal(r.ok, true);
  assert.equal(r.headline, `Anthropic key works (${TAIL})`);
  assert.match(r.text, /Received and stored: your Anthropic key .*abcd, kept on this computer only/);
  assert.match(r.text, /Live check: works\./);
  assert.match(r.text, /Unlocked: claude-sonnet-4-6, claude-haiku-4-5/);
  assert.match(r.text, /online help can now use them/);
  assert.match(r.text, /Stays private: your files and workspace never leave this computer/);
  assert.ok(!r.text.includes(KEY) && !r.text.includes("FAKEFAKE"));
});

test("report: every failure kind gets a next step in the words of the surface", () => {
  for (const status of ["rejected", "no_credit", "rate_limited", "no_network", "provider_error"]) {
    const cli = nextSteps("anthropic", { status }, { surface: "cli" });
    const app = nextSteps("anthropic", { status }, { surface: "app" });
    assert.ok(cli.length >= 1 && app.length >= 1, status);
  }
  assert.match(nextSteps("anthropic", { status: "no_network" }, { surface: "app" })[0], /Test again/);
  assert.match(nextSteps("anthropic", { status: "no_network" }, { surface: "cli" })[0], /heimdall key anthropic/);
  assert.deepEqual(nextSteps("anthropic", { status: "works" }), []);
});

test("report: no network is saved-but-unconfirmed and switches nothing on", () => {
  const r = keyReport({ provider: "anthropic", key: KEY, check: { status: "no_network", label: "no network", reason: "This computer could not reach Anthropic." }, saved: true });
  assert.match(r.headline, /Saved, but could not be tested: no network/);
  assert.match(r.text, /Nothing is switched on yet/);
  assert.equal(r.tone, "warn");
});

test("report: when no heimdall is running or it is older, the unlock lines say so plainly", () => {
  assert.match(unlockLines("anthropic", { models: ["claude-haiku-4-5"], heimdall: "not_running" })[0], /not running right now.*heimdall up/);
  assert.match(unlockLines("anthropic", { models: ["claude-haiku-4-5"], heimdall: "older" })[0], /started before this key was saved and could not reload it.*heimdall up.*nothing is lost/);
});

test("add: a rejected key changes nothing, and never replaces a key that already works", async () => {
  const state = { providerKeys: { anthropic: "sk-ant-GOOD-OLD-KEY-0000" }, providerModels: { anthropic: ["claude-haiku-4-5"] } };
  const before = JSON.stringify(state);
  const out = await addProviderKey(state, "anthropic", KEY, { fetchImpl: anthropicStub({ verdict: () => res(401, {}) }) });
  assert.equal(out.saved, false);
  assert.equal(out.check.status, "rejected");
  assert.equal(JSON.stringify(state), before, "state is untouched");
});

test("add: a working key is stored, and the models the live check proved are registered so it unlocks lanes", async () => {
  const state = {};
  const out = await addProviderKey(state, "anthropic", KEY, { fetchImpl: anthropicStub() });
  assert.equal(out.saved, true);
  assert.equal(state.providerKeys.anthropic, KEY);
  assert.ok(state.providerModels.anthropic.includes("claude-haiku-4-5"));
  assert.deepEqual(out.registered, state.providerModels.anthropic);
});

test("add: models the person named are kept, not overwritten by the live check", async () => {
  const state = {};
  const out = await addProviderKey(state, "anthropic", KEY, { named: ["claude-sonnet-4-6"], fetchImpl: anthropicStub() });
  assert.deepEqual(state.providerModels.anthropic, ["claude-sonnet-4-6"]);
  assert.deepEqual(out.registered, []);
});

test("add: with no network the key is still saved (it could not be judged), and no model is invented", async () => {
  const state = {};
  const out = await addProviderKey(state, "anthropic", KEY, { fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(out.saved, true);
  assert.equal(out.check.status, "no_network");
  assert.equal(state.providerModels.anthropic, undefined);
});

test("verifiedModelsToRegister: only Anthropic, only when it worked, only when none were named", () => {
  assert.deepEqual(verifiedModelsToRegister("anthropic", { status: "works", model: "a", models: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(verifiedModelsToRegister("anthropic", { status: "rejected", model: "a" }), []);
  assert.deepEqual(verifiedModelsToRegister("anthropic", { status: "works", model: "a" }, ["mine"]), []);
  assert.deepEqual(verifiedModelsToRegister("openai", { status: "works", model: "a" }), []);
});

/* ------------------------------------------------------------ the CLI */

/** A fetch that stands in for BOTH the provider and a running bridge; records every URL it is asked for. */
function world({ provider = anthropicStub(), bridge = "ready", loaded = ["claude-sonnet-4-6", "claude-haiku-4-5"] } = {}) {
  const urls = [];
  const f = async (url, opts) => {
    urls.push(String(url));
    if (/127\.0\.0\.1:\d+\/api\/providers\/refresh/.test(url)) {
      if (bridge === "down") throw new TypeError("fetch failed: ECONNREFUSED");
      if (bridge === "older") return res(404, { error: "not found" });
      return res(200, { ok: true, models: loaded.length, providers: { anthropic: loaded } });
    }
    if (/127\.0\.0\.1:\d+\/api\/providers\/keys/.test(url)) return res(200, { providers: [{ provider: "anthropic", set: true, masked: TAIL, loaded: bridge === "ready" }] });
    if (/api\.anthropic\.com/.test(url)) return provider(url, opts);
    throw new Error("unexpected network call to " + url);
  };
  f.urls = urls;
  return f;
}
const run = async (args, state, fetchImpl) => { let saved = 0; const r = await keyCommand({ args: ["key", ...args], state, save: () => { saved++; }, fetchImpl, port: 8790 }); return { ...r, saved, text: r.lines.join("\n") }; };

test("cli: adding a working key to a RUNNING bridge says it picked it up and how many models", async () => {
  const f = world();
  const r = await run(["anthropic", KEY], {}, f);
  assert.equal(r.code, 0);
  assert.equal(r.saved, 1);
  assert.match(r.text, /Anthropic key works/);
  assert.match(r.text, /Your running bridge picked it up: 2 Anthropic models now available/);
  assert.match(r.text, /Unlocked: claude-sonnet-4-6, claude-haiku-4-5/);
  assert.ok(!r.text.includes(KEY) && !r.text.includes("FAKEFAKE"), "the key is never printed");
  assert.ok(r.text.includes(TAIL));
});

test("cli: a bridge that started before the key (no reload route) gets the plain restart message", async () => {
  const r = await run(["anthropic", KEY], {}, world({ bridge: "older" }));
  assert.equal(r.saved, 1, "the key is saved either way");
  assert.match(r.text, /started before this key was saved and could not reload it/);
  assert.match(r.text, /heimdall up/);
  assert.match(r.text, /nothing is lost/);
  assert.ok(!/picked it up/.test(r.text));
});

test("cli: no bridge running says start it; the key is saved", async () => {
  const r = await run(["anthropic", KEY], {}, world({ bridge: "down" }));
  assert.match(r.text, /heimdall is not running right now.*heimdall up/);
  assert.equal(r.saved, 1);
});

test("cli: a rejected key exits 1, saves nothing, never pings the bridge, and tells you what to do", async () => {
  const f = world({ provider: anthropicStub({ verdict: () => res(401, {}) }) });
  const state = { providerKeys: { anthropic: "sk-ant-OLD-OLD-OLD-9999" } };
  const r = await run(["anthropic", KEY], state, f);
  assert.equal(r.code, 1);
  assert.equal(r.saved, 0);
  assert.equal(state.providerKeys.anthropic, "sk-ant-OLD-OLD-OLD-9999");
  assert.match(r.text, /rejected \(wrong or expired key\)/);
  assert.match(r.text, /NOT saved/);
  assert.match(r.text, /Get a fresh key/);
  assert.ok(!f.urls.some((u) => /127\.0\.0\.1/.test(u)), "no reason to wake the bridge for a bad key");
  assert.ok(!r.text.includes(KEY) && !r.text.includes("sk-ant-OLD"));
});

test("cli: no network saves the key and says it could not be tested", async () => {
  const f = async (url) => { if (/127\.0\.0\.1/.test(url)) throw new Error("down"); throw new TypeError("fetch failed"); };
  const r = await run(["anthropic", KEY], {}, f);
  assert.equal(r.code, 0);
  assert.equal(r.saved, 1);
  assert.match(r.text, /no network/);
  assert.match(r.text, /key is saved either way/);
});

test("cli: `heimdall key anthropic` with no key tests the saved one and does not need the key typed", async () => {
  const r = await run(["anthropic"], { providerKeys: { anthropic: KEY } }, world());
  assert.match(r.text, /Tested the Anthropic key stored on this computer/);
  assert.match(r.text, /Anthropic key works/);
  assert.ok(!r.text.includes(KEY));
  const none = await run(["anthropic"], {}, world());
  assert.equal(none.code, 1);
  assert.match(none.text, /No Anthropic key is saved yet/);
});

test("cli: the list shows masked tails and whether the running bridge loaded each key", async () => {
  const r = await run([], { providerKeys: { anthropic: KEY } }, world({ bridge: "ready" }));
  assert.match(r.text, new RegExp("Anthropic\\s+" + TAIL));
  assert.match(r.text, /loaded by the running heimdall/);
  assert.ok(!r.text.includes(KEY));
  const r2 = await run([], { providerKeys: { anthropic: KEY } }, world({ bridge: "older" }));
  assert.match(r2.text, /has NOT loaded it/);
});

test("pingBridge: 404 = older, refused connection = not running, 200 = ready with this provider's models", async () => {
  assert.equal((await pingBridge("anthropic", { fetchImpl: async () => res(404) })).state, "older");
  assert.equal((await pingBridge("anthropic", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).state, "not_running");
  const ok = await pingBridge("anthropic", { fetchImpl: async () => res(200, { models: 3, providers: { anthropic: ["a", "b"], openai: ["c"] } }) });
  assert.deepEqual([ok.state, ok.models], ["ready", ["a", "b"]]);
});

test("cli (real process): a fake key against a STUB provider and a closed bridge port — output and state file never hold the key in output", async () => {
  const home = mkdtempSync(join(tmpdir(), "heimdall-keycli-"));
  const hits = [];
  const stub = createServer((q, s) => { hits.push(q.method + " " + q.url); s.setHeader("content-type", "application/json"); if (q.url.startsWith("/v1/models")) return s.end(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] })); s.end(JSON.stringify({ content: [] })); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const closed = createServer(); await new Promise((r) => closed.listen(0, "127.0.0.1", r)); const deadPort = closed.address().port; await new Promise((r) => closed.close(r));
  try {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "heimdall.mjs");
    const p = await new Promise((resolve) => {
      // async spawn: the stub provider lives in THIS process, so the event loop must stay free to answer it
      const c = spawn(process.execPath, [bin, "key", "anthropic", KEY, "--port", String(deadPort)], { env: { ...process.env, HOME: home, HEIMDALL_KEYCHECK_BASE_ANTHROPIC: `http://127.0.0.1:${stub.address().port}/v1` } });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(p.status, 0, p.stderr);
    const out = p.stdout + p.stderr;
    assert.match(out, /Anthropic key works/);
    assert.match(out, /heimdall is not running right now/);
    assert.ok(!out.includes(KEY) && !out.includes("FAKEFAKE"), "the real CLI never prints the key");
    assert.ok(hits.some((h) => h.startsWith("POST /v1/messages")), "the live check really went to the (stub) provider");
    const stateFile = join(home, ".heimdall", "state.json");
    assert.ok(existsSync(stateFile));
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).providerKeys.anthropic, KEY, "stored for the bridge to use");
  } finally { stub.close(); }
});

/* ------------------------------------------------------- discovery */

test("discovery: an Anthropic key with no named models now yields lanes from the live list (it used to yield none)", async () => {
  const probes = [];
  const f = async (url, opts = {}) => {
    if (/\/models/.test(url)) return res(200, { data: [{ id: "claude-sonnet-4-6" }, { id: "claude-haiku-4-5" }] });
    probes.push(JSON.parse(opts.body).model);
    return res(200, {});
  };
  const out = await discoverProviders({ anthropic: { key: KEY } }, { fetchImpl: f });
  assert.deepEqual(out.map((e) => e.model), ["claude-sonnet-4-6", "claude-haiku-4-5"]);
  assert.ok(out.every((e) => e.live.reachable));
});

test("discovery: a provider that cannot be reached is NOT marked reachable (offline is not 'works')", async () => {
  const out = await discoverProviders({ anthropic: { key: KEY, models: ["claude-haiku-4-5"] } }, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(out[0].live.reachable, false);
  assert.match(out[0].live.lastError, /could not reach/);
});

test("discovery: a refused key (401) is not reachable; a throttled one (429) still is", async () => {
  const mk = (status) => discoverProviders({ anthropic: { key: KEY, models: ["claude-haiku-4-5"] } }, { fetchImpl: async () => res(status, {}) });
  assert.equal((await mk(401))[0].live.reachable, false);
  assert.equal((await mk(429))[0].live.reachable, true);
});

test("listAnthropicModels: failure is empty, never a throw", async () => {
  assert.deepEqual(await listAnthropicModels({ key: KEY, fetchImpl: async () => { throw new Error("x"); } }), []);
});
