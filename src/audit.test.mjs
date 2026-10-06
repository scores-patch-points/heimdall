// audit.test.mjs — the outbound ledger: exactly what left this machine. Pure
// unit tests for audit.js, then the real bridge with a fake outside provider.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLedger, canonMessages, contentSha256, redactHeaders, parseWorlds, whereOf, sha256 } from "./audit.js";
import { createBridge } from "./bridge-server.mjs";

const hex = (s) => createHash("sha256").update(s).digest("hex");

test("sha256 and the canonical message text are stable and order-sensitive", () => {
  assert.equal(sha256("abc"), hex("abc"));
  const a = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
  assert.equal(canonMessages(a), "system\ns\n\u0000\nuser\nu");
  assert.equal(contentSha256(a), hex(canonMessages(a)));
  assert.notEqual(contentSha256(a), contentSha256([...a].reverse()));
});

test("falsifier: credentials never enter an entry — header values are redacted, names kept", () => {
  const r = redactHeaders({ Authorization: "Bearer sk-SECRET", "x-api-key": "k", "content-type": "application/json", Cookie: "a=b" });
  assert.equal(r.authorization, "[redacted]"); assert.equal(r["x-api-key"], "[redacted]"); assert.equal(r.cookie, "[redacted]");
  assert.equal(r["content-type"], "application/json");
  const l = createLedger();
  const h = l.open({ url: "https://api.x.test/v1/chat?key=SECRETQUERY", headers: { Authorization: "Bearer sk-SECRET" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
  const dump = JSON.stringify(h.entry);
  assert.ok(!dump.includes("sk-SECRET"), "no credential in the entry");
  assert.ok(!dump.includes("SECRETQUERY"), "no query string in the entry");
});

test("whereOf keeps host and path only; parseWorlds reads a slot and refuses nonsense", () => {
  assert.deepEqual(whereOf("https://user:pw@api.llm7.io/v1/chat?x=1"), { host: "api.llm7.io", path: "/v1/chat", scheme: "https" });
  assert.deepEqual(parseWorlds("set-7:2/5"), { setId: "set-7", slot: 2, n: 5 });
  for (const bad of ["", "x", "s:5/5", "s:-1/3", "s:a/b", "../..:0/1", null]) assert.equal(parseWorlds(bad), null, String(bad));
});

test("an entry holds the exact body, its wire hash, its content hash, and the answer's status", () => {
  const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "the ask" }] });
  const l = createLedger({ now: () => "T" });
  const h = l.open({ url: "https://api.x.test/v1/chat/completions", body, provider: "p", model: "m", auditId: "aud1", worlds: { setId: "S", slot: 1, n: 3 } });
  assert.equal(h.entry.request.body, body);
  assert.equal(h.entry.request.sha256, hex(body));
  assert.equal(h.entry.request.contentSha256, contentSha256([{ role: "user", content: "the ask" }]));
  assert.equal(h.entry.request.bytes, Buffer.byteLength(body));
  assert.deepEqual(h.entry.worlds, { setId: "S", slot: 1, n: 3 });
  assert.equal(h.entry.response, null, "open before it leaves; the answer is not known yet");
  h.close({ status: 200 });
  assert.equal(h.entry.response.status, 200);
  assert.equal(l.byAuditId("aud1").length, 1); assert.equal(l.bySet("S").length, 1);
});

test("the ledger is bounded, listable by cursor, and summarizes hosts and bytes", () => {
  const l = createLedger({ max: 3 });
  for (let i = 0; i < 5; i++) l.open({ url: `https://h${i % 2}.test/x`, body: "x".repeat(10) });
  assert.equal(l.size, 3);
  const a = l.list({ since: 0, limit: 2 });
  assert.equal(a.entries.length, 2);
  const b = l.list({ since: a.next });
  assert.equal(b.entries.length, 1);
  const sm = l.summary();
  assert.equal(sm.requests, 3); assert.equal(sm.hosts.reduce((n, h) => n + h.bytes, 0), 30);
});

// ───────────────────────── through the real bridge ─────────────────────────

function frontierExecutor(provider = "prov", model = "m1") {
  return { executor: `${provider}:${model}`, endpoint: `https://${provider}.example/v1`, model, provider, location: "external", authClass: "api_key", privacyClass: "sealed-only", auth: { kind: "api_key", apiKey: "sk-LIVE-KEY" }, live: { reachable: true, inflight: 0, queue: 0 }, advertised: { tools: false, structured: false }, cost: { kind: "provider", freeLocal: false } };
}
async function withBridge(t, executors = [frontierExecutor()]) {
  const sent = [];
  const frontierFetch = async (url, opts) => {
    sent.push({ url, opts });
    const data = "data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n";
    return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
  };
  const bridge = createBridge({ port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: "http://127.0.0.1:1", frontierExecutors: executors, frontierFetch, auditFile: null });
  await bridge.listen();
  t.after(() => bridge.close());
  return { sent, base: "http://127.0.0.1:" + bridge.server.address().port };
}
const chat = (base, model, content, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model, heimdall_privacy: "sealed-external", stream: false, messages: [{ role: "system", content: "sys" }, { role: "user", content }] }) });

