// peers-http.js — the loopback/LAN transport for peers.js (2026-10-05).
//
//   createPeerHandler({ peerSet, runLocal, ... }) -> handle(req, res)   mounted under /heimdall/peers/*
//   createHttpTransport({ token | tokenPath, allowHosts })              the client half peers.js calls
//   ensureToken(path) / jsonFileStore(path)                              the two small files it needs
//
// Node built-ins and fetch only. Cross-machine over Matrix (swarm.js) is NOT here: docs/PEERS.md.
//
// Auth: peers on one machine share a token (default ~/.heimdall/peers.token, mode 0600, created if
// missing), sent as x-heimdall-peer-token. No token, wrong token -> 401. The Host header must be loopback or
// an explicitly configured peer host (DNS-rebinding wall) -> 403. The client never sends the token to a host
// that is not loopback or configured, whatever a hello claims its url is.

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { HOP_HEADER, ORIGIN_HEADER } from "./peers.js";

export const PREFIX = "/heimdall/peers";
export const TOKEN_HEADER = "x-heimdall-peer-token";
export const DEFAULT_TOKEN_PATH = path.join(os.homedir(), ".heimdall", "peers.token");
export const DEFAULT_PEERS_PATH = path.join(os.homedir(), ".heimdall", "peers.json");

/* --------------------------------------------------------------- files */

