// engine-share.js — one WebLLM engine per browser, however many heimdall tabs are open (2026-10).
//
// WebLLM keeps its weights in the browser's Cache Storage, so the DOWNLOAD already happens once per browser. What did not
// happen once was the ENGINE: every tab that accepted duty built its own (CreateMLCEngine → its own copy of the weights in GPU
// memory, its own compile), and two tabs on a phone or a laptop is how a device falls over.
//
// SharedEngine is a drop-in for WorkerEngine (same surface: load, loaded, modelId, pending, contextWindow, infer) that makes the
// browser's tabs elect ONE host:
//
//   host    the tab that wins the Web Lock `heimdall-webllm-engine` builds the one real engine and holds the lock for as long as
//           it lives. It answers every other tab's inference requests over a BroadcastChannel and streams tokens back.
//   client  every other tab loads nothing. It asks the host what is loaded, adopts that model id (the weights actually loaded,
//           never the picker), and proxies infer() to the host. Its `pending` is its own in-flight work plus the host's backlog.
//   promotion  when the host tab closes, the browser releases the lock and the next waiting client wins it and builds the engine.
//           The weights are already in Cache Storage, so this is a load, not a second download. Requests that were in flight on
//           the dead host fail with a typed error; nothing is silently retried (a generation may have been half-delivered).
//
// A tab never steals: a lock held by a host that does not answer is an error, not a takeover. Where the browser has no Web Locks
// or BroadcastChannel (or the page is not a secure context), SharedEngine degrades to a plain per-tab engine — the old behaviour,
// stated in `mode`.
//
// Pure of the DOM: the locks, the channel factory, the engine factory and the clock are injected (engine-share.test.mjs).

const LOCK = "heimdall-webllm-engine";
const CHANNEL = "heimdall-webllm-engine";
const HELLO_TIMEOUT_MS = 8000;

