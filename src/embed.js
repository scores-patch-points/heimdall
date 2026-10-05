// embed.js — heimdall INSIDE a host server (2026-10-05). There is no standalone heimdall: khora's proxy, penelope's mouth and the
// Fold's server each mount their own, and the instances coordinate as peers (docs/PEERS.md). Contract and ladder rule: docs/EMBED.md.
//
//   const hm = mountHeimdall({ name: "penelope-mouth", peerUrls: [...] });
//   server = http.createServer(async (req, res) => { if (await hm.handle(req, res)) return; /* the host's own routes */ });
//
// Possibility first: every instance's floor works with ZERO peers (with none known, a request goes straight to the plain bridge,
// untouched). Peers only add options. No port of its own, no process.exit, no console output unless opts.log, no global state.

import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createBridge } from "./bridge-server.mjs";
import { createPeerSet, PRIVACY_CLASSES } from "./peers.js";
import { createPeerHandler, createHttpTransport, ensureToken, jsonFileStore, hostAllowed } from "./peers-http.js";
import { normalizeOllamaHost } from "./floor.js";

export const SCHEMA = "HeimdallEmbed@1";
export const DEFAULT_PREFIX = "/heimdall";
export const TICK_MS = 15_000;
/** A local answer with one of these heads, BEFORE its first body byte, may be retried on a peer. Anything else is the answer. */
export const PEERABLE_STATUS = Object.freeze([404, 429, 500, 502, 503, 504, 508]);

const HOLD_CAP = 64 * 1024; // a refusal body is held to replay it; past this it is simply the answer
const MAX_JOB_BYTES = 900 * 1024; // the peer transport's body limit is 1 MiB
const normModel = (m) => String(m ?? "").trim().toLowerCase().replace(/:latest$/, "");
const nonce = Symbol("bound");

function send(res, code, obj, headers = {}) {
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "cache-control": "no-store", ...headers });
  res.end(s);
}