/** Read the shared token, creating it (0600, in a 0700 dir) if missing. Tightens a loose mode. */
export function ensureToken(file = DEFAULT_TOKEN_PATH, { fs = nodeFs, randomBytes = crypto.randomBytes } = {}) {
  const read = () => String(fs.readFileSync(file, "utf8")).trim();
  try {
    const t = read();
    if (t.length >= 16) {
      try { if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      return t;
    }
  } catch (e) { if (e?.code !== "ENOENT") throw e; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  try { fs.writeFileSync(file, `${t}\n`, { mode: 0o600, flag: "wx" }); }
  catch (e) { if (e?.code === "EEXIST") { const r = read(); if (r.length >= 16) return r; fs.writeFileSync(file, `${t}\n`, { mode: 0o600 }); } else throw e; }
  return t;
}

/** A {load, save} store for createPeerSet: a JSON file, atomic write. */
export function jsonFileStore(file = DEFAULT_PEERS_PATH, { fs = nodeFs } = {}) {
  return {
    load() { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } },
    save(data) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/* ---------------------------------------------------------------- hosts */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function splitHost(h) {
  h = String(h || "").trim().toLowerCase();
  const m = h.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m) return { name: m[1], full: h };
  const i = h.lastIndexOf(":");
  return i > 0 && h.indexOf(":") === i ? { name: h.slice(0, i), full: h } : { name: h, full: h };
}
/** True when a Host header (or a url's host) is loopback or explicitly allowed (by name or name:port). */
export function hostAllowed(host, allowHosts = []) {
  if (!host) return false;
  const { name, full } = splitHost(host);
  if (LOOPBACK.has(name)) return true;
  return allowHosts.some((a) => { const s = splitHost(a); return s.full === full || (s.full === s.name && s.name === name); });
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const tokenEqual = (a, b) => typeof a === "string" && a !== "" && crypto.timingSafeEqual(digest(a), digest(b));

/* ----------------------------------------------------------------- server */

function send(res, status, body, headers = {}) {
  if (res.headersSent) { res.end(); return; }
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "cache-control": "no-store", ...headers });
  res.end(s);
}
async function readJson(req, limit) {
  let n = 0;
  const chunks = [];
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error("body too large"), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { throw Object.assign(new Error("bad json"), { status: 400 }); }
}
async function* chunksOf(x) {
  const v = await x;
  if (v && typeof v[Symbol.asyncIterator] === "function") { yield* v; return; }
  if (v && typeof v[Symbol.iterator] === "function" && typeof v !== "string") { for (const c of v) yield c; return; }
  yield v;
}
const lineOf = (c) => JSON.stringify(typeof c === "string" ? { type: "delta", text: c } : c) + "\n";

/**
 * handle(req, res) resolves true when the request was ours (path under the prefix), false to fall through.
 *   runLocal(job, signal, ctx) -> async iterable | iterable | value    the floor; ctx = { hops, origin }.
 *   It must NOT forward on its own when ctx.hops >= 1 (peerSet.run enforces that if you route through it).
 */
export function createPeerHandler({ peerSet, runLocal, token, tokenPath = DEFAULT_TOKEN_PATH, fs = nodeFs, allowHosts = [], prefix = PREFIX, maxBodyBytes = 1 << 20 } = {}) {
  if (!peerSet || typeof runLocal !== "function") throw new Error("createPeerHandler needs { peerSet, runLocal }");
  const secret = token || ensureToken(tokenPath, { fs });

  async function infer(req, res) {
    let body;
    try { body = await readJson(req, maxBodyBytes); } catch (e) { return send(res, e.status || 400, { error: e.message }); }
    const job = body?.job;
    const admit = peerSet.admitInbound(job, { hops: req.headers[HOP_HEADER], origin: req.headers[ORIGIN_HEADER] });
    if (!admit.ok) {
      return send(res, admit.status, { error: admit.reason }, admit.retryAfterMs != null ? { "retry-after": String(Math.max(1, Math.ceil(admit.retryAfterMs / 1000))) } : {});
    }
    const ac = new AbortController();
    // the caller went away (or aborted) before we finished: cancel the upstream
    res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    // A floor that ignores its signal must not hold a lent slot forever: when the caller is gone we stop waiting.
    const gone = new Promise((r) => ac.signal.addEventListener("abort", r, { once: true }));
    const work = (async () => {
      const ctx = { hops: Number(req.headers[HOP_HEADER]), origin: String(req.headers[ORIGIN_HEADER]) };
      for await (const c of chunksOf(runLocal(job, ac.signal, ctx))) {
        if (ac.signal.aborted) break;
        if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
        if (!res.write(lineOf(c))) await new Promise((r) => { res.once("drain", r); res.once("close", r); });
        if (ac.signal.aborted) break;
      }
      if (!res.headersSent && !ac.signal.aborted) return send(res, 502, { error: "empty" });
      if (!res.writableEnded) res.end();
    })();
    work.catch(() => {});
    try {
      await Promise.race([work, gone]);
    } catch (e) {
      if (!res.headersSent) send(res, 502, { error: String(e?.message || e).slice(0, 200) });
      else if (!res.writableEnded) { res.write(lineOf({ type: "error", error: String(e?.message || e).slice(0, 200) })); res.end(); }
    } finally { admit.release(); }
  }

  return async function handle(req, res) {
    let u;
    try { u = new URL(req.url, "http://x"); } catch { return false; }
    if (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) return false;
    try {
      if (!hostAllowed(req.headers.host, allowHosts)) { send(res, 403, { error: "bad-host" }); return true; }
      if (!tokenEqual(req.headers[TOKEN_HEADER], secret)) { send(res, 401, { error: "unauthorized" }); return true; }
      const sub = u.pathname.slice(prefix.length) || "/";
      if (sub === "/hello" && req.method === "POST") {
        const r = peerSet.receiveHello(await readJson(req, maxBodyBytes));
        if (!r.ok) send(res, r.reason === "banned" ? 403 : 400, { error: r.reason });
        else send(res, 200, peerSet.hello());
      } else if (sub === "/status" && req.method === "GET") send(res, 200, peerSet.status());
      else if (sub === "/infer" && req.method === "POST") await infer(req, res);
      else send(res, 404, { error: "not-found" });
    } catch (e) { send(res, e?.status || 500, { error: String(e?.message || e).slice(0, 200) }); }
    return true;
  };
}

/* ----------------------------------------------------------------- client */

const mine = new WeakSet();
const fail = (message, code, extra = {}) => { const e = Object.assign(new Error(message), { code, ...extra }); mine.add(e); return e; };

export function createHttpTransport({ token, tokenPath = DEFAULT_TOKEN_PATH, fs = nodeFs, allowHosts = [], fetchImpl = (...a) => fetch(...a), prefix = PREFIX } = {}) {
  const secret = token || ensureToken(tokenPath, { fs });
  const target = (peer, sub) => {
    let u;
    try { u = new URL(peer.url); } catch { throw fail("peer has no usable url", "refused"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw fail("peer url must be http(s)", "refused");
    if (!hostAllowed(u.host, allowHosts)) throw fail(`refusing to send the peer token to ${u.host}`, "refused");
    return `${u.origin}${prefix}${sub}`;
  };
  const headers = (extra) => ({ "content-type": "application/json", [TOKEN_HEADER]: secret, ...extra });
  const retryAfter = (res) => { const v = res.headers.get("retry-after"); return v == null ? null : /^\d+(\.\d+)?$/.test(v.trim()) ? Math.round(Number(v) * 1000) : Math.max(0, Date.parse(v) - Date.now()) || null; };

  return {
    /** POST /hello. Resolves the peer's own hello, or null on a refusal. Throws on network failure. */
    async hello(peer, selfHello, { signal, timeoutMs = 2000 } = {}) {
      const ac = new AbortController();
      const onAbort = () => ac.abort(signal.reason);
      if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
      const t = setTimeout(() => ac.abort(fail("hello timed out", "timeout")), timeoutMs);
      try {
        const res = await fetchImpl(target(peer, "/hello"), { method: "POST", headers: headers(), body: JSON.stringify(selfHello), signal: ac.signal });
        if (!res.ok) { await res.body?.cancel?.(); return null; }
        return await res.json();
      } finally { clearTimeout(t); signal?.removeEventListener?.("abort", onAbort); }
    },

    /**
     * POST /infer. Resolves an async iterable of parsed chunks once the FIRST chunk has arrived;
     * rejects with code timeout (no first byte in firstByteMs), abort (the caller's signal), busy (429, retryAfterMs),
     * auth (401/403 from a refusal of the token), http, down, refused, empty.
     * The caller's signal, and simply ceasing to read, cancel the upstream request.
     */
    async call(peer, job, { signal, firstByteMs = 8000, headers: extra = {} } = {}) {
      const url = target(peer, "/infer");
      const ac = new AbortController();
      let timedOut = false;
      const onAbort = () => ac.abort();
      if (signal) { if (signal.aborted) throw fail("aborted", "abort"); signal.addEventListener("abort", onAbort, { once: true }); }
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, firstByteMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); };
      const why = (e) => (mine.has(e) ? e : signal?.aborted ? fail("aborted", "abort") : timedOut ? fail(`no first byte within ${firstByteMs}ms`, "timeout") : fail(String(e?.cause?.code || e?.message || e), "down"));
      let reader;
      try {
        const res = await fetchImpl(url, { method: "POST", headers: headers(extra), body: JSON.stringify({ job }), signal: ac.signal });
        if (!res.ok) {
          const status = res.status;
          const ra = retryAfter(res);
          const text = await res.text().catch(() => "");
          throw fail(`peer answered ${status} ${text.slice(0, 120)}`, status === 429 ? "busy" : status === 401 ? "auth" : "http", { status, retryAfterMs: ra });
        }
        reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const queue = [];
        let ended = false;
        const pump = async () => { // read until at least one full line is queued, or the body ends
          while (!queue.length && !ended) {
            const { done, value } = await reader.read();
            if (done) { ended = true; if (buf.trim()) queue.push(buf); buf = ""; break; }
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) queue.push(l); }
          }
        };
        await pump();
        if (!queue.length) throw fail("peer sent nothing", "empty");
        clearTimeout(timer); // first byte seen: the deadline has done its job
        return (async function* () {
          try {
            for (;;) {
              while (queue.length) {
                let c;
                try { c = JSON.parse(queue.shift()); } catch { throw fail("peer sent a malformed line", "http"); }
                if (c?.type === "error") throw fail(String(c.error || "upstream error"), "upstream");
                yield c;
              }
              if (ended) return;
              try { await pump(); } catch (e) { throw signal?.aborted ? fail("aborted", "abort") : e; }
            }
          } finally { cleanup(); ac.abort(); reader.cancel().catch(() => {}); }
        })();
      } catch (e) {
        cleanup();
        ac.abort();
        reader?.cancel?.().catch(() => {});
        throw why(e);
      }
    },
  };
}
