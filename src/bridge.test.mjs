// bridge.test.mjs — the remote-model lane through the real bridge: discovery
// records handed to createBridge become sealed-only frontier executors. A
// request must pass the privacy gate (heimdall_privacy:"sealed-external") or
// it is refused; with the gate it rides the remote.js wire and lands a
// dispatch entry (stats.frontier counts it).
import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./bridge-server.mjs";

/** Fake OpenAI SSE stream, captured per call. */
function sseFetch(log) {
  const fn = async (url, opts) => {
    log.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const data = "data: " + JSON.stringify({ choices: [{ delta: { content: "sealed answer" } }] }) + "\n\ndata: [DONE]\n\n";
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }),
    };
  };
  return fn;
}

function frontierExecutor() {
  return {
    executor: "groq:gpt-oss-120b",
    endpoint: "https://api.groq.com/openai/v1",
    model: "gpt-oss-120b",
    provider: "groq",
    location: "external",
    authClass: "api_key",
    privacyClass: "sealed-only",
    auth: { kind: "api_key", apiKey: "sk-test" },
    live: { reachable: true, inflight: 0, queue: 0 },
    advertised: { tools: false, structured: false },
    cost: { kind: "provider", freeLocal: false },
  };
}

async function withBridge(t, fn) {
  const calls = [];
  const bridge = createBridge({
    port: 0,
    host: "127.0.0.1",
    dist: null,
    upstream: "http://127.0.0.1:11434",
    passthrough: true,
    autoOpen: false,
    frontierExecutors: [frontierExecutor()],
    frontierFetch: sseFetch(calls),
  });
  await bridge.listen();
  t.after(() => bridge.close());
  return { bridge, calls, base: "http://127.0.0.1:" + bridge.server.address().port };
}

test("frontier model without the sealed gate is refused", async (t) => {
  const { bridge, base } = await withBridge(t);
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error.message, /sealed-only/);
  assert.equal(bridge.stats.frontierRefused, 1);
  assert.equal(bridge.stats.frontier, 0, "refused, never called");
});

test("frontier model with heimdall_privacy sealed-external is served on the remote wire", async (t) => {
  const { bridge, calls, base } = await withBridge(t);
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "summarize the projection" }],
      heimdall_privacy: "sealed-external",
      max_tokens: 64,
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.choices[0].message.content, "sealed answer");
  // One streamed SSE delta ("sealed answer") is measured as 1 completion token —
  // the honest chunk count, not a guess at what the model would have tokenized.
  assert.equal(j.usage.completion_tokens, 1);
  assert.equal(bridge.stats.frontier, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-test");
  assert.equal(calls[0].body.model, "gpt-oss-120b");
});

test("a pinned local model is untouched by the frontier lane", async (t) => {
  const { bridge, calls, base } = await withBridge(t);
  // No controller tab and no link: the fleet cannot take it, so it falls
  // through to upstream — but NEVER to the frontier lane (different model).
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemma2:2b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(calls.length, 0, "frontier wire never saw a local model");
  assert.ok(r.status === 502 || r.status === 200, "fleet/upstream path, not frontier");
});