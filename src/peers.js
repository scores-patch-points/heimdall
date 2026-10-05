// peers.js — heimdall instances as PEERS (2026-10-05).
//
// There is no standalone heimdall. Every server embeds its own heimdall and
// each instance's FLOOR (its own Ollama / in-tab engine) works with zero
// peers. That is the "possibility" layer. Peers are the "probability" layer:
// they may ADD options and must DEGRADE TO NOTHING. A peer that is down, slow,
// lying or removed costs the caller at most one bounded timeout, then is
// skipped by a circuit breaker. Nothing here may become a dependency.
//
// Pure and injectable: clock (`now`), `transport`, `random`, `timers`, `store`.
// No globals read, no process.exit, no fs. Wire: docs/PEERS.md.

import { PING_EVERY_MS, STALE_AFTER_MS, DEAD_AFTER_MS } from "./liveness.js";

export { PING_EVERY_MS, STALE_AFTER_MS, DEAD_AFTER_MS };

export const HELLO_TYPE = "PeerHello@1";
export const HOP_HEADER = "x-heimdall-hops";
export const ORIGIN_HEADER = "x-heimdall-origin";
export const PRIVACY_CLASSES = Object.freeze(["local-raw", "sealed-external"]);
/** One hop: a forwarded request is served or refused by the peer, never re-forwarded. */
export const MAX_HOPS = 1;

const DEFAULTS = Object.freeze({
  ttlMs: 10 * 60_000, // a DISCOVERED peer silent this long is forgotten (added peers never are)
  helloTimeoutMs: 2_000,
  firstByteMs: 8_000,
  failThreshold: 2, // consecutive failures before the breaker opens (a timeout/auth opens at once)
  cooldownBaseMs: 5_000,
  cooldownCapMs: 5 * 60_000,
  retryAfterCapMs: 10 * 60_000,
  lendBelow: 2, // lend only while (own inflight + lent) < this
  shedRetryMs: 2_000,
  defaultTtftMs: 1_500,
  defaultJobMs: 2_000,
  defaultTokens: 256,
  maxAttempts: 1,
});

const clip = (s, n = 200) => String(s ?? "").slice(0, n);
const num = (x, d = 0) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : d);
const normModel = (m) => String(m ?? "").trim().toLowerCase().replace(/:latest$/, "");
const isAnyModel = (m) => m == null || m === "" || m === "any";

/** Parse a Retry-After header (delta-seconds or HTTP date) to ms; null when absent/unparseable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/** Validate and normalise a PeerHello@1. Never trusts sizes or types. */
export function normalizeHello(h) {
  if (!h || typeof h !== "object") return { ok: false, reason: "not-an-object" };
  if (h.type !== undefined && h.type !== HELLO_TYPE) return { ok: false, reason: "wrong-type" };
  const id = clip(h.id, 128);
  if (!id) return { ok: false, reason: "no-id" };
  const privacyClass = PRIVACY_CLASSES.includes(h.privacyClass) ? h.privacyClass : "sealed-external";
  const models = (Array.isArray(h.models) ? h.models : []).filter((m) => typeof m === "string" && m).slice(0, 64).map((m) => clip(m, 200));
  const caps = h.caps && typeof h.caps === "object" ? h.caps : {};
  const load = h.load && typeof h.load === "object" ? h.load : {};
  return {
    ok: true,
    hello: {
      type: HELLO_TYPE,
      id,
      name: clip(h.name || id, 80),
      url: typeof h.url === "string" ? clip(h.url, 300) : "",
      models,
      caps: { tools: !!caps.tools, structured: !!caps.structured, context: Math.max(0, Math.floor(num(caps.context, 0))) },
      load: { inflight: Math.max(0, num(load.inflight)), queue: Math.max(0, num(load.queue)), tokensPerSec: Math.max(0, num(load.tokensPerSec)) },
      privacyClass,
      trustDomain: h.trustDomain ? clip(h.trustDomain, 128) : undefined,
      epoch: num(h.epoch, 0),
      ts: num(h.ts, 0),
    },
  };
}

