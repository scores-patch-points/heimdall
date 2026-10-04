// remote.test.mjs — the remote-lane client: wires, timing, and capacity signals.
import test from "node:test";
import assert from "node:assert/strict";
import { chatOpenAI, chatOllama, chatAnthropic, inferOn } from "./remote.js";

/** Fake fetch with a controllable SSE stream for OpenAI wire. */
function sseFetch({ status = 200, chunks = [], body = null, failWith = null } = {}) {
  const makeBody = () => {
    if (body) return { ok: true, status, body };
    const data = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data + "data: [DONE]\n\n"));
        controller.close();
      },
    });
    return { ok: true, status, body: stream };
  };
  const fn = async () => (failWith ? Promise.reject(new Error(failWith)) : makeBody());
  fn._failWith = failWith;
  return fn;
}

test("chatOpenAI streams tokens and measures TTFT and tokens/sec", async () => {
  const ff = sseFetch({ status: 200, chunks: ["Hel", "lo"] });
  const seen = [];
  const out = await chatOpenAI({
    base: "https://api.groq.com/openai/v1",
    model: "gpt-oss-120b",
    messages: [{ role: "user", content: "hi" }],
    onToken: (t) => seen.push(t),
    fetchImpl: ff,
  });
  assert.equal(out.text, "Hello");
  assert.equal(seen.join(""), "Hello");
  assert.equal(out.status, 200);
  assert.ok(out.ttft >= 0);
  assert.ok(out.ms >= 0);
});

test("chatOpenAI: 429 is a capacity signal, returned not thrown", async () => {
  const ff = async () => ({ ok: false, status: 429 });
  const out = await chatOpenAI({ base: "https://x/v1", model: "m", fetchImpl: ff });
  assert.equal(out.status, 429);
  assert.equal(out.note, "rate-limited");
});

test("chatOpenAI: 5xx is a capacity signal too", async () => {
  const ff = async () => ({ ok: false, status: 503 });
  const out = await chatOpenAI({ base: "https://x/v1", model: "m", fetchImpl: ff });
  assert.equal(out.status, 503);
});

test("chatOpenAI: a timed-out lane throws with timedOut true, tokens 0", async () => {
  const ff = async () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  await assert.rejects(
    () => chatOpenAI({ base: "https://x/v1", model: "m", fetchImpl: ff }),
    (e) => e.timedOut === true && e.beforeFirstToken === true,
  );
});

test("chatOllama parses NDJSON and streams", async () => {
  const lines = [
    JSON.stringify({ message: { content: "Hi" } }),
    JSON.stringify({ message: { content: " there" } }),
    JSON.stringify({ done: true }),
  ].join("\n");
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close(); } });
  const ff = async () => ({ ok: true, status: 200, body });
  const seen = [];
  const out = await chatOllama({ base: "http://127.0.0.1:11434", model: "gemma2:2b", messages: [], onToken: (t) => seen.push(t), fetchImpl: ff });
  assert.equal(out.text, "Hi there");
  assert.equal(seen.join(""), "Hi there");
});

test("inferOn: an api_key lane without a key refuses, it does not guess", async () => {
  const exec = {
    provider: "groq",
    authClass: "api_key",
    auth: { kind: "api_key", inferenceKeyless: false },
    endpoint: "https://api.groq.com/openai/v1",
    model: "gpt-oss-120b",
  };
  await assert.rejects(() => inferOn(exec, { fetchImpl: sseFetch() }), (e) => e.status === 401);
});

test("inferOn: a keyless local lane sends the call with no credential", async () => {
  let sawAuth = null;
  const ff = async (url, opts) => {
    sawAuth = opts.headers?.authorization ?? null;
    return sseFetch({ status: 200, chunks: ["ok"] })(url, opts);
  };
  const exec = {
    provider: "lmstudio",
    authClass: "local_open",
    auth: { kind: "local_open", inferenceKeyless: true },
    endpoint: "http://127.0.0.1:1234",
    model: "qwen2.5-7b",
  };
  const out = await inferOn(exec, { fetchImpl: ff });
  assert.equal(out.text, "ok");
  assert.equal(sawAuth, null, "no credential was sent");
});

test("chatAnthropic: speaks the /v1/messages wire with x-api-key, system top-level", async () => {
  let captured = null;
  const ff = async (url, opts) => {
    captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { c.close(); } }),
      json: async () => ({ content: [{ type: "text", text: "sealed" }], usage: { output_tokens: 6 } }),
    };
  };
  const out = await chatAnthropic({
    base: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    key: "sk-ant-test",
    messages: [{ role: "system", content: "reason over the opaque structure" }, { role: "user", content: "Q?" }],
    stream: false,
    fetchImpl: ff,
  });
  assert.equal(out.text, "sealed");
  assert.equal(out.tokens, 6);
  assert.match(captured.url, /\/v1\/messages$/);
  assert.equal(captured.headers["x-api-key"], "sk-ant-test");
  assert.equal(captured.headers["anthropic-version"], "2023-06-01");
  assert.equal(captured.body.system, "reason over the opaque structure");
  assert.equal(captured.body.messages.length, 1);
  assert.equal(captured.body.messages[0].role, "user");
});

test("chatAnthropic: streaming parses content_block_delta events", async () => {
  const events = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { content: [] } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
  const ff = async () => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events)); c.close(); } }) });
  const seen = [];
  const out = await chatAnthropic({ base: "https://api.anthropic.com/v1", model: "m", key: "k", messages: [{ role: "user", content: "hi" }], onToken: (t) => seen.push(t), fetchImpl: ff });
  assert.equal(out.text, "AB");
  assert.equal(seen.join(""), "AB");
  assert.equal(out.status, 200);
});

test("inferOn: provider anthropic sends on the Anthropic wire with its key", async () => {
  let captured = null;
  const ff = async (url, opts) => {
    captured = { url, headers: opts.headers };
    const data = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
  };
  const exec = {
    provider: "anthropic",
    authClass: "api_key",
    auth: { kind: "api_key", apiKey: "sk-ant-xyz" },
    endpoint: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
  };
  const out = await inferOn(exec, { messages: [{ role: "user", content: "hi" }], fetchImpl: ff });
  assert.equal(out.text, "x");
  assert.match(captured.url, /\/v1\/messages$/);
  assert.equal(captured.headers["x-api-key"], "sk-ant-xyz");
});