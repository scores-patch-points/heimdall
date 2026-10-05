// bridge-testkit.mjs — hermetic helpers for the bridge tests (not a test file).
// Every bridge built here gets temp state/hosts/audit/competence files and an
// in-memory token, a fake upstream, and never touches ~/.heimdall or a real Ollama.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridge } from "./bridge-server.mjs";

export const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "heimdall-t-"));

/** A tiny http server; `handler(req, res, bodyString)` gets the whole request body. */
export async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body, hits);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** An Ollama-wire upstream that answers every /api/chat with `text` (NDJSON). */
export const ollamaUp = (text = "upstream-ok", extraHeaders = {}) => serve((req, res) => {
  if (req.url === "/api/tags") { res.writeHead(200, { "content-type": "application/json", ...extraHeaders }); return res.end(JSON.stringify({ models: [] })); }
  res.writeHead(200, { "content-type": "application/x-ndjson", ...extraHeaders });
  res.end(JSON.stringify({ model: "x", message: { role: "assistant", content: text }, done: true, done_reason: "stop" }) + "\n");
});

export const sseBody = (chunks, tail = "data: [DONE]\n\n") => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunks.join("") + tail)); c.close(); } });
export const oaChunk = (content, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content } }], ...extra })}\n\n`;

export const groqEx = (over = {}) => ({
  executor: "groq:gpt-oss-120b", endpoint: "https://api.groq.com/openai/v1", model: "gpt-oss-120b", provider: "groq",
  location: "external", authClass: "api_key", privacyClass: "sealed-only", live: { reachable: true }, auth: { kind: "api_key", apiKey: "gsk-test" }, ...over,
});
export const anthropicEx = (model, over = {}) => ({
  executor: `anthropic:${model}`, endpoint: "https://api.anthropic.com/v1", model, provider: "anthropic",
  location: "external", authClass: "api_key", privacyClass: "sealed-only", live: { reachable: true }, auth: { kind: "api_key", apiKey: "sk-ant-test" }, ...over,
});

/** Start a hermetic bridge. Returns { bridge, base, hdr (token header), dir, close }. */
export async function startBridge(over = {}) {
  const dir = mkdir();
  const bridge = createBridge({
    port: 0, host: "127.0.0.1", dist: null, upstream: "http://127.0.0.1:1", autoOpen: false,
    linksFile: path.join(dir, "hosts.json"), stateFile: path.join(dir, "state.json"), routeStatsFile: null,
    auditFile: path.join(dir, "outbound-ledger.ndjson"), competenceFile: path.join(dir, "competence.json"),
    tokenFile: null, listLocalModels: () => [], weaveUrl: "http://127.0.0.1:1/api/weave", khoraUrl: "http://127.0.0.1:1", opencodeUrl: null,
    ...over,
  });
  const addr = await bridge.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { bridge, base, dir, port: addr.port, hdr: { "x-heimdall-token": bridge.token }, close: () => bridge.close() };
}

export const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Raw request with full control of Host/path (fetch refuses to forge Host). */
export function raw(base, { method = "GET", path: p = "/", headers = {}, body = null } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