let seq = 0;
const newId = () => `${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class SharedEngine {
  /**
   * @param {object} o
   * @param {(p:any)=>void} [o.onProgress]
   * @param {(onProgress:Function)=>object} o.makeEngine   builds the real engine (a WorkerEngine)
   * @param {object|null} [o.locks]                         navigator.locks (null → no sharing)
   * @param {(name:string)=>object|null} [o.channelFactory] new BroadcastChannel (null → no sharing)
   */
  constructor({ onProgress, makeEngine, locks = globalThis.navigator?.locks ?? null, channelFactory = typeof BroadcastChannel === "function" ? (n) => new BroadcastChannel(n) : null, helloTimeoutMs = HELLO_TIMEOUT_MS, heartbeatMs = 2000 } = {}) {
    if (typeof makeEngine !== "function") throw new Error("SharedEngine needs makeEngine");
    this.onProgress = onProgress || (() => {});
    this.makeEngine = makeEngine;
    this.locks = locks;
    this.channelFactory = channelFactory;
    this.helloTimeoutMs = helloTimeoutMs;
    this.heartbeatMs = heartbeatMs;   // while the host loads it says so this often, so a silent GPU compile is not mistaken for a dead host
    this.me = newId();
    this.role = null;                 // "host" | "client" | null (not decided yet)
    this.mode = locks && channelFactory ? "shared" : "per-tab";
    this.real = null;                 // the engine, host only
    this.wanted = null;               // the model this tab last asked for (used if it is promoted)
    this.remote = { loaded: false, modelId: null, pending: 0, ctx: null };   // what the host last said
    this.own = 0;                     // this tab's in-flight proxied requests
    this.waiting = new Map();         // request id → { resolve, reject, onToken }
    this.channel = null;
    this._release = null;
    this._deciding = null;
    this._stateWaiters = [];
  }

  // ── the WorkerEngine surface ──
  get loaded() { return this.role === "host" ? !!this.real?.loaded : this.role === "client" ? this.remote.loaded : false; }
  get modelId() { return this.role === "host" ? this.real?.modelId ?? null : this.role === "client" ? this.remote.modelId : null; }
  get contextWindow() { return this.role === "host" ? this.real?.contextWindow ?? null : this.remote.ctx; }
  get pending() { return this.role === "host" ? this.real?.pending ?? 0 : this.own + (this.remote.pending || 0); }
  /** The underlying engine object while this tab hosts it, else a marker (code that only checks truthiness keeps working). */
  get engine() { return this.role === "host" ? this.real?.engine ?? null : this.role === "client" ? "shared" : null; }

  async load(modelId) {
    this.wanted = modelId ?? this.wanted;
    if (this.mode === "per-tab") return this._hostOnly(modelId);
    await this._decide();
    if (this.role === "host") return this._hostLoad(modelId);
    await this._waitLoaded();
  }

  infer(messages, opts = {}, onToken) {
    if (this.role === "host") return this.real.infer(messages, opts, onToken);
    if (this.role !== "client") return Promise.reject(new Error("model not loaded"));
    const id = newId();
    this.own++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onToken });
      this.channel.postMessage({ type: "infer", id, from: this.me, messages, opts: { stream: opts.stream ?? true, temperature: opts.temperature, max_tokens: opts.max_tokens } });
    }).finally(() => { this.own = Math.max(0, this.own - 1); });
  }

  /** Let go: a host releases the lock (a waiting tab is promoted) and unloads. */
  async close() {
    this.channel?.close?.();
    this.channel = null;
    const r = this._release; this._release = null;
    for (const w of this.waiting.values()) w.reject(new Error("this tab closed the shared engine"));
    this.waiting.clear();
    await this.real?.engine?.unload?.().catch?.(() => {});
    this.real = null; this.role = null; this._deciding = null;
    r?.();
  }

  // ── electing a host ──
  async _hostOnly(modelId) { this.role = "host"; this.real ??= this.makeEngine((p) => this.onProgress(p)); return this.real.load(modelId); }

  _decide() {
    if (this.role) return Promise.resolve();
    this._deciding ??= (async () => {
      this.channel = this.channelFactory(CHANNEL);
      this.channel.onmessage = (e) => this._onMessage(e.data);
      const won = await this._acquire({ wait: false });
      if (won) { this._becomeHost(); return; }
      this.role = "client";
      this.channel.postMessage({ type: "hello", from: this.me });
      // queue for promotion: when the host's tab goes away the browser hands this tab the lock
      this._acquire({ wait: true }).then((got) => { if (got && this.role === "client") this._promote(); });
    })();
    return this._deciding;
  }

  /** Try for the lock. `wait:false` resolves false at once if another tab holds it; `wait:true` resolves true when it is handed over. */
  _acquire({ wait }) {
    return new Promise((resolve) => {
      const grant = (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((release) => { this._release = release; });   // held until close() or the tab dies
      };
      Promise.resolve(this.locks.request(LOCK, wait ? {} : { ifAvailable: true }, grant)).catch(() => resolve(false));
    });
  }

  _becomeHost() {
    this.role = "host";
    this.real ??= this.makeEngine((p) => { this.onProgress(p); this.channel?.postMessage({ type: "progress", from: this.me, p }); });
    this._announce();
  }

  async _promote() {
    this._becomeHost();
    for (const w of this.waiting.values()) w.reject(Object.assign(new Error("the shared engine's host tab went away"), { beforeFirstToken: false, hostLost: true }));
    this.waiting.clear();
    this.remote = { loaded: false, modelId: null, pending: 0, ctx: null };
    if (this.wanted) { try { await this._hostLoad(this.wanted); } catch { /* the caller's next load() reports it */ } }
  }

  async _hostLoad(modelId) {
    const hb = setInterval(() => this._announce(), this.heartbeatMs);
    try {
      await this.real.load(modelId ?? this.wanted);
      clearInterval(hb);
      this._announce();
    } catch (e) {
      clearInterval(hb);
      // this device cannot run it: give the lock back so another tab (maybe with a working GPU) can try
      const r = this._release; this._release = null; this.role = null; this._deciding = null; this.real = null;
      r?.();
      throw e;
    }
  }

  _announce() {
    this.channel?.postMessage({ type: "state", from: this.me, loaded: !!this.real?.loaded, modelId: this.real?.modelId ?? null, pending: this.real?.pending ?? 0, ctx: this.real?.contextWindow ?? null });
  }

  /** Wait for the host to report a loaded model. The only timeout is SILENCE: a host that is downloading keeps sending progress, so
   *  a long first download is never mistaken for a dead host; a lock held by a tab that says nothing at all is an error. */
  _waitLoaded() {
    if (this.remote.loaded) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => { clearTimeout(waiter.t); resolve(); }, reject: (e) => { clearTimeout(waiter.t); reject(e); } };
      waiter.arm = () => { clearTimeout(waiter.t); waiter.t = setTimeout(() => { this._stateWaiters = this._stateWaiters.filter((w) => w !== waiter); reject(new Error("another tab holds the shared engine but went silent")); }, this.helloTimeoutMs); };
      waiter.arm();
      this._stateWaiters.push(waiter);
    });
  }

  // ── the wire ──
  _onMessage(m) {
    if (!m || m.from === this.me) return;
    if (this.role === "host") {
      if (m.type === "hello") return this._announce();
      if (m.type === "infer") return this._serve(m);
      return;
    }
    if (this.role !== "client") return;
    if (m.type === "state") {
      this.remote = { loaded: !!m.loaded, modelId: m.modelId ?? null, pending: m.pending ?? 0, ctx: m.ctx ?? null };
      if (m.loaded) { const ws = this._stateWaiters; this._stateWaiters = []; for (const w of ws) w.resolve(); } else for (const w of this._stateWaiters) w.arm();
    } else if (m.type === "progress") { this.onProgress(m.p); for (const w of this._stateWaiters) w.arm(); }
    else if (m.to === this.me) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      if (m.type === "token") w.onToken?.(m.t);
      else { this.waiting.delete(m.id); if (m.type === "done") w.resolve(m.result); else w.reject(Object.assign(new Error(m.message || "the shared engine failed"), { beforeFirstToken: !!m.beforeFirstToken })); }
    }
  }

  async _serve(m) {
    let tokens = 0;
    try {
      const result = await this.real.infer(m.messages, m.opts || {}, (t) => { tokens++; this.channel?.postMessage({ type: "token", id: m.id, to: m.from, from: this.me, t }); });
      this.channel?.postMessage({ type: "done", id: m.id, to: m.from, from: this.me, result });
    } catch (e) {
      this.channel?.postMessage({ type: "fail", id: m.id, to: m.from, from: this.me, message: String(e?.message || e), beforeFirstToken: tokens === 0 });
    }
    this._announce();
  }
}
