// bridge-ladder.test.mjs — the degradation ladder: when a higher rung of
// runOnGiver breaks before the first token, the request STEPS DOWN to the
// next rung that can serve the model and the work continues, just not as
// well — and the drop lands in the dispatch ledger with the lane that
// ACTUALLY served.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createBridge } from "./bridge-server.mjs";

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

/** A fake upstream Ollama: answers /api/chat with one NDJSON chunk. */
function fakeUpstream(text = "upstream-ok") {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let model = "x";
      try { model = JSON.parse(raw || "{}").model ?? "x"; } catch {}
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ model, message: { role: "assistant", content: text }, done: true, done_reason: "stop" }) + "\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** A fake linked native app: serves an Ollama wire that answers `text`. */
function fakeLink(text = "native-ok") {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { role: "assistant", content: text }, done: true, done_reason: "stop" }) + "\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("ladder: a broken frontier falls to upstream and the drop is counted", async () => {
  const up = await fakeUpstream();
  const failing = async () => { throw new Error("provider down"); };
  const linksFile = join(tmpdir(), "bridge-ladder-hosts-" + Date.now() + ".json");
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: up.base, frontierExecutors: [frontierExecutor], frontierFetch: failing, linksFile });
  const addr = await bridge.listen();
  try {
    const base = `http://127.0.0.1:${addr.port}`;
    const r = await post(base, "/api/chat", { model: "gpt-oss-120b", heimdall_privacy: "sealed-external", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /upstream-ok/, "upstream served after the frontier broke");
    assert.equal(bridge.stats.fellThrough, 1, "the drop is counted once");
    assert.equal(bridge.stats.passthrough, 1);
    assert.equal(bridge.stats.frontier, 0, "a failed frontier is never counted as served");
    const ledger = await (await fetch(base + "/api/ledger")).json();
    assert.equal(ledger.entries.length, 0, "nothing inside the ladder served — upstream is unledgered (deterministic/local)");
  } finally {
    await bridge.close();
    up.server.close();
  }
});

test("ladder: a working frontier serves and reports its own lane", async () => {
  const up = await fakeUpstream();
  const seen = [];
  const ff = async (url, opts) => {
    seen.push(url);
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: "sealed-ok" } }] })}\n\ndata: [DONE]\n\n`;
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
  };
  const linksFile = join(tmpdir(), "bridge-ladder-hosts-" + Date.now() + ".json");
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: up.base, frontierExecutors: [frontierExecutor], frontierFetch: ff, linksFile });
  const addr = await bridge.listen();
  try {
    const base = `http://127.0.0.1:${addr.port}`;
    const r = await post(base, "/api/chat", { model: "gpt-oss-120b", heimdall_privacy: "sealed-external", messages: [{ role: "user", content: "Q?" }] });
    assert.equal(r.status, 200);
    const final = (await r.text()).trim().split("\n").pop();
    assert.equal(JSON.parse(final).heimdall, "frontier", "the answer says which lane actually served");
    assert.equal(bridge.stats.frontier, 1);
    assert.equal(bridge.stats.fellThrough, 0, "no drop when the best rung works");
    const ledger = await (await fetch(base + "/api/ledger")).json();
    assert.equal(ledger.entries[0]._lane, "frontier");
    assert.equal(ledger.entries[0].reason, "frontier");
  } finally {
    await bridge.close();
    up.server.close();
  }
});

test("ladder: a broken frontier steps down to a linked native app and the ledger shows the drop", async () => {
  const up = await fakeUpstream();
  const link = await fakeLink("native-ok");
  const failing = async () => { throw new Error("provider down"); };
  const linksFile = join(tmpdir(), "bridge-ladder-hosts-" + Date.now() + ".json");
  writeFileSync(linksFile, JSON.stringify({ links: [{ name: "phone-app", url: link.base, kind: "ollama", model: "gpt-oss-120b", tag: "gpt-oss-120b", models: ["gpt-oss-120b"] }] }));
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: up.base, frontierExecutors: [frontierExecutor], frontierFetch: failing, linksFile });
  const addr = await bridge.listen();
  try {
    const base = `http://127.0.0.1:${addr.port}`;
    const r = await post(base, "/api/chat", { model: "gpt-oss-120b", heimdall_privacy: "sealed-external", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /native-ok/, "the native link served after the frontier broke");
    assert.equal(bridge.stats.fellThrough, 1, "the step-down is counted once");
    assert.equal(bridge.stats.native, 1);
    assert.equal(bridge.stats.frontier, 0);
    assert.equal(bridge.stats.passthrough, 0, "upstream was never reached — a lower rung held");
    const ledger = await (await fetch(base + "/api/ledger")).json();
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].reason, "fell-through", "the record names the drop");
    assert.equal(ledger.entries[0]._lane, "native", "the record names what ACTUALLY served");
    assert.equal(ledger.entries[0].selected, "gpt-oss-120b");
  } finally {
    await bridge.close();
    up.server.close();
    link.server.close();
  }
});

test("ladder: a broken linked host steps down to the fleet, then to upstream", async () => {
  const up = await fakeUpstream();
  const linksFile = join(tmpdir(), "bridge-ladder-hosts-" + Date.now() + ".json");
  writeFileSync(linksFile, JSON.stringify({ links: [{ name: "dead-app", url: "http://127.0.0.1:1", kind: "ollama", model: "gemma2:2b", tag: "gemma2:2b", models: ["gemma2:2b"] }] }));
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: tmpdir(), upstream: up.base, linksFile });
  const addr = await bridge.listen();
  try {
    const base = `http://127.0.0.1:${addr.port}`;
    const r = await post(base, "/api/chat", { model: "gemma2:2b", messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /upstream-ok/, "upstream held after native and fleet both failed");
    assert.equal(bridge.stats.fellThrough, 1, "one drop for the request, not one per rung");
    assert.equal(bridge.stats.passthrough, 1);
    assert.equal(bridge.stats.native, 0);
  } finally {
    await bridge.close();
    up.server.close();
  }
});