/** The path part of a request url, no allocation of a URL object, no throw. null when there is none. */
function rawPath(url) {
  if (typeof url !== "string") return null;
  const i = url.search(/[?#]/);
  return i < 0 ? url : url.slice(0, i);
}

/** A request replayed from a buffer: the host already consumed the body to read the model, the bridge must still be able to. */
function replayReq(req, buf) {
  const r = Readable.from([buf]);
  r.method = req.method; r.url = req.url; r.headers = req.headers; r.socket = req.socket; r.connection = req.socket; r.httpVersion = req.httpVersion;
  return r;
}

/** The bridge's own Host/Origin wall, reused by calling it: a GET to its cheapest route on a stand-in response. */
async function preflight(bridge, req, prefix) {
  const cap = { status: 0, headers: {}, ended: false, headersSent: false, writableEnded: false, destroyed: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; }, getHeader(k) { return this.headers[String(k).toLowerCase()]; }, removeHeader(k) { delete this.headers[String(k).toLowerCase()]; },
    writeHead(s, h) { this.status = s; this.headersSent = true; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; return this; },
    write() { return true; }, end() { this.ended = true; this.writableEnded = true; }, on() { return this; }, once() { return this; }, destroy() {} };
  const fake = Readable.from([]);
  fake.method = "GET"; fake.url = `${prefix}/bridge/hello`; fake.headers = { host: req.headers.host, ...(req.headers.origin ? { origin: req.headers.origin } : {}) }; fake.socket = req.socket;
  await bridge.handler(fake, cap);
  return { ok: cap.status === 200, status: cap.status, headers: Object.fromEntries(Object.entries(cap.headers).filter(([k]) => k.startsWith("access-control-") || k === "vary")) };
}

/** A response wrapper that holds the LOCAL floor's head until it is clear whether a peer should be asked instead. */
function holdResponse(real) {
  let mode = "held"; // held -> live | refused ; any -> dropped
  let status = 0, hdrs = null, size = 0, ended = false;
  const chunks = [];
  const closeFns = [];
  let settle;
  const head = new Promise((r) => { settle = r; });
  const toBuf = (c, enc) => (c == null ? null : Buffer.isBuffer(c) ? c : Buffer.from(typeof c === "string" ? c : String(c), typeof enc === "string" ? enc : "utf8"));
  const live = () => { mode = "live"; settle({ ok: true }); };
  const flush = () => { real.writeHead(status, hdrs || undefined); for (const c of chunks) real.write(c); chunks.length = 0; };
  const proxy = new Proxy(real, {
    get(t, p) {
      if (p === "writeHead") return (s, a, b) => {
        if (mode === "live") return real.writeHead(s, a, b);
        if (mode !== "held") return proxy;
        status = s; hdrs = typeof a === "string" ? b : a;
        if (PEERABLE_STATUS.includes(s)) { mode = "refused"; return proxy; }
        live(); real.writeHead(s, hdrs || undefined);
        return proxy;
      };
      if (p === "write") return (c, enc, cb) => {
        if (mode === "live") return real.write(c, enc, cb);
        if (mode === "held") { live(); return real.write(c, enc, cb); } // implicit 200
        if (mode === "refused") { const b = toBuf(c, enc); if (b) { chunks.push(b); size += b.length; } if (size > HOLD_CAP) { flush(); live(); } return true; }
        return true;
      };
      if (p === "end") return (c, enc, cb) => {
        if (mode === "live") return real.end(c, enc, cb);
        if (mode === "held") { live(); return real.end(c, enc, cb); }
        if (mode === "refused") { const b = toBuf(typeof c === "function" ? null : c, enc); if (b) chunks.push(b); ended = true; settle({ ok: false, status, headers: hdrs || {}, body: Buffer.concat(chunks) }); return proxy; }
        return proxy;
      };
      if (p === "on" || p === "once" || p === "addListener") return (ev, fn) => { if (ev === "close") closeFns.push(fn); real[p](ev, fn); return proxy; };
      if (p === "writableEnded" || p === "headersSent") return mode === "live" ? real[p] : false;
      if (p === "destroyed") return mode === "live" ? real.destroyed : false;
      if (p === "destroy") return (...a) => (mode === "live" ? real.destroy(...a) : proxy);
      const v = real[p];
      return typeof v === "function" ? v.bind(real) : v;
    },
    set(t, p, v) { real[p] = v; return true; },
  });
  return {
    proxy, head,
    /** the local floor is no longer wanted (a peer answered): cancel its upstream, discard what it says. */
    drop() { if (mode === "live" || mode === "dropped") return; mode = "dropped"; settle({ ok: false, dropped: true }); for (const f of closeFns) { try { f(); } catch { /* listener */ } } },
    /** the local refusal, written to the real response as the plain bridge would have. */
    replay(h) { real.writeHead(h.status, h.headers); real.end(h.body); },
    ended: () => ended,
    settleOk: () => { if (mode === "held") live(); },
  };
}

export function mountHeimdall(opts = {}) {
  const name = opts.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("mountHeimdall needs { name } (letters, digits, . _ -; unique per server)");
  const prefix = String(opts.prefix ?? DEFAULT_PREFIX).replace(/\/+$/, "") || DEFAULT_PREFIX;
  if (!prefix.startsWith("/")) throw new Error("prefix must start with /");
  const peerPrefix = `${prefix}/peers`;
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? nodeFs;
  const now = opts.clock ?? (() => Date.now());
  const timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a), setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a), ...(opts.timers || {}) };
  const fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const startedAt = now();

  // every file lives under stateDir; only the shared peer token may live beside it (same-machine peers must share one token)
  const homeDir = opts.homeDir ?? path.join(os.homedir(), ".heimdall");
  const stateDir = opts.stateDir ?? path.join(homeDir, name);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const peerToken = opts.peerToken || ensureToken(opts.peerTokenFile || (opts.stateDir ? path.join(stateDir, "peers.token") : path.join(homeDir, "peers.token")), { fs });

  const floors = (Array.isArray(opts.floors) && opts.floors.length ? opts.floors : [normalizeOllamaHost(env.OLLAMA_HOST) || "http://127.0.0.1:11435"]).map((u) => String(u).replace(/\/+$/, ""));
  const fl = floors.map((url) => ({ url, up: null, models: null }));
  let known = null; // Set of normalised model names held by the floors that answered, or null = unknown
  let floorsAt = 0;

  const bridge = createBridge({
    port: 0, host: "127.0.0.1", dist: null, autoOpen: false, upstream: floors[0], upstreams: floors, prefix, log,
    tokenFile: path.join(stateDir, "bridge.token"), linksFile: path.join(stateDir, "hosts.json"), stateFile: path.join(stateDir, "state.json"),
    routeStatsFile: path.join(stateDir, "route-stats.json"), auditFile: path.join(stateDir, "outbound-ledger.ndjson"), competenceFile: path.join(stateDir, "competence.json"),
    ...(opts.bridgeOptions || {}),
  });

  const life = new AbortController(); // aborted by close(): cancels in-flight peer work
  const peers = createPeerSet({
    self: { id: name, name, url: opts.selfUrl || "", models: [], caps: { tools: true, structured: true, context: opts.context ?? 0 }, privacy: opts.privacy ?? "local-raw", trustDomain: opts.trustDomain },
    transport: createHttpTransport({ token: peerToken, allowHosts: opts.allowHosts || [], prefix: peerPrefix, fs }),
    store: jsonFileStore(path.join(stateDir, "peers.json"), { fs }),
    now, timers: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }, ...(opts.random ? { random: opts.random } : {}),
    ...(opts.peerOptions || {}),
  });
  for (const p of opts.peerUrls || []) {
    const e = typeof p === "string" ? { url: p } : p;
    try { peers.add({ url: e.url, name: e.name, trusted: e.trusted ?? opts.trustPeers !== false }); } catch (err) { log(`peer ${e?.url}: ${err.message}`); }
  }
  const peerHandler = createPeerHandler({
    peerSet: peers, token: peerToken, allowHosts: opts.allowHosts || [], prefix: peerPrefix, fs,
    // THE LOOP RULE: a job a peer sent us runs on OUR floor only. runLocal never reaches peers.run.
    runLocal: (job, signal) => bridge.runLocal(job, signal ? AbortSignal.any([signal, life.signal]) : life.signal),
  });

  const counters = { chat: 0, localServed: 0, peerFirst: 0, hedged: 0, peerServed: 0, localRefused: 0, peerMissed: 0 };
  let inflight = 0;
  let closed = false;
  const setLoad = () => peers.setLoad({ inflight, queue: 0, tokensPerSec: 0 });

  /* ------------------------------------------------------------ floors */
  async function probeFloors() {
    await Promise.all(fl.map(async (f) => {
      try {
        const r = await fetchImpl(`${f.url}/api/tags`, { signal: AbortSignal.timeout(opts.probeMs ?? 1500) });
        f.up = r.ok;
        f.models = null;
        if (r.ok) { try { const j = await r.json(); if (Array.isArray(j?.models)) f.models = j.models.map((m) => normModel(m?.name ?? m?.model)).filter(Boolean); } catch { /* up, models unknown */ } }
        else await r.body?.cancel?.().catch(() => {});
      } catch { f.up = false; f.models = null; }
    }));
    const up = fl.filter((f) => f.up);
    known = up.length && up.every((f) => f.models) ? new Set(up.flatMap((f) => f.models)) : null;
    peers.setModels(up.flatMap((f) => f.models || []).filter((m, i, a) => a.indexOf(m) === i)); // a dead floor advertises nothing: peers will not send us what we cannot run
    floorsAt = Date.now();
  }
  let beating = null;
  /** One heartbeat: look at the floors, say hello to the peers. Never throws; overlapping calls share one round. */
  function refresh() {
    if (closed) return Promise.resolve();
    beating ||= (async () => { try { await probeFloors(); setLoad(); await peers.tick({ signal: life.signal }); } catch (e) { log(`heartbeat: ${e?.message || e}`); } finally { beating = null; } })();
    return beating;
  }
  let ticker = null;
  if (opts.autoTick !== false) {
    refresh();
    ticker = timers.setInterval(() => { refresh(); }, opts.tickMs ?? TICK_MS);
    ticker?.unref?.();
  }

  /* ------------------------------------------------------------- status */
  const statusDoc = () => ({
    schema: SCHEMA, name,
    floors: fl.map(({ url, up }) => ({ url, up })),
    peers: peers.status(),
    stats: { ...bridge.stats, embed: { ...counters, inflight } },
    token: false, // the token is never sent over any route of this module
    startedAt: new Date(startedAt).toISOString(),
  });

  /* ---------------------------------------------------- the peer ladder */
  const jobOf = (b, kind) => {
    if (!b || typeof b !== "object" || typeof b.model !== "string" || !b.model) return null;
    const msgs = Array.isArray(b.messages) ? b.messages : null;
    if (b.images?.length || msgs?.some((m) => m?.images?.length || m?.tool_calls)) return null; // binary parts: the floor only
    const asked = b.heimdall_privacy || b.privacy;
    const job = { model: b.model, privacy: PRIVACY_CLASSES.includes(asked) ? asked : "local-raw", requires: [], kind };
    if (msgs) job.messages = msgs; else if (b.prompt != null) { job.prompt = String(b.prompt); if (b.system) job.system = String(b.system); } else return null;
    if (b.tools?.length) { job.requires.push("tools"); job.tools = b.tools; }
    if (b.format) { job.requires.push("structured"); job.format = b.format; }
    if (b.options && typeof b.options === "object") { job.options = b.options; if (b.options.num_predict > 0) job.maxTokens = b.options.num_predict; }
    return JSON.stringify(job).length > MAX_JOB_BYTES ? null : job;
  };
  /** Ask the best eligible peer. Resolves { it, first, peer } once its FIRST chunk is in hand, or null (none eligible, refused, failed). */
  async function attemptPeer(job, signal) {
    try {
      const r = await peers.run(job, { signal }); // no fallback: with no eligible peer it throws no-route — the caller's floor is the answer
      const it = r.stream[Symbol.asyncIterator]();
      return { it, first: await it.next(), peer: r.peer };
    } catch { return null; }
  }
  const closePeer = (p) => { try { p?.it?.return?.(); } catch { /* done */ } };

  async function servePeer(res, b, kind, p, goneSignal) {
    const stream = b.stream !== false;
    const via = { "x-heimdall-served-by": `peer:${p.peer.name}` };
    const line = (text, extra = {}) => ({ model: b.model, created_at: new Date(now()).toISOString(), ...(kind === "chat" ? { message: { role: "assistant", content: text } } : { response: text }), done: false, ...extra });
    async function* all() { if (!p.first.done) yield p.first.value; for (;;) { const n = await p.it.next(); if (n.done) return; yield n.value; } }
    counters.peerServed++;
    let text = "";
    try {
      if (stream) res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", ...via });
      for await (const c of all()) {
        if (goneSignal.aborted) break;
        if (c?.type !== "delta" || typeof c.text !== "string") continue;
        text += c.text;
        if (stream) res.write(JSON.stringify(line(c.text)) + "\n");
      }
      const done = { done: true, done_reason: "stop", heimdall: `peer:${p.peer.name}` };
      if (stream) res.end(JSON.stringify(line("", done)) + "\n");
      else send(res, 200, line(text, done), via);
    } catch (e) {
      if (stream && res.headersSent) { res.write(JSON.stringify({ error: `peer failed mid-stream: ${e?.message || e}` }) + "\n"); res.end(); }
      else send(res, 502, { error: `peer failed: ${e?.message || e}` }, via);
    } finally { closePeer(p); }
  }

  /**
   * THE LADDER (docs/EMBED.md). POST /api/chat and /api/generate:
   *   0. no peer known at all -> straight to the plain bridge (byte-for-byte what it did before).
   *   1. peers FIRST only when the local floor cannot serve the model (floors answered, none holds it, no fleet tab does) AND a peer is eligible.
   *   2. otherwise the LOCAL floor runs first. If it answers, that is the answer.
   *   3. if its head is a refusal/failure (PEERABLE_STATUS) BEFORE a body byte -> one peer attempt; if none/failed -> replay the local refusal.
   *   4. if it has not produced a head within localQueueMs -> a peer attempt is started in parallel (hedge); the first to produce wins and the loser is cancelled.
   * A peer's own request (hops=1) arrives at /heimdall/peers/infer and never enters this function: it ends on the local floor.
   */
  async function ladder(req, res, kind) {
    const chunks = []; let n = 0;
    const limit = opts.bridgeOptions?.maxBodyBytes ?? 8 * 1024 * 1024;
    for await (const c of req) { n += c.length; if (n > limit) return send(res, 413, { error: "body too large" }); chunks.push(c); }
    const buf = Buffer.concat(chunks);
    let b = null; try { b = JSON.parse(buf.toString() || "{}"); } catch { /* the bridge says 400 */ }
    const job = jobOf(b, kind);
    if (!job || peers.list().length === 0) return bridge.handler(replayReq(req, buf), res);

    const gone = new AbortController();
    const onClose = () => { if (!res.writableEnded) gone.abort(); };
    res.on("close", onClose);
    const signal = AbortSignal.any([gone.signal, life.signal]);
    const pre = await preflight(bridge, req, prefix); // Host/Origin wall, exactly the bridge's
    if (!pre.ok) return send(res, pre.status || 403, { error: "not allowed" });
    for (const [k, v] of Object.entries(pre.headers)) res.setHeader(k, v);
    let peerTried = false;
    const peerPath = async (p) => { await servePeer(res, b, kind, p, signal); };

    if (known && !known.has(normModel(job.model)) && !bridge.fleetServes?.(job.model)) {
      peerTried = true;
      const p = await attemptPeer(job, signal);
      if (p) { counters.peerFirst++; return peerPath(p); }
      counters.peerMissed++;
    }

    const held = holdResponse(res);
    const localDone = Promise.resolve().then(() => bridge.handler(replayReq(req, buf), held.proxy))
      .catch((e) => { held.proxy.writeHead(502, { "content-type": "application/json" }); held.proxy.end(JSON.stringify({ error: String(e?.message || e) })); })
      .finally(() => held.settleOk());
    let pa = null;
    const peerAc = new AbortController(); // the hedge's own leash: cancelled when the local floor wins
    const timer = { id: null };
    const bound = opts.localQueueMs ?? 10_000;
    const boundP = peerTried || !(bound > 0) ? new Promise(() => {}) : new Promise((r) => { timer.id = timers.setTimeout(() => r(nonce), bound); timer.id?.unref?.(); });
    try {
      let first = await Promise.race([held.head, boundP]);
      if (first === nonce) {
        counters.hedged++;
        pa = attemptPeer(job, AbortSignal.any([signal, peerAc.signal]));
        const w = await Promise.race([held.head.then((v) => ({ l: v })), pa.then((v) => ({ p: v }))]);
        if (w.l) first = w.l;
        else if (w.p) { held.drop(); counters.peerFirst++; return await peerPath(w.p); }
        else first = await held.head; // no peer to be had: wait for the floor as the plain bridge would
      }
      if (first.ok) { counters.localServed++; peerAc.abort(); if (pa) pa.then(closePeer); return await localDone; }
      if (first.dropped) return;
      counters.localRefused++;
      const p = peerTried ? null : await (pa ||= attemptPeer(job, AbortSignal.any([signal, peerAc.signal])));
      if (p) { counters.peerFirst++; return await peerPath(p); }
      if (!peerTried) counters.peerMissed++;
      if (!gone.signal.aborted) held.replay(first);
    } finally {
      timers.clearTimeout(timer.id);
      res.off?.("close", onClose);
      if (pa) pa.then((p) => { if (p && gone.signal.aborted) closePeer(p); });
    }
  }

  /* ------------------------------------------------------------ routing */
  async function serve(req, res) {
    try {
      if (closed) { send(res, 503, { error: "heimdall is closed" }); return true; }
      let u;
      try { u = new URL(req.url, "http://x"); } catch { send(res, 400, { error: "malformed URL" }); return true; }
      const pn = u.pathname;
      if (pn !== prefix && !pn.startsWith(`${prefix}/`)) { send(res, 404, { error: "not found" }); return true; } // e.g. /heimdall/../x
      const sub = pn.slice(prefix.length) || "/";
      if (sub === "/peers" || sub.startsWith("/peers/")) { await peerHandler(req, res); return true; }
      if (sub === "/status" && (req.method === "GET" || req.method === "HEAD")) {
        const pre = await preflight(bridge, req, prefix);
        if (!pre.ok) { send(res, pre.status || 403, { error: "not allowed" }); return true; }
        if (Date.now() - floorsAt > 5000) await probeFloors().catch(() => {});
        send(res, 200, statusDoc(), pre.headers);
        return true;
      }
      if (sub === "/bridge-status" && req.method === "GET") req.url = `${prefix}/status${u.search}`; // the bridge's own /status, moved aside
      if (req.method === "POST" && (sub === "/api/chat" || sub === "/api/generate")) {
        counters.chat++; inflight++; setLoad();
        try { await ladder(req, res, sub === "/api/chat" ? "chat" : "generate"); } finally { inflight--; setLoad(); }
        return true;
      }
      await bridge.handler(req, res);
      return true;
    } catch (e) {
      log(`heimdall error: ${e?.stack || e}`);
      try {
        if (!res.headersSent) send(res, 500, { error: "heimdall-internal", message: String(e?.message || e).slice(0, 200) });
        else res.end();
      } catch { /* the socket is gone */ }
      return true;
    }
  }

  /** TRUE when the request was under the prefix (and has been answered), FALSE otherwise. The non-match path is a synchronous prefix
   *  check: no await, no I/O, no allocation beyond one string slice — a host's own routes pay nothing. Never throws. */
  async function handle(req, res) {
    let p;
    try { p = rawPath(req?.url); } catch { return false; }
    if (p === null || (p !== prefix && !p.startsWith(`${prefix}/`))) return false;
    return serve(req, res);
  }

  async function close() {
    if (closed) return;
    closed = true;
    life.abort();
    if (ticker) timers.clearInterval(ticker);
    try { await bridge.close(); } catch { /* not listening */ }
  }

  return { handle, status: statusDoc, peers, bridge, close, refresh, prefix, stateDir };
}