test("falsifier: the bytes the ledger records are EXACTLY the bytes that left — and the key stays out of it", async (t) => {
  const { sent, base } = await withBridge(t);
  const r = await chat(base, "m1", "make a timer", { "x-fold-audit": "aud-42" });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  const audit = await (await fetch(base + "/api/audit?auditId=aud-42")).json();
  assert.equal(audit.entries.length, 1);
  const e = audit.entries[0];
  assert.equal(e.request.body, sent[0].opts.body, "the recorded body is the wire body, verbatim");
  assert.equal(e.request.sha256, hex(sent[0].opts.body));
  assert.equal(e.host, "prov.example"); assert.equal(e.provider, "prov"); assert.equal(e.model, "m1");
  assert.equal(e.privacy, "sealed-external");
  assert.equal(e.response.status, 200);
  assert.ok(JSON.stringify(audit).indexOf("sk-LIVE-KEY") < 0, "the provider key is never recorded");
  assert.equal(sent[0].opts.headers.authorization ?? sent[0].opts.headers.Authorization, "Bearer sk-LIVE-KEY", "…though it was sent, as it must be");
});

test("the content hash the bridge records equals the one a surface computes from its own messages", async (t) => {
  const { base } = await withBridge(t);
  await chat(base, "m1", "the ask", { "x-fold-audit": "aud-7" });
  const e = (await (await fetch(base + "/api/audit?auditId=aud-7")).json()).entries[0];
  assert.equal(e.request.contentSha256, contentSha256([{ role: "system", content: "sys" }, { role: "user", content: "the ask" }]));
});

test("a world set: each request records its slot, the set id, and nothing about which world is real", async (t) => {
  const { base } = await withBridge(t);
  for (let slot = 0; slot < 3; slot++) await chat(base, "m1", "world " + slot, { "x-fold-audit": "a" + slot, "x-fold-worlds": `S1:${slot}/3` });
  const set = (await (await fetch(base + "/api/audit?setId=S1")).json()).entries;
  assert.deepEqual(set.map((e) => e.worlds), [{ setId: "S1", slot: 0, n: 3 }, { setId: "S1", slot: 1, n: 3 }, { setId: "S1", slot: 2, n: 3 }]);
  assert.ok(!JSON.stringify(set).includes("real"), "no marker of the real world anywhere in what the bridge holds");
});

test("a refused request (no sealed gate) never leaves and never enters the ledger", async (t) => {
  const { sent, base } = await withBridge(t);
  const r = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "x" }] }) });
  assert.equal(r.status, 400);
  assert.equal(sent.length, 0);
  assert.equal((await (await fetch(base + "/api/audit")).json()).entries.length, 0);
});

test("fan-out is visible: two providers tried for one ask appear as two entries with the same audit id", async (t) => {
  const { base } = await withBridge(t, [frontierExecutor("alpha", "a1"), frontierExecutor("beta", "b1")]);
  await chat(base, "a1", "same ask", { "x-fold-audit": "fan" });
  await chat(base, "b1", "same ask", { "x-fold-audit": "fan" });
  const a = await (await fetch(base + "/api/audit?auditId=fan")).json();
  assert.deepEqual(a.entries.map((e) => e.host), ["alpha.example", "beta.example"]);
  assert.equal(a.summary.hosts.length, 2);
});

test("falsifier: a bare model name offered by a keyless proxy AND a credentialed first-party lane goes to the credentialed one (never last-writer-wins)", async (t) => {
  const first = { ...frontierExecutor("anthropic", "claude-x"), provider: "anthropic", endpoint: "https://api.anthropic.example/v1" };
  const proxy = { ...frontierExecutor("llm7", "claude-x"), authClass: "local_open", auth: { kind: "none" }, endpoint: "https://api.llm7.example" };
  // the proxy is listed AFTER the vendor lane — the order that used to win
  const { base } = await withBridge(t, [first, proxy]);
  await chat(base, "claude-x", "route me", { "x-fold-audit": "route-1" });
  const e = (await (await fetch(base + "/api/audit?auditId=route-1")).json()).entries[0];
  assert.equal(e.provider, "anthropic"); assert.equal(e.host, "api.anthropic.example");
  // and the explicit provider:model name still reaches the proxy when asked for
  await chat(base, "llm7:claude-x", "route me too", { "x-fold-audit": "route-2" });
  assert.equal((await (await fetch(base + "/api/audit?auditId=route-2")).json()).entries[0].host, "api.llm7.example");
});
