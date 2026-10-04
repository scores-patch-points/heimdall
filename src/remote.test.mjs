// remote.test.mjs — the remote-lane client: wires, timing, and capacity signals.
import test from "node:test";
import assert from "node:assert/strict";
import { chatOpenAI, chatOllama, inferOn } from "./remote.js";

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