/** Standing derived from last-heard only — same bounds as liveness.js. Unheard = linking. */
export function standingOfPeer(entry, now) {
  if (!entry) return "lost";
  if (entry.banned) return "banned";
  if (entry.lastHeard == null) return "linking";
  const silent = now - entry.lastHeard;
  if (silent >= DEAD_AFTER_MS) return "dead";
  if (silent >= STALE_AFTER_MS) return "stale";
  return "ready";
}

/** Adapt whatever a floor returns (async iterable, sync iterable, promise of a value) to an async iterable. */
async function* toStream(x) {
  const v = await x;
  if (v && typeof v[Symbol.asyncIterator] === "function") { yield* v; return; }
  if (v && typeof v[Symbol.iterator] === "function" && typeof v !== "string") { for (const c of v) yield c; return; }
  yield v;
}

export function createPeerSet({
  self,
  transport = null,
  now = () => Date.now(),
  random = Math.random,
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) },
  store = null,
  ...opts
} = {}) {
  if (!self || !self.id) throw new Error("createPeerSet needs self.id");
  const cfg = { ...DEFAULTS, ...opts };
  const me = {
    id: String(self.id),
    name: clip(self.name || self.id, 80),
    url: self.url || "",
    models: [...(self.models || [])],
    caps: { tools: !!self.caps?.tools, structured: !!self.caps?.structured, context: num(self.caps?.context, 0) },
    privacy: PRIVACY_CLASSES.includes(self.privacy) ? self.privacy : "sealed-external",
    trustDomain: self.trustDomain || undefined,
    epoch: num(self.epoch, now()),
    lend: self.lend !== false,
    load: { inflight: 0, queue: 0, tokensPerSec: 0 },
  };
  let lent = 0; // jobs this instance is serving for peers right now
  /** @type {Map<string, any>} */
  const peers = new Map();
  const banned = new Set();

  const newEntry = (o) => ({
    id: o.id, name: clip(o.name || o.id, 80), url: o.url || "", source: o.source || "discovered", trusted: !!o.trusted,
    banned: false, hello: null, lastHeard: null, epoch: null,
    ok: 0, fail: 0, ttftMs: null, inflight: 0,
    breaker: { fails: 0, opens: 0, openUntil: 0, opened: false, probing: false, lastKind: null },
  });

  /* ------------------------------------------------------------ persistence */
  function persist() {
    if (!store?.save) return;
    const data = {
      version: 1,
      peers: [...peers.values()].filter((e) => e.source === "added").map((e) => ({ id: e.id, name: e.name, url: e.url, trusted: e.trusted })),
      banned: [...banned],
    };
    try { const r = store.save(data); if (r && typeof r.catch === "function") r.catch(() => {}); } catch { /* a store failure never reaches a request */ }
  }
  try {
    const saved = store?.load?.();
    if (saved && typeof saved === "object") {
      for (const b of Array.isArray(saved.banned) ? saved.banned : []) banned.add(String(b));
      for (const p of Array.isArray(saved.peers) ? saved.peers : []) {
        if (!p || !(p.id || p.url) || banned.has(String(p.id))) continue;
        const e = newEntry({ id: p.id || `url:${p.url}`, name: p.name, url: p.url, source: "added", trusted: !!p.trusted });
        peers.set(e.id, e);
      }
    }
  } catch { /* unreadable store: start empty */ }

  /* ------------------------------------------------------------- the list */
  const view = (e) => ({
    id: e.id, name: e.name, url: e.url, source: e.source, trusted: e.trusted,
    standing: standingOfPeer(e, now()), breaker: breakerState(e),
    models: e.hello?.models || [], caps: e.hello?.caps || null, load: e.hello?.load || null,
    privacyClass: e.hello?.privacyClass || null, lastHeard: e.lastHeard,
    ok: e.ok, fail: e.fail, p: successRate(e), ttftMs: e.ttftMs,
  });

  function add({ id, name, url, trusted = false } = {}) {
    if (!id && !url) throw new Error("add needs an id or a url");
    const key = String(id || `url:${url}`);
    if (banned.has(key)) throw new Error("that peer is banned; unban it first");
    let e = peers.get(key) || [...peers.values()].find((x) => url && x.url === url);
    if (!e) { e = newEntry({ id: key, name, url, source: "added", trusted }); peers.set(key, e); }
    else { e.source = "added"; e.trusted = !!trusted; if (url) e.url = url; if (name) e.name = clip(name, 80); }
    persist();
    return view(e);
  }
  function remove(id) {
    const gone = peers.delete(String(id));
    if (gone) persist();
    return gone;
  }
  function ban(id) {
    id = String(id);
    banned.add(id);
    peers.delete(id);
    persist();
  }
  function unban(id) { const r = banned.delete(String(id)); if (r) persist(); return r; }
  function setTrusted(id, trusted = true) {
    const e = peers.get(String(id));
    if (!e) return false;
    e.trusted = !!trusted;
    if (e.trusted) e.source = "added";
    persist();
    return true;
  }
  const list = () => [...peers.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(view);

  /** Forget discovered peers that have been silent past ttlMs. Added peers are never pruned. */
  function prune() {
    let n = 0;
    for (const [k, e] of peers) {
      if (e.source !== "discovered") continue;
      const ref = e.lastHeard ?? e.discoveredAt ?? 0;
      if (now() - ref >= cfg.ttlMs) { peers.delete(k); n++; }
    }
    return n;
  }

  /* -------------------------------------------------------------- hellos */
  function setLoad(load = {}) {
    me.load = { inflight: Math.max(0, num(load.inflight)), queue: Math.max(0, num(load.queue)), tokensPerSec: Math.max(0, num(load.tokensPerSec)) };
  }
  function setModels(models) { me.models = [...(models || [])]; }

  /** This instance's PeerHello@1. load.inflight includes jobs lent to peers. */
  function hello() {
    return {
      type: HELLO_TYPE, id: me.id, name: me.name, url: me.url, models: [...me.models], caps: { ...me.caps },
      load: { ...me.load, inflight: me.load.inflight + lent },
      privacyClass: me.privacy, ...(me.trustDomain ? { trustDomain: me.trustDomain } : {}),
      epoch: me.epoch, ts: now(),
    };
  }

  /** A hello arrived (from POST /hello or as the reply to ours). Returns {ok, reason?, peer?}. */
  function receiveHello(raw, { discover = true } = {}) {
    const n = normalizeHello(raw);
    if (!n.ok) return n;
    const h = n.hello;
    if (h.id === me.id) return { ok: false, reason: "self" };
    if (banned.has(h.id)) return { ok: false, reason: "banned" };
    let e = peers.get(h.id);
    if (!e && h.url) {
      // an operator added this peer by url before knowing its id: adopt the id
      const prov = [...peers.values()].find((x) => x.id.startsWith("url:") && x.url === h.url);
      if (prov) { peers.delete(prov.id); prov.id = h.id; peers.set(h.id, prov); e = prov; persist(); }
    }
    if (!e) {
      if (!discover) return { ok: false, reason: "unknown" };
      e = newEntry({ id: h.id, name: h.name, url: h.url, source: "discovered" });
      e.discoveredAt = now();
      peers.set(h.id, e);
    }
    if (e.epoch != null && h.epoch < e.epoch) return { ok: false, reason: "stale-epoch" }; // a replay of an older boot
    e.epoch = h.epoch;
    e.hello = h;
    e.name = h.name;
    // an operator-added url is never rewritten by what the peer says about itself
    if (e.source === "discovered" && h.url) e.url = h.url;
    e.lastHeard = now(); // OUR clock: the peer's ts is never compared
    return { ok: true, peer: view(e) };
  }

  /** An AbortController chained to the caller's signal. `unlink()` detaches it (the controller stays usable). */
  function linked(signal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(signal.reason);
    if (signal) { if (signal.aborted) ac.abort(signal.reason); else signal.addEventListener("abort", onAbort, { once: true }); }
    return { ac, unlink: () => signal?.removeEventListener?.("abort", onAbort) };
  }
  /** Race `promise` against a timer that aborts `ac` with a `timeout` error. */
  async function deadline(ms, ac, promise) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = timers.setTimeout(() => { const e = Object.assign(new Error(`no answer within ${ms}ms`), { code: "timeout" }); ac.abort(e); rej(e); }, ms);
    });
    try { return await Promise.race([promise, timeout]); } finally { timers.clearTimeout(t); }
  }
  const withDeadline = async (ms, signal, fn) => {
    const { ac, unlink } = linked(signal);
    try { return await deadline(ms, ac, Promise.resolve().then(() => fn(ac.signal))); } finally { unlink(); }
  };

  /** One heartbeat round: say hello to every known peer, bounded. A peer that does not answer is not
   *  convicted — its standing simply ages by the same bounds as liveness.js. Safe to call on any interval. */
  async function tick({ signal } = {}) {
    prune();
    if (!transport?.hello) return { sent: 0, heard: 0 };
    const targets = [...peers.values()].filter((e) => e.url && !banned.has(e.id));
    let heard = 0;
    await Promise.allSettled(targets.map(async (e) => {
      try {
        const reply = await withDeadline(cfg.helloTimeoutMs, signal, (s) => transport.hello(view(e), hello(), { signal: s, timeoutMs: cfg.helloTimeoutMs }));
        if (reply && receiveHello(reply, { discover: false }).ok) heard++;
      } catch { /* silence is not a verdict */ }
    }));
    return { sent: targets.length, heard };
  }

  /* ------------------------------------------------------------- breaker */
  function breakerState(e) {
    const b = e.breaker;
    if (!b.opened) return "closed";
    return now() < b.openUntil ? "open" : "half-open";
  }
  function successRate(e) { return (e.ok + 1) / (e.ok + e.fail + 2); } // Laplace, as route-stats.js (α=β=1)

  /** kind: error | timeout | auth | busy (+retryAfterMs). Aborts are the caller's choice and never recorded. */
  function recordFailure(id, { kind = "error", retryAfterMs = null } = {}) {
    const e = peers.get(String(id));
    if (!e) return;
    const b = e.breaker;
    b.probing = false;
    b.lastKind = kind;
    if (kind === "busy") {
      // a peer shedding load is not unreliable: honour its Retry-After, leave the record alone
      const wait = Math.min(retryAfterMs ?? cfg.cooldownBaseMs, cfg.retryAfterCapMs);
      b.opened = true;
      b.openUntil = now() + wait;
      return;
    }
    e.fail++;
    b.fails++;
    const immediate = kind === "timeout" || kind === "auth";
    if (immediate || b.fails >= cfg.failThreshold || b.opened) {
      b.opens++;
      b.opened = true;
      b.openUntil = now() + Math.min(cfg.cooldownBaseMs * 2 ** (b.opens - 1), cfg.cooldownCapMs);
    }
  }
  function recordSuccess(id, { ttftMs = null } = {}) {
    const e = peers.get(String(id));
    if (!e) return;
    e.ok++;
    e.breaker = { fails: 0, opens: 0, openUntil: 0, opened: false, probing: false, lastKind: null };
    if (Number.isFinite(ttftMs)) e.ttftMs = e.ttftMs == null ? ttftMs : 0.7 * e.ttftMs + 0.3 * ttftMs;
  }
  /** The Fold's own check refused the content: lowers the success rate, does not trip the breaker. */
  function recordRejected(id) { const e = peers.get(String(id)); if (e) e.fail++; }
  function begin(id) { const e = peers.get(String(id)); if (e) { e.inflight++; if (e.breaker.opened) e.breaker.probing = true; } }
  function end(id) { const e = peers.get(String(id)); if (e) { e.inflight = Math.max(0, e.inflight - 1); e.breaker.probing = false; } }

  /* ------------------------------------------------------------ selection */
  const heldBy = (hello, model) => (isAnyModel(model) ? hello.models.length > 0 : hello.models.some((m) => normModel(m) === normModel(model)));

  /** Why this entry may NOT take this job; null = eligible. Eligibility is decided before speed. */
  function whyNot(job, e, { exclude = [], hops = 0, origin = null } = {}) {
    if (hops >= MAX_HOPS) return "hop-limit";
    if (e.id === me.id) return "self";
    if (exclude.includes(e.id)) return "excluded";
    if (origin && e.id === origin) return "origin";
    if (e.banned || banned.has(e.id)) return "banned";
    const s = standingOfPeer(e, now());
    if (s !== "ready") return `standing:${s}`;
    const h = e.hello;
    if (!h) return "no-hello";
    // privacy wall — before model, caps and speed
    const privacy = PRIVACY_CLASSES.includes(job?.privacy) ? job.privacy : "local-raw"; // unknown fails closed
    if (privacy === "local-raw") {
      if (!e.trusted) return "privacy:not-on-allowlist";
      if (h.privacyClass !== "local-raw") return "privacy:peer-not-local-raw";
      if (me.trustDomain || h.trustDomain) { if (me.trustDomain !== h.trustDomain) return "privacy:trust-domain"; }
    }
    if (!heldBy(h, job?.model)) return "model";
    for (const r of job?.requires || []) {
      if (r === "tools" ? !h.caps.tools : r === "structured" ? !h.caps.structured : true) return `caps:${r}`;
    }
    if (num(job?.context) > 0 && h.caps.context < num(job.context)) return "caps:context";
    const b = breakerState(e);
    if (b === "open") return "cooling";
    if (b === "half-open" && e.breaker.probing) return "probing";
    return null;
  }

  function expectedMs(job, e) {
    const l = e.hello?.load || { inflight: 0, queue: 0, tokensPerSec: 0 };
    const tokens = num(job?.maxTokens, cfg.defaultTokens);
    const perJob = l.tokensPerSec > 0 ? (tokens / l.tokensPerSec) * 1000 : cfg.defaultJobMs;
    const wait = l.queue * perJob + (l.inflight > 0 ? perJob / 2 : 0);
    const ttft = e.ttftMs ?? cfg.defaultTtftMs;
    return (wait + ttft) / successRate(e);
  }

  /** Every peer with the reason it is out, or its expected time if it is in. For explanations and tests. */
  function candidates(job, ctx = {}) {
    return [...peers.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => {
      const why = whyNot(job, e, ctx);
      return why ? { id: e.id, eligible: false, why } : { id: e.id, eligible: true, expectedMs: expectedMs(job, e) };
    });
  }

  /** The eligible peer with the lowest expected time-to-accepted, or null. null means "use the floor". */
  function pickPeer(job, { exclude = [], hops = 0, origin = null, floorMs = null } = {}) {
    const ok = candidates(job, { exclude, hops, origin }).filter((c) => c.eligible);
    if (!ok.length) return null;
    ok.sort((a, b) => a.expectedMs - b.expectedMs || (a.id < b.id ? -1 : 1));
    const tied = ok.filter((c) => Math.abs(c.expectedMs - ok[0].expectedMs) < 1e-6);
    const best = tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))];
    if (floorMs != null && best.expectedMs >= floorMs) return null; // a peer must BEAT the floor to be worth the hop
    return { ...view(peers.get(best.id)), expectedMs: best.expectedMs };
  }

  /* --------------------------------------------------------------- forward */
  const forwardHeaders = ({ hops = 0, origin = null } = {}) => ({ [HOP_HEADER]: String(hops + 1), [ORIGIN_HEADER]: origin || me.id });

  /**
   * Run a job on the best peer, else on the floor. Resolves to { via: "peer"|"floor", peer?, stream }
   * once the decision is made (a peer has delivered its FIRST chunk, or the floor was chosen) — never
   * later than firstByteMs for a peer attempt. `fallback(job, signal)` is the caller's own floor.
   * hops/origin: pass the request context when serving a forwarded request; a hopped request is never re-forwarded.
   */
  async function run(job, { signal, fallback, hops = 0, origin = null, floorMs = null, firstByteMs = cfg.firstByteMs, attempts = cfg.maxAttempts } = {}) {
    const tried = [];
    for (let i = 0; i < attempts && transport?.call; i++) {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
      const pick = pickPeer(job, { exclude: tried, hops, origin, floorMs });
      if (!pick) break;
      tried.push(pick.id);
      const t0 = now();
      begin(pick.id);
      let stream;
      // the upstream signal lives as long as the stream does: the caller aborting, or simply ceasing to read, cancels the peer
      const { ac, unlink } = linked(signal);
      try {
        stream = await deadline(firstByteMs, ac, Promise.resolve().then(() => transport.call(pick, job, { signal: ac.signal, firstByteMs, headers: forwardHeaders({ hops, origin }) })));
      } catch (err) {
        unlink(); ac.abort(err);
        end(pick.id);
        if (signal?.aborted) throw err; // the caller gave up: not the peer's fault
        if (err?.code === "abort") throw err;
        recordFailure(pick.id, { kind: err?.code === "timeout" ? "timeout" : err?.code === "busy" || err?.status === 429 ? "busy" : err?.code === "auth" ? "auth" : "error", retryAfterMs: err?.retryAfterMs ?? null });
        continue;
      }
      const ttftMs = now() - t0;
      return { via: "peer", peer: pick, stream: guard(pick.id, stream, ttftMs, signal, ac, unlink) };
    }
    if (!fallback) throw Object.assign(new Error("no peer could take this job and no fallback was given"), { code: "no-route" });
    return { via: "floor", peer: null, stream: toStream(fallback(job, signal)) };
  }

  async function* guard(id, stream, ttftMs, signal, ac, unlink) {
    try {
      for await (const c of stream) yield c;
      recordSuccess(id, { ttftMs });
    } catch (err) {
      if (!signal?.aborted && err?.code !== "abort") recordFailure(id, { kind: "error" });
      throw err;
    } finally { end(id); unlink(); ac.abort(); }
  }

  /* --------------------------------------------------------------- lending */
  /**
   * May this instance serve a forwarded request? Called by the transport's handler BEFORE running it.
   * Returns { ok: true, release } or { ok: false, status, reason, retryAfterMs? }. Nothing here forwards.
   */
  function admitInbound(job, { hops, origin } = {}) {
    const refuse = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });
    const h = Number(hops);
    if (!Number.isInteger(h) || h < 1) return refuse(400, "no-hop-header");
    if (h > MAX_HOPS) return refuse(508, "hop-limit");
    if (!origin) return refuse(400, "no-origin");
    if (origin === me.id) return refuse(508, "loop");
    if (banned.has(origin)) return refuse(403, "banned");
    if (!me.lend) return refuse(403, "not-lending");
    if (!job || typeof job !== "object") return refuse(400, "no-job");
    if (job.privacy !== undefined && !PRIVACY_CLASSES.includes(job.privacy)) return refuse(400, "bad-privacy");
    const privacy = job.privacy ?? "local-raw";
    if (privacy === "local-raw") {
      const e = peers.get(origin);
      const sameDomain = !me.trustDomain && !e?.hello?.trustDomain ? true : me.trustDomain === e?.hello?.trustDomain;
      if (me.privacy !== "local-raw" || !e || !e.trusted || !sameDomain) return refuse(403, "privacy-wall");
    }
    if (!isAnyModel(job.model) && !me.models.some((m) => normModel(m) === normModel(job.model))) return refuse(404, "model-not-held");
    for (const r of job.requires || []) {
      if (r === "tools" ? !me.caps.tools : r === "structured" ? !me.caps.structured : true) return refuse(422, `caps:${r}`);
    }
    if (me.load.inflight + lent >= cfg.lendBelow) return refuse(429, "busy", { retryAfterMs: cfg.shedRetryMs });
    lent++;
    let done = false;
    return { ok: true, release() { if (!done) { done = true; lent = Math.max(0, lent - 1); } } };
  }

  const status = () => ({ self: hello(), lent, peers: list() });

  return {
    self: me, cfg,
    hello, receiveHello, tick, setLoad, setModels,
    add, remove, ban, unban, setTrusted, list, prune, status,
    pickPeer, candidates, run, forwardHeaders, admitInbound,
    recordSuccess, recordFailure, recordRejected, begin, end,
    standing: (id) => standingOfPeer(peers.get(String(id)), now()),
    breaker: (id) => (peers.has(String(id)) ? breakerState(peers.get(String(id))) : null),
    lentCount: () => lent,
  };
}
