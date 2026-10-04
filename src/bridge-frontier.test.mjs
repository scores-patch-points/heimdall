// bridge-frontier.test.mjs — the bridge's sealed frontier lane:
// keys live on the heimdall machine; a request reaches a frontier model ONLY
// when the body carries the Fold's privacy mode (heimdall_privacy:
// "sealed-external" or "explicit"); every dispatch lands in the ledger/meter.
import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./bridge-server.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fake frontier upstream: captures the request, streams an OpenAI-style SSE reply. */
function fakeUpstream({ key = null } = {}) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "sealed-ok" } }] })}\n\ndata: [DONE]\n\n`;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }),
    };
  };
  fn.seen = seen;
  fn.key = key;
  return fn;
}

const frontierExecutor = {
  executor: "groq:gpt-oss-120b",
  endpoint: "https://api.groq.com/openai/v1",
  model: "gpt-oss-120b",
  provider: "groq",
  location: "external",
  authClass: "api_key",
  privacyClass: "sealed-only",
  live: { reachable: true },
  auth: { kind: "api_key", apiKey: "gsk-test" },
};

async function withBridge(fn) {
  const ff = fakeUpstream();
  const linksFile = join(tmpdir(), "bridge-frontier-test-hosts-" + Date.now() + ".json");
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: "http://127.0.0.1:1", frontierExecutors: [frontierExecutor], frontierFetch: ff, linksFile });
  const addr = await bridge.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base, ff);
  } finally {
    await bridge.close();
  }
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("bridge: /v1/models lists the configured frontier model as sealed-only", async () => {
  await withBridge(async (base) => {
    const j = await (await fetch(base + "/v1/models")).json();
    const m = j.data.find((x) => x.id.includes("gpt-oss-120b"));
    assert.ok(m, "frontier model is advertised");
    assert.match(m.owned_by, /heimdall-frontier/);
  });
});

test("bridge: /api/frontier reports configured providers without any key", async () => {
  await withBridge(async (base) => {
    const j = await (await fetch(base + "/api/frontier")).json();
    assert.equal(j.configured, true);
    assert.equal(j.providers[0].provider, "groq");
    assert.match(JSON.stringify(j), /sealed-external/);
    assert.ok(!JSON.stringify(j).includes("gsk-test"), "no key is ever exposed");
  });
});

test("bridge: a frontier model refuses a request without a sealed privacy mode", async () => {
  await withBridge(async (base, ff) => {
    const r = await post(base, "/v1/chat/completions", { model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error.message, /sealed-external/);
    assert.equal(ff.seen.length, 0, "nothing reached the provider");
  });
});

test("bridge: a sealed-external request routes to the frontier executor with its key", async () => {
  await withBridge(async (base, ff) => {
    const r = await post(base, "/v1/chat/completions", {
      model: "gpt-oss-120b",
      heimdall_privacy: "sealed-external",
      messages: [{ role: "user", content: "Q?" }],
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.choices[0].message.content, "sealed-ok");
    assert.equal(ff.seen.length, 1);
    assert.equal(ff.seen[0].headers.authorization, "Bearer gsk-test");
    assert.match(ff.seen[0].url, /\/v1\/chat\/completions$/);
  });
});

test("bridge: explicit mode is allowed (conscious disclosure), local-raw is refused", async () => {
  await withBridge(async (base, ff) => {
    const ok = await post(base, "/v1/chat/completions", { model: "gpt-oss-120b", heimdall_privacy: "explicit", messages: [{ role: "user", content: "hi" }] });
    assert.equal(ok.status, 200);
    const bad = await post(base, "/v1/chat/completions", { model: "gpt-oss-120b", heimdall_privacy: "local-raw", messages: [{ role: "user", content: "hi" }] });
    assert.equal(bad.status, 400);
  });
});

test("bridge: the meter records the frontier dispatch as exact external tokens", async () => {
  await withBridge(async (base) => {
    await post(base, "/v1/chat/completions", { model: "gpt-oss-120b", heimdall_privacy: "sealed-external", messages: [{ role: "user", content: "Q?" }] });
    const m = await (await fetch(base + "/api/meter")).json();
    assert.ok(m.externalTokens > 0, "external tokens are measured, not guessed");
    assert.ok(m.counts.frontier >= 1, "the frontier lane is counted");
    assert.match(m.estimated.note, /externalTokens is exact/);
  });
});

test("bridge: /v1/messages (Anthropic wire) serves a frontier model under a sealed mode", async () => {
  const anthro = { ...frontierExecutor, executor: "anthropic:claude-x", provider: "anthropic", model: "claude-x", auth: { kind: "api_key", apiKey: "sk-ant-t" } };
  const seen = [];
  const ff = async (url, opts) => {
    seen.push({ url, headers: opts.headers });
    const data = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "sealed-ok" } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
  };
  const linksFile = join(tmpdir(), "bridge-frontier-test-hosts-" + Date.now() + ".json");
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: "http://127.0.0.1:1", frontierExecutors: [anthro], frontierFetch: ff, linksFile });
  const addr = await bridge.listen();
  try {
    const base = `http://127.0.0.1:${addr.port}`;
    const r = await post(base, "/v1/messages", { model: "anthropic:claude-x", heimdall_privacy: "sealed-external", system: "seal first", messages: [{ role: "user", content: "Q?" }] });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.type, "message");
    assert.equal(j.content[0].text, "sealed-ok");
    assert.equal(seen[0].headers["x-api-key"], "sk-ant-t");
    assert.match(seen[0].url, /\/v1\/messages$/);
  } finally {
    await bridge.close();
  }
});