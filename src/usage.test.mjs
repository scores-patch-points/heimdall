// usage.test.mjs — exact token usage, from the provider, through the wire, the ledger and the response.
// A context benchmark is only as honest as its token counts: these are the provider's own, never an estimate.
import test from "node:test";
import assert from "node:assert/strict";
import { chatAnthropic, chatOpenAI, normUsage } from "./remote.js";
import { createBridge } from "./bridge-server.mjs";

const sse = (events) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join("") + "data: [DONE]\n\n")); c.close(); } }) });
const anthropicStream = (text, usage) => sse([
  { type: "message_start", message: { usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheCreation, output_tokens: 1 } } },
  { type: "content_block_delta", delta: { text } },
  { type: "message_delta", usage: { output_tokens: usage.output } },
]);

test("normUsage reads Anthropic and OpenAI shapes and says null when there is nothing", () => {
  assert.deepEqual(normUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 3 }), { input: 10, output: 5, cacheRead: 90, cacheCreation: 3 });
  assert.deepEqual(normUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } }), { input: 100, output: 7, cacheRead: 40, cacheCreation: null });
  assert.equal(normUsage(null), null); assert.equal(normUsage({}), null);
});

test("chatAnthropic returns the provider's EXACT usage from the stream: input side from message_start, final output from message_delta", async () => {
  const out = await chatAnthropic({ base: "https://a.test", model: "m", key: "k", messages: [{ role: "user", content: "hi" }], fetchImpl: async () => anthropicStream("ok", { input: 12, cacheRead: 3000, cacheCreation: 200, output: 41 }) });
  assert.equal(out.text, "ok");
  assert.deepEqual(out.usage, { input: 12, cacheRead: 3000, cacheCreation: 200, output: 41 });
});

test("chatOpenAI picks up a usage chunk when the provider sends one, and reports null when it does not", async () => {
  const withU = await chatOpenAI({ base: "https://o.test", model: "m", messages: [{ role: "user", content: "x" }], fetchImpl: async () => sse([{ choices: [{ delta: { content: "a" } }] }, { choices: [], usage: { prompt_tokens: 55, completion_tokens: 2 } }]) });
  assert.deepEqual(withU.usage, { input: 55, output: 2, cacheRead: null, cacheCreation: null });
  const without = await chatOpenAI({ base: "https://o.test", model: "m", messages: [{ role: "user", content: "x" }], fetchImpl: async () => sse([{ choices: [{ delta: { content: "a" } }] }]) });
  assert.equal(without.usage, null, "no usage is null — never a guess");
});

function anthropicExecutor() {
  return { executor: "anthropic:m", endpoint: "https://api.anthropic.test/v1", model: "m", provider: "anthropic", location: "external", authClass: "api_key", privacyClass: "sealed-only", auth: { kind: "api_key", apiKey: "sk-ant-SECRET" }, live: { reachable: true, inflight: 0, queue: 0 }, advertised: { tools: false, structured: false }, cost: { kind: "provider", freeLocal: false } };
}
async function withBridge(t) {
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: "http://127.0.0.1:1", frontierExecutors: [anthropicExecutor()], frontierFetch: async () => anthropicStream("done", { input: 20, cacheRead: 5000, cacheCreation: 100, output: 33 }), auditFile: null });
  await bridge.listen(); t.after(() => bridge.close());
  return "http://127.0.0.1:" + bridge.server.address().port;
}
const chat = (base, stream, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "m", heimdall_privacy: "sealed-external", stream, messages: [{ role: "user", content: "hi" }] }) });

test("the bridge's response carries the exact usage (prompt = fresh + cache read + cache write), marked exact", async (t) => {
  const base = await withBridge(t);
  const j = await (await chat(base, false)).json();
  assert.equal(j.usage.prompt_tokens, 5120); assert.equal(j.usage.completion_tokens, 33); assert.equal(j.usage.total_tokens, 5153);
  assert.equal(j.usage.prompt_tokens_details.cached_tokens, 5000); assert.equal(j.usage.prompt_tokens_details.fresh_tokens, 20);
  assert.equal(j.usage.exact, true);
});

test("a streamed response ends with a usage chunk before [DONE]", async (t) => {
  const base = await withBridge(t);
  const text = await (await chat(base, true)).text();
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]")).map((l) => JSON.parse(l.slice(6)));
  const u = chunks.find((c) => c.usage)?.usage;
  assert.equal(u.prompt_tokens, 5120); assert.equal(u.completion_tokens, 33);
});

test("the outbound ledger records the usage against the request that made it — and never the key", async (t) => {
  const base = await withBridge(t);
  await chat(base, false, { "x-fold-audit": "bench-1" });
  const audit = await (await fetch(base + "/api/audit?auditId=bench-1")).json();
  assert.equal(audit.entries.length, 1);
  assert.deepEqual(audit.entries[0].response.usage, { input: 20, cacheRead: 5000, cacheCreation: 100, output: 33 });
  assert.ok(!JSON.stringify(audit).includes("sk-ant-SECRET"));
});
