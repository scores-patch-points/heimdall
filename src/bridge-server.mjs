// bridge-server.mjs — the fleet, seen from this computer as one more Ollama.
//
// `heimdall up` runs this. It does three things on 127.0.0.1:
//   1. serves the heimdall page (dist/), so the controller tab is same-origin
//      with the bridge and nothing crosses a CORS wall;
//   2. speaks Ollama's API (/api/chat, /api/generate, /api/tags, /api/ps,
//      /api/version) and OpenAI's (/v1/chat/completions, /v1/models), so
//      eoreader7 — or anything that takes an Ollama URL — can send inference
//      to a phone by adding one host: ER7_OLLAMA_HOSTS="…,fleet=http://localhost:8790";
//   3. carries each request to the controller tab (server-sent events down,
//      POSTs up), where the fleet's own router picks a phone, and streams the
//      tokens back in Ollama's shape.
//
// What the fleet cannot serve, it passes through to the real Ollama
// (upstream) untouched: a model no phone holds, a request with a JSON
// grammar / tools / images, no controller tab open, or a phone that fails
// before its first token (a prompt longer than the phone's window fails
// there, and is answered here instead — measured by the phone, not guessed).
// Nothing is ever answered by a different model than the one asked for.
//
// /api/ps lists only what a phone holds right now, so a caller's resident-first
// picker sees the phone as hot only for the models it truly has. The phone's
// context window is reported as `heimdall.context_window`, not `context_length`:
// eoreader7's same-shape rule exists to stop Ollama reloads, which cannot
// happen on a phone; overflow is handled by the fall-through above. Each
// model's `heimdall.queueDepth` (and /status's `pending`) is real
// backpressure, not an optimistic zero: WorkerEngine has no parallelism, so
// a caller ranking hosts by expected wait needs to see a busy fleet as busy.
//
// If zero controller tabs are connected for more than a few seconds, the
// bridge tries to open one itself (autoOpen, on by default) — the same
// reasoning as the pidfile lock in bin/heimdall.mjs: a fleet nobody can
// reach is worse than one that tries to fix itself.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLedger, parseWorlds } from "./audit.js";
import { isHostedOpen, HOSTED_OPEN } from "./hosted.js";
import { createCompetence, plan as planDispatch, messagesTokens, priceOf, bucketOf, bucketLabel } from "./competence.js";
import { exec } from "node:child_process";
import { answers, normalizeTag, ollamaTagOf } from "./models.js";
import {
  loadLinks, saveLinks, upsertLink, removeLink, probeEndpoint,
  guessTag, resolveLink, linkAdvertisedModels, normalizeUrl, isMetadataHost, LINK_SKIP_MS, DEFAULT_LINKS_FILE,
} from "./links.mjs";
import { inferOn } from "./remote.js";
import { record as dispatchRecord, meter as dispatchMeter, ESTIMATE_COSTS } from "./dispatch.js";
import { code as opencodeCode } from "./opencode-lane.js";
import { createJobLane } from "./job-lane.js";
import { createRouteStats, DEFAULT_STATS_FILE } from "./route-stats.js";
import { makeSearcher, fetchPage } from "./websearch.js";

// The tab posts its state every 5 s — but a hidden tab's timers are throttled
// to about once a minute, so the bridge also pings over the open event stream
// (an event handler, which is not throttled) and the tab answers with its
// state. Fresh = heard within this long.
// The open stream itself is the liveness (the browser closes it with the
// tab); the posted state only has to be recent enough to trust its list of
// ready phones, and a throttled tab still posts once a minute.
const TAB_FRESH_MS = 45_000; // the bridge pings every PING_MS and the tab answers with its state, so 45 s of silence means gone
const PING_MS = 10_000;
const FIRST_TOKEN_MS = 180_000; // a phone's cold first token (model already loaded) — then fall through
const IDLE_MS = 120_000; // silence mid-stream this long ends the job
const MAX_BODY_BYTES = 8 * 1024 * 1024; // every JSON route; /api/read may take more (attachments)
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024; // the controller tab's own posts are small
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]); // the only Host values that may reach the bridge (DNS rebinding)
const UPSTREAM_STEPDOWN = new Set([502, 429, 403, 508, 503, 504]); // an upstream's answer that, BEFORE any byte, moves on to the next upstream
const FORWARD_HEADERS = /^(retry-after|x-queue-position|x-heimdall-.*)$/i; // the only upstream response headers that ride through
const MAX_FAILED_ENTRIES = 200; // failed-rung ledger entries kept; the whole dispatch ledger is capped at 2000

/** The route table, as `METHOD /path` (kept beside the switch in route_; a test fails if a route here is answered 404). Other /api/ and /v1/ paths are piped to the floor; other GETs serve the page. */
const ROUTES = Object.freeze(["POST /api/dispatch/plan", "POST /api/dispatch/observe", "GET /api/dispatch/competence", "GET /api/audit", "GET /bridge/hello", "GET /bridge/events", "POST /bridge/state", "POST /bridge/reply", "GET /bridge/upstream/tags", "POST /bridge/upstream/chat", "GET /status", "GET /link", "GET /link/", "GET /link/hosts", "POST /link/probe", "POST /link/host", "POST /link/remove", "GET /api/version", "GET /api/ps", "GET /api/tags", "POST /api/chat", "POST /api/generate", "POST /v1/chat/completions", "POST /v1/messages", "POST /api/race", "GET /v1/models", "POST /api/job", "GET /api/route-stats", "GET /api/ledger", "GET /api/meter", "GET /api/frontier", "GET /api/providers/keys", "POST /api/providers/refresh", "POST /api/providers/check", "POST /api/providers/keys", "GET /api/code/status", "POST /api/code", "POST /api/weave", "GET /api/search", "GET /api/page", "POST /api/read", "POST /api/reason", "POST /api/agent"]);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const escapeHtml = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeEqual = (a, b) => { const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? "")); return x.length === y.length && timingSafeEqual(x, y); };
const parseCookies = (h) => Object.fromEntries(String(h || "").split(";").map((c) => { const i = c.indexOf("="); return i < 0 ? null : [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }).filter(Boolean));

// Nobody home: zero SSE tabs connected (not merely stale — actually none).
// Give a person, or `heimdall up`'s own opener, this long before the bridge
// tries for itself; then don't retry more than once per cooldown, so a tab
// someone closed on purpose doesn't get reopened out from under them every
// few seconds.
const NO_TAB_GRACE_MS = 8_000;
const NO_TAB_REOPEN_COOLDOWN_MS = 2 * 60_000;
const NO_TAB_CHECK_MS = 5_000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

// A running `opencode serve` may require HTTP basic auth (the desktop app sets
// OPENCODE_SERVER_USERNAME/PASSWORD). The bridge must present those creds on
// every call to the machine door — otherwise the door answers 401. When no
// creds are set, this is a plain fetch.
function defaultOpencodeFetch(url, init = {}) {
  const user = process.env.OPENCODE_SERVER_USERNAME;
  const pass = process.env.OPENCODE_SERVER_PASSWORD;
  if (!user && !pass) return fetch(url, init);
  const auth = "Basic " + Buffer.from(`${user ?? ""}:${pass ?? ""}`).toString("base64");
  return fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: auth } });
}

// The CLI's state file (`heimdall key` writes providerKeys here). The bridge
// reads and writes the SAME file so a key entered through the surface lands
// exactly where the CLI puts it — on this machine, never in a browser.
const STATE_FILE = path.join(os.homedir(), ".heimdall", "state.json");
function readState(file = STATE_FILE) { try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (e) { return {}; } }
function writeState(s, file = STATE_FILE) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(s, null, 2)); }
const LOOPBACK_ADDR = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

export function createBridge({
  port = 8790,
  host = "127.0.0.1",
  dist,
  upstream = "http://127.0.0.1:11434",
  // The floor, in order (rung 4). Default: just `upstream`. `heimdall up` adds the direct Ollama (:11435) beside khora's channel (:11434)
  // after probing both (floor.js). A step-down to the next happens only BEFORE any byte reaches the caller.
  upstreams = null,
  laneSlots = {}, // provider -> requests we send at once (default: HOSTED_OPEN slots for the small hosted providers; others unbounded)
  upstreamFirstByteMs = 30_000, // an upstream that has not answered by now (streaming requests) is skipped
  upstreamTimeoutMs = 120_000, // total bound on one upstream call
  prefix = "", // mount point when the bridge's handler sits inside another server ("/heimdall"); "" = it owns the whole origin
  tokenFile = process.env.HEIMDALL_TOKEN_FILE || null, // per-boot access token, written 0600 (bin/heimdall.mjs passes ~/.heimdall/bridge.token); null = memory only
  token = null, // inject a token (tests / an embedding server); default is generated at start
  allowedHosts = [], // extra Host names that may reach the bridge (besides localhost/127.0.0.1/[::1])
  maxBodyBytes = MAX_BODY_BYTES,
  maxReadBytes = MAX_READ_BYTES,
  maxTabs = 8,
  maxJobs = 64,
  maxCodeArtifacts = 200,
  maxCompetenceCells = 5000,
  tabFreshMs = TAB_FRESH_MS,
  linkFirstByteMs = 10_000,
  linkSkipMs = LINK_SKIP_MS,
  frontierFirstByteMs = 15_000,
  frontierTimeoutMs = 120_000,
  breaker = {}, // { downMs, rateLimitMs } circuit breaker per executor; false = off
  keylessExternal = false, // keep probing the keyless external providers when frontier is refreshed
  readUrl = process.env.ER7_READ_URL || process.env.KHORA_READ_URL || "http://127.0.0.1:11436/v1/read",
  passthrough = true,
  site = "https://scores-patch-points.github.io/heimdall/",
  lendModel = null,
  autoOpen = false, // try to open a controller tab ourselves when none is connected (`heimdall up` turns it on; an embedded bridge never opens a browser)
  linksFile = DEFAULT_LINKS_FILE,
  frontierExecutors = [], // discovered credentialed providers (discovery.js discoverAll); keys live on this machine
  allowedOrigins = [], // extra page origins allowed to talk to the bridge (e.g. the fold's GitHub Pages origin); never "*"
  stateFile = STATE_FILE, // where `heimdall key` stores providerKeys (injectable for tests)
  routeStatsFile = DEFAULT_STATS_FILE, // per route × taskClass accept rates for POST /api/job (injectable; null = memory only)
  jobRoutes = null, // test seam: (form) => routes for POST /api/job; null builds them from the live lanes
  extraJobRoutes = null, // (form) => extra routes appended to the live ones (e.g. a remote reached through ANOTHER bridge)
  frontierFetch = fetch,
  // The measured-competence table the dispatcher plans from (competence.js). Persisted so what was learned survives a restart.
  competenceFile = path.join(os.homedir(), ".heimdall", "competence.json"),
  competence = null,
  listLocalModels = null, // () => [{ name, ctxWindow? }] — injectable for tests; default asks the upstream Ollama
  // The outbound ledger: where every outside-model request is recorded, exactly
  // as sent (null = memory only). See audit.js.
  auditFile = path.join(os.homedir(), ".heimdall", "outbound-ledger.ndjson"),
  opencodeUrl = process.env.HEIMDALL_OPENCODE || process.env.OPENCODE_URL || null, // a running `opencode serve` — the machine door for coding
  opencodeFetch = defaultOpencodeFetch,
  // The generation door — penelope's weave over HTTP (the mouth server hosts
  // /api/weave). The fold surfaces' generate lane rides this route; penelope
  // owns generation, the bridge only routes (the /api/read pattern).
  weaveUrl = process.env.PENELOPE_WEAVE_URL || "http://127.0.0.1:11439/api/weave",
  // The khora engine proxy — the perceiver. /api/read, /api/reason (janus's
  // reasoning check) and /api/agent (the open coding loop) all ride it. The
  // bridge only routes; the khora owns reading and the loop (the /api/weave
  // pattern). Derived from the read URL when only that is configured.
  khoraUrl = process.env.KHORA_URL || (process.env.ER7_READ_URL || process.env.KHORA_READ_URL ? new URL(process.env.ER7_READ_URL || process.env.KHORA_READ_URL).origin : "http://127.0.0.1:11436"),
  log = () => {},
} = {}) {
  // The caller going away (the browser's Stop, a closed tab) cancels the work it
  // started: a long machine-door job must not keep a local model busy for a
  // person who has already left. Joined with the route's own deadline.
  const goneOr = (res, ms) => {
    const ac = new AbortController();
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    return AbortSignal.any([ac.signal, AbortSignal.timeout(ms)]);
  };

  // The floor, in order. A caller's own `upstream` is always first.
  const upstreamList = (Array.isArray(upstreams) && upstreams.length ? upstreams : [upstream]).map((u) => String(u).replace(/\/+$/, ""));
  // THE PER-BOOT ACCESS TOKEN. Bridge-only routes (/bridge/*, mutating /link/*, /api/code, /api/providers/*, /api/dispatch/observe) need
  // it: the page gets it as a cookie from its own origin, a local tool reads it from the token file. Nothing else can drive them.
  const accessToken = token || randomBytes(32).toString("hex");
  if (tokenFile) {
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenFile, accessToken + "\n", { mode: 0o600 });
      fs.chmodSync(tokenFile, 0o600);
    } catch (e) { log("could not write the access token file: " + e.message); }
  }
  const cookiePath = prefix || "/";

  const tabs = new Set(); // open SSE responses; the newest one is the controller
  let state = null; // last state the tab posted
  let stateAt = 0;
  const jobs = new Map(); // id -> { onMsg }
  const codeArtifacts = new Map(); // ses_ -> { code, task } — the code lane's per-session record (iteration via the record); bounded
  const rememberCode = (id, v) => { codeArtifacts.delete(id); codeArtifacts.set(id, v); while (codeArtifacts.size > maxCodeArtifacts) codeArtifacts.delete(codeArtifacts.keys().next().value); };
  const stats = { fleet: 0, passthrough: 0, fellThrough: 0, native: 0, frontier: 0, frontierRefused: 0, code: 0 };
  // THE OUTBOUND LEDGER. Every request this bridge makes to an outside model is
  // opened here BEFORE it leaves and closed when it answers, so what was sent is
  // a fact the bridge holds, not a claim a surface makes. The surface's audit id
  // and world-set slot ride in on x-fold-audit / x-fold-worlds (request-scoped).
  const ledger = createLedger({ file: auditFile });
  const callCtx = new AsyncLocalStorage();
  const auditedFetchFor = (ex, box = {}) => async (url, opts = {}) => {
    const ctx = callCtx.getStore() || {};
    const h = ledger.open({
      url, method: opts.method || "POST", headers: opts.headers, body: opts.body ?? "",
      provider: ex.provider, model: ex.model, executor: `${ex.provider}:${ex.model}`, privacy: "sealed-external",
      auditId: ctx.auditId || null, worlds: ctx.worlds || null, route: ctx.route || null, caller: ctx.caller || null,
    });
    box.handle = h;
    try { const r = await frontierFetch(url, opts); h.close({ status: r.status }); return r; }
    catch (e) { h.close({ error: e?.message || e }); throw e; }
  };
  // ---- DISPATCH BY MEASURED COMPETENCE. Surfaces ask for a PLAN (a ladder of models) for a job of a given
  // size and privacy, run it, and report the outcome back; heimdall learns which model passes which kind of
  // step at which size, and plans from that. Nothing is assumed: an unmeasured model is explored, not trusted.
  const comp = competence || createCompetence();
  if (!competence && competenceFile) { try { comp.load(JSON.parse(fs.readFileSync(competenceFile, "utf8"))); } catch { /* first run */ } }
  const saveComp = () => { if (competenceFile && !competence) { try { fs.mkdirSync(path.dirname(competenceFile), { recursive: true }); fs.writeFileSync(competenceFile, JSON.stringify(comp.toJSON())); } catch {} } };
  let localCache = { at: 0, list: [] };
  const localModels = async () => {
    if (listLocalModels) return listLocalModels();
    if (Date.now() - localCache.at < 30000) return localCache.list;
    try { const j = await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(2500) })).json(); localCache = { at: Date.now(), list: (j.models || []).filter((m) => !/embed/i.test(m.name)).map((m) => ({ name: m.name, ctxWindow: m.details?.context_length || 8192 })) }; } catch { localCache.at = Date.now(); }
    return localCache.list;
  };
  // A model that answered 429 twice in the last minute is throttled: the ledger says so, not a guess.
  const throttled = (model) => ledger.list({ since: 0, limit: 500 }).entries.filter((e) => (e.model === model) && e.response?.status === 429 && Date.now() - Date.parse(e.at) < 60000).length >= 2;
  const dispatchCandidates = async () => {
    const out = [], seen = new Set();
    for (const m of await localModels()) if (!seen.has(m.name)) { seen.add(m.name); out.push({ model: m.name, tier: "local", ...priceOf(m.name, "local"), ctxWindow: m.ctxWindow }); }
    for (const [name, ex] of frontierMap) {
      if (name.includes(":") && frontierMap.get(ex.model) === ex) continue;   // list each executor once, under its bare name
      if (seen.has(name)) continue; seen.add(name);
      const credentialed = ex.authClass === "api_key" || !!ex.auth?.apiKey;
      // small hosted open models are cheap and counted as open-remote, not frontier
      const hosted = credentialed && isHostedOpen(ex.provider);
      const tier = hosted ? "hosted" : credentialed ? "frontier" : "remote";
      out.push({ model: name, tier, ...(hosted ? { usdInPerM: HOSTED_OPEN[ex.provider].usdInPerM, usdOutPerM: HOSTED_OPEN[ex.provider].usdOutPerM } : priceOf(name, tier)), ctxWindow: ex.contextWindow || 128000, healthy: !throttled(ex.model) && !isDown(ex) });
    }
    return out;
  };

  let links = loadLinks(linksFile); // native app servers linked by hand or the page

  // Frontier executors (provider keys configured server-side — `heimdall key`,
  // HEIMDALL_KEY_*). Each answers its model id and `provider:model`. They are
  // SEALED-ONLY: a request reaches them only when the caller marks the body
  // `heimdall_privacy: "sealed-external" | "explicit"` — never raw by default.
  // A bare model name ("claude-sonnet-5") can be offered by more than one provider — the vendor's
  // own credentialed lane and a third-party keyless proxy. The one the person configured a key for
  // MUST win: last-writer-wins silently sent a bare name to a proxy (measured 2026-10-05, caught by
  // the outbound ledger). Rank: credentialed first-party > credentialed > keyless. `provider:model`
  // names are unambiguous and always set.
  const lanePriority = (ex) => (ex.authClass === "api_key" || ex.auth?.apiKey ? (/^(anthropic|openai|google|groq|mistral|cohere|xai)$/i.test(ex.provider) ? 3 : 2) : 1);
  const setFrontier = (map, ex) => {
    map.set(`${ex.provider}:${ex.model}`, ex);
    const cur = map.get(ex.model);
    if (!cur || lanePriority(ex) > lanePriority(cur)) map.set(ex.model, ex);
  };
  const frontierMap = new Map(); // served model name -> executor record
  for (const ex of frontierExecutors || []) {
    if (!ex?.model || !ex?.endpoint) continue;
    setFrontier(frontierMap, ex);
  }
  // Re-run discovery against the CURRENT server-side keys and rebuild the
  // frontier map, so a key just stored through the surface takes effect without
  // restarting `heimdall up`. Returns the number of reachable models, or -1 on
  // a discovery failure (the key is still stored; the map just stays as it was).
  // A transient failed probe must never EMPTY the frontier (measured live: a valid
  // key + one failed probe = configured:false): the map is swapped only when the new
  // discovery found something; otherwise the previous executors stay, marked stale.
  // A provider whose key was REMOVED is the exception: it is dropped, stale or not.
  // Refreshes run ONE AT A TIME, each reading the keys as they are when it starts: three keys saved in quick succession
  // used to race, and an older discovery that finished last swapped in a map without the newest provider (measured in the
  // Fold's Settings 2026-10-06: DeepInfra loaded, then vanished).
  let refreshChain = Promise.resolve();
  function refreshFrontier() {
    const run = refreshChain.then(refreshFrontierNow, refreshFrontierNow);
    refreshChain = run.catch(() => {});
    return run;
  }
  async function refreshFrontierNow() {
    try {
      const { discoverAll } = await import("./discovery.js");
      const { loadProviderKeys } = await import("./providers.js");
      const keys = loadProviderKeys({ state: readState(stateFile) });
      const keyed = new Set(Object.keys(keys || {}));
      const discovered = await discoverAll({ config: { providers: keys, keylessExternal }, browser: false }, { fetchImpl: frontierFetch });
      const next = new Map();
      let n = 0;
      for (const ex of discovered) {
        if (!(ex?.live?.reachable && ex.location === "external" && ex.model && ex.endpoint)) continue;
        setFrontier(next, ex);
        n++;
      }
      const credentialed = (ex) => ex.authClass === "api_key" || !!ex.auth?.apiKey;
      const fresh = new Set([...next.values()]);
      const freshProviders = new Set([...fresh].map((ex) => ex.provider));
      // keep what a failed probe could not re-prove: same provider still keyed (or keyless and still wanted), not re-found this time
      const kept = [];
      for (const ex of new Set(frontierMap.values())) {
        if (freshProviders.has(ex.provider)) continue;
        if (credentialed(ex) && !keyed.has(ex.provider)) continue; // its key was removed: gone, not stale
        ex.live = { ...(ex.live || {}), stale: true, lastError: "the last refresh could not re-verify this lane; keeping what worked before" };
        kept.push(ex);
      }
      if (n === 0 && !kept.length) { frontierMap.clear(); return 0; }
      frontierMap.clear();
      for (const [k, v] of next) frontierMap.set(k, v);
      for (const ex of kept) setFrontier(frontierMap, ex);
      return n;
    } catch (e) { log("frontier refresh failed: " + e.message); return -1; }
  }
  const isFrontier = (model) => !!model && frontierMap.has(model);
  // The model names this running bridge offers for one provider (what it has LOADED, not what is merely stored).
  const providerModelsLoaded = (p) => [...new Set([...frontierMap.values()].filter((ex) => ex.provider === p).map((ex) => ex.model))];
  // A key was just added (or re-tested): test it live, store it unless the provider rejected it, reload the lanes, and answer
  // in plain words. The key itself is never in the response, the log, or the ledger — only its masked tail.
  // Key changes run ONE AT A TIME. Each reads the state file, waits on a live check, then writes it back, so two saved at
  // once used to lose a key (the last writer overwrote the others: three Saves in a row left one key stored).
  let keyChain = Promise.resolve();
  const exclusive = (fn) => { const run = keyChain.then(fn, fn); keyChain = run.catch(() => {}); return run; };
  const keyAdded = (res, provider, key, opts) => exclusive(() => keyAddedNow(res, provider, key, opts));
  async function keyAddedNow(res, provider, key, { named = [], retest = false } = {}) {
    const { addProviderKey, keyReport, maskKey } = await import("./keycheck.js");
    const st = readState(stateFile);
    const out = await addProviderKey(st, provider, key, { named, fetchImpl: frontierFetch });
    if (out.saved) writeState(st, stateFile);
    const n = out.saved ? await refreshFrontier() : frontierMap.size;
    const models = providerModelsLoaded(provider);
    const report = keyReport({ provider, key, check: out.check, saved: out.saved, retest, models, heimdall: "ready", surface: "app" });
    log(`provider key ${retest ? "re-tested" : out.saved ? "stored" : "REJECTED, not stored"} for ${provider} ${maskKey(key)} (check: ${out.check.status}; ${n < 0 ? "discovery failed" : models.length + " model(s) loaded"})`);
    const { reason, label, status, http, model } = out.check;
    return json(res, 200, { ok: true, provider, stored: retest ? true : out.saved, masked: maskKey(key), configured: Object.keys(st.providerKeys || {}), frontierModels: n, models, check: { status, label, http, reason, model: model ?? null }, report: { ok: report.ok, tone: report.tone, headline: report.headline, lines: report.lines }, keySource: "server-side (never a browser)" });
  }
  const frontierGate = (privacy) => privacy === "sealed-external" || privacy === "explicit";
  const frontierRefusal = (model) => `frontier model ${model} is sealed-only — send heimdall_privacy:"sealed-external" (or "explicit") in the body; the Fold selects its privacy mode and seals first`;

  // The dispatch ledger (dispatch.js): every frontier choice and its measured
  // tokens, so /api/meter reports exact external tokens, never an estimate.
  const dispatchLedger = [];
  const recordDispatch = (job, selected, reason, actual, lane = null, extra = null) => {
    dispatchLedger.push({ ...dispatchRecord({ job, selected, reason, actual, lane }), ...(extra || {}) });
    if (dispatchLedger.length > 2000) dispatchLedger.splice(0, dispatchLedger.length - 2000);
    // failed rungs are bounded on their own, so a flood of failures can never push the served entries out of the ledger
    if (reason === "rung-failed") {
      let failed = 0;
      for (const e of dispatchLedger) if (e.reason === "rung-failed") failed++;
      for (let i = 0; failed > MAX_FAILED_ENTRIES && i < dispatchLedger.length; i++) if (dispatchLedger[i].reason === "rung-failed") { dispatchLedger.splice(i, 1); i--; failed--; }
    }
  };
  // THE CIRCUIT BREAKER, per executor. A refused credential (401/403), a rejected request (400) or two failures in a row bench the
  // executor for a cool-down; a 429 benches it for the provider's Retry-After. runOnGiver and the dispatch plan consult it, so the
  // same dead lane is not retried on every request. The state is runtime health: never persisted, never shown with a key.
  const health = new WeakMap();
  const healthOf = (ex) => { let h = health.get(ex); if (!h) { h = { fails: 0, downUntil: 0, lastStatus: null }; health.set(ex, h); } return h; };
  const downMs = breaker === false ? 0 : (breaker?.downMs ?? 60_000);
  const rateLimitMs = breaker?.rateLimitMs ?? 10_000;
  const isDown = (ex) => !!ex && downMs > 0 && healthOf(ex).downUntil > Date.now();
  const noteFail = (ex, e) => {
    if (!ex || downMs <= 0) return;
    const h = healthOf(ex);
    h.fails++; h.lastStatus = e?.status ?? null;
    if (e?.status === 401 || e?.status === 400 || e?.status === 403) h.downUntil = Date.now() + downMs;
    else if (e?.status === 429) h.downUntil = Date.now() + Math.min(downMs, Math.max(1000, e.retryAfterMs ?? rateLimitMs));
    else if (h.fails >= 2) h.downUntil = Date.now() + downMs;
  };
  const noteOk = (ex) => { if (ex) { const h = healthOf(ex); h.fails = 0; h.downUntil = 0; h.lastStatus = null; } };
  // POST /api/job — the escalation design (src/escalation.js, docs/ESCALATION.md): a job + payload resolved to the best ELIGIBLE
  // route, every proposal judged by the job's local checks, every attempt written to the ledger above. Opt-in; no existing door changes.
  const routeStats = createRouteStats({ file: routeStatsFile });
  const liveJobRoutes = async (form) => {
    const out = [];
    // local models: this machine's own Ollama (inside the trust domain; nothing leaves)
    let tags = [];
    try { tags = (await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(2500) })).json()).models ?? []; } catch {}
    for (const m of tags) {
      if (/embed/i.test(m.name)) continue;
      out.push({ id: `local:${m.name}`, kind: "local-model", trust: "local", model: m.name, run: async (messages, { maxTokens, signal }) => {
        const t0 = Date.now();
        const r = await fetch(upstream + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.name, messages, stream: false, options: { num_predict: maxTokens, temperature: 0 } }), signal });
        if (!r.ok) { const e = new Error(`ollama ${r.status}`); e.status = r.status; throw e; }
        const j = await r.json();
        return { text: j.message?.content ?? "", ms: Date.now() - t0, tokens: j.eval_count ?? null };
      } });
    }
    // consented devices: browser-tab horses (private-fleet)
    for (const w of readyWorkers()) {
      out.push({ id: `device:${w.model}`, kind: "device", trust: "private-fleet", model: ollamaTagOf(w.model) || w.model, queue: Number.isFinite(w.queueDepth) ? w.queueDepth : 0, run: async (messages, { maxTokens }) => {
        const o = await runOnFleet({ model: w.model, messages, temperature: 0, max_tokens: maxTokens }, () => {});
        return { text: o.text, ms: o.ms, tokens: o.tokens };
      } });
    }
    // remote services: one route per distinct frontier executor; keys stay server-side, the audit ledger records the exact bytes
    const seen = new Set();
    for (const ex of frontierMap.values()) {
      const id = `${ex.provider}:${ex.model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, kind: "remote", trust: "external", model: ex.model, capabilities: ["reasoning", "classification", "composition", "extraction", "verification", "compute", "retrieval", "structured-output", "native-tools", "long-context"], run: async (messages, { maxTokens }) => {
        const o = await inferOn(ex, { messages, temperature: 0, maxTokens, fetchImpl: auditedFetchFor(ex) });
        return { text: o.text, ms: o.ms, tokens: o.tokens, status: o.status };
      } });
    }
    return out;
  };
  const jobLane = createJobLane({
    stats: routeStats,
    routes: async (form) => (jobRoutes ? jobRoutes(form) : [...(await liveJobRoutes(form)), ...(extraJobRoutes ? await extraJobRoutes(form) : [])]),
    saveStats: () => routeStats.save(),
    // every attempt — chosen route, why, verdict — enters the dispatch ledger (exact external tokens stay exact)
    record: ({ job, route, attempt }) => recordDispatch(
      { id: job.id, taskClass: job.taskClass, privacy: job.privacy },
      route.id,
      `job:${attempt.n}:${attempt.chosenBy}:${attempt.verdict}`,
      { ms: attempt.ms, inputTokens: 0, outputTokens: attempt.tokens ?? 0, accepted: attempt.verdict === "accepted" },
      route.trust === "external" ? null : "deterministic/local",
    ),
  });
  // THE ORIGIN WALL. A browser request carries an Origin; it is served only when it is this bridge's OWN origin (whatever port the
  // bridge — or the server it is embedded in — is on) or an entry of the EXPLICIT allowlist (allowedOrigins / HEIMDALL_ALLOWED_ORIGINS,
  // e.g. the fold's own origin). Any other page — another loopback port included — is refused. Never "*". Origin-less callers (curl, a
  // server-side client) are not browsers: they are held by the Host check and, on the bridge-only routes, by the access token.
  const selfOriginsOn = (p) => new Set([`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`]);
  const allowedOriginSet = new Set(
    [...(allowedOrigins || []), ...String(process.env.HEIMDALL_ALLOWED_ORIGINS || "").split(",")]
      .map((s) => String(s).trim()).filter(Boolean),
  );
  const allowedHostSet = new Set([...LOCAL_HOSTNAMES, ...(allowedHosts || []).map((h) => String(h).toLowerCase())]);
  // The port this request actually arrived on: the bridge's own listener, or the host server it is mounted in.
  const localPortOf = (req) => req.socket?.localPort ?? server.address()?.port ?? port;
  /** DNS rebinding: a request whose Host is not a loopback name on THIS port is not for us. */
  const hostAllowed = (req) => {
    const h = String(req.headers.host || "").toLowerCase();
    const m = h.match(/^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/);
    if (!m || !allowedHostSet.has(m[1])) return false;
    const lp = localPortOf(req);
    return m[2] ? Number(m[2]) === lp : lp === 80;
  };

  // Tab survival: noTabsSince is when the count last dropped to (or started
  // at) zero — null while at least one SSE tab is connected. A boot with no
  // tab yet starts the grace clock immediately, the same as a later drop.
  let noTabsSince = Date.now();
  let lastAutoOpenAt = 0;

  function maybeAutoOpen() {
    if (!autoOpen || tabs.size > 0 || noTabsSince == null) return;
    const now = Date.now();
    if (now - noTabsSince < NO_TAB_GRACE_MS) return;
    if (now - lastAutoOpenAt < NO_TAB_REOPEN_COOLDOWN_MS) return;
    lastAutoOpenAt = now;
    const url = `http://localhost:${port}/`;
    // Same OS-open pattern as eoreader7's cli/browser.mjs, so a headless
    // `open`/`xdg-open` failure here behaves the same way it does there.
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    log(`no controller tab for ${Math.round((now - noTabsSince) / 1000)}s — opening one (${cmd} ${url})`);
    try {
      exec(`${cmd} ${url}`, (err) => { if (err) log(`could not open a tab automatically: ${err.message}`); });
    } catch (e) {
      log(`could not open a tab automatically: ${e.message}`);
    }
  }
  const noTabTimer = setInterval(maybeAutoOpen, NO_TAB_CHECK_MS);
  noTabTimer.unref?.(); // an embedded bridge never keeps its host process alive

  const tabAlive = () => tabs.size > 0 && Date.now() - stateAt < tabFreshMs;
  const readyWorkers = () => (tabAlive() ? (state?.workers ?? []).filter((w) => w.ready && w.model) : []);
  // `any` (or `fleet`) asks for whatever a ready phone holds — the caller
  // chose not to pin a model. Every other name is pinned exactly.
  const isAny = (model) => model === "any" || model === "fleet";
  // A native app host (linked by the page or `heimdall link`) answers the
  // models it advertised; a browser worker answers the WebLLM ids it holds.
  const linkedGiver = (model) => resolveLink(links, model, { skipMs: linkSkipMs });
  const fleetServes = (model) =>
    !!model && (isFrontier(model) || !!linkedGiver(model) || readyWorkers().some((w) => isAny(model) || answers(w.model, model)));
  // WebLLM is the default engine: a request that names no model rides a ready browser worker (WebLLM) when one is attached, and only
  // otherwise falls through to what it did before (the upstream default). A caller that names a model is never redirected.
  const defaultToWebllm = (b) => { if (b && !b.model && readyWorkers().length) b.model = "any"; return b; };

  function toTab(msg) {
    const tab = [...tabs].at(-1);
    if (!tab) return null;
    tab.write(`data: ${JSON.stringify(msg)}\n\n`);
    return tab;
  }

  /** Run one chat on the fleet. Calls onToken(text) per delta; resolves
   *  { text, ms, tokens } or rejects with { beforeFirstToken, message }. */
  function runOnFleet({ model, messages, temperature, max_tokens }, onToken) {
    return new Promise((resolve, reject) => {
      if (jobs.size >= maxJobs) return reject({ beforeFirstToken: true, message: `the fleet is saturated (${jobs.size} jobs in flight)` });
      const id = randomUUID();
      const t0 = Date.now();
      let text = "";
      let tokens = 0;
      let timer = null;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(null, `the fleet went quiet for ${Math.round(ms / 1000)}s`), ms);
      };
      const finish = (ok, err) => {
        clearTimeout(timer);
        jobs.delete(id);
        if (ok) resolve({ text, ms: Date.now() - t0, tokens });
        else reject({ beforeFirstToken: tokens === 0, message: err });
      };
      jobs.set(id, {
        tab: null,
        onMsg(m) {
          if (m.type === "token") {
            if (typeof m.text !== "string" || !m.text) return;
            text += m.text;
            tokens++;
            arm(IDLE_MS);
            onToken(m.text);
          } else if (m.type === "result") {
            // a giver that did not stream still delivers its whole text
            if (!tokens && m.text) {
              text = m.text;
              tokens = 1;
              onToken(m.text);
            }
            finish(true);
          } else if (m.type === "error") {
            finish(null, m.message || "fleet error");
          }
        },
      });
      arm(FIRST_TOKEN_MS);
      const tab = toTab({ type: "job", id, model: isAny(model) ? null : model, messages, temperature, max_tokens });
      if (!tab) finish(null, "no controller tab");
      else if (jobs.has(id)) jobs.get(id).tab = tab; // so a tab that drops fails ITS jobs at once (see the events route)
    });
  }

  /** Run one chat on a native app host. Speaks whichever wire it was probed
   *  as (Ollama NDJSON or OpenAI SSE) and normalizes both to onToken(text).
   *  Resolves { text, ms, tokens } or rejects { beforeFirstToken, message } —
   *  the same contract runOnFleet keeps, so the caller's fall-through is one
   *  code path either way. */
  function runOnLink(link, { messages, temperature, max_tokens }, onToken) {
    return new Promise(async (resolve, reject) => {
      const t0 = Date.now();
      const base = link.url.replace(/\/+$/, "");
      const model = link.model || link.tag || "local";
      const headers = { "content-type": "application/json" };
      if (link.key) headers.authorization = `Bearer ${link.key}`;
      const url = link.kind === "openai" ? `${base}/v1/chat/completions` : `${base}/api/chat`;
      const body = link.kind === "openai"
        ? { model, messages, temperature, max_tokens, stream: true }
        : { model, messages, stream: true, options: { temperature, num_predict: max_tokens } };
      let text = "";
      let tokens = 0;
      let buf = "";
      // Feed complete lines to parse(); both wires are line-delimited (NDJSON
      // for Ollama, `data: {...}` SSE for OpenAI).
      const feed = (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "").trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const payload = link.kind === "openai" && line.startsWith("data:") ? line.slice(5).trim() : line;
          if (!payload || payload === "[DONE]") continue;
          let j;
          try { j = JSON.parse(payload); } catch { continue; }
          const delta = link.kind === "openai"
            ? j.choices?.[0]?.delta?.content
            : (j.message?.content ?? j.response);
          if (j.error) { reject({ beforeFirstToken: tokens === 0, message: String(j.error?.message || j.error) }); return; }
          if (typeof delta === "string" && delta) { text += delta; tokens++; onToken(delta); }
        }
      };
      // A phone that accepts and never answers must not hang the request: a first-byte bound (configurable), then an idle bound
      // between chunks. A host that failed before its first token is skipped for a window (links.mjs resolveLink).
      const ac = new AbortController();
      let timer = null;
      const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error(`${link.name || link.url}: ${why} in ${Math.round(ms / 1000 * 10) / 10}s`)), ms); timer.unref?.(); };
      try {
        arm(linkFirstByteMs, "no first byte");
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ac.signal });
        if (!r.ok || !r.body) throw new Error(`${link.kind || "app"} ${r.status}: ${await r.text().catch(() => "")}`);
        const dec = new TextDecoder();
        for await (const chunk of r.body) { arm(IDLE_MS, "went quiet"); feed(dec.decode(chunk, { stream: true })); }
        clearTimeout(timer);
        delete link.lastFailAt;
        resolve({ text, ms: Date.now() - t0, tokens });
      } catch (e) {
        clearTimeout(timer);
        if (tokens === 0) link.lastFailAt = Date.now();
        reject({ beforeFirstToken: tokens === 0, message: ac.signal.aborted ? String(ac.signal.reason?.message || "timed out") : (e?.message || "native host error") });
      }
    });
  }

  /** One chat on the best alive rung of the DEGRADATION LADDER. The rungs, in
   *  order of power: a configured frontier executor (sealed) → a linked native
   *  app (real GPU, survives without a controller tab) → the browser fleet →
   *  upstream Ollama (the caller's own fall-through). When a rung fails BEFORE
   *  its first token — the higher layer broke — the request STEPS DOWN to the
   *  next rung that can serve the model; the work continues, just not as well.
   *  A rung that dies mid-stream never steps down (the caller already holds
   *  partial output). The drop is not silent: it lands in the dispatch ledger
   *  (reason "fell-through", lane = what ACTUALLY served) so the meter counts
   *  external tokens honestly. Resolves { text, ms, tokens, lane }; rejects
   *  with { beforeFirstToken } when every rung failed, so the caller answers
   *  from upstream and counts the drop itself. */
  async function runOnGiver(model, opts, onToken) {
    const rungs = [];
    const fx = frontierMap.get(model);
    if (fx) rungs.push({ lane: "frontier", ex: fx, run: () => runOnFrontier(model, opts, onToken) });
    const link = linkedGiver(model);
    if (link) rungs.push({ lane: "native", run: () => runOnLink(link, opts, onToken) });
    rungs.push({ lane: "fleet", run: () => runOnFleet({ model, ...opts }, onToken) });
    let fell = false;
    for (const rung of rungs) {
      if (opts?.signal?.aborted) throw Object.assign(new Error("cancelled by the caller"), { aborted: true, beforeFirstToken: false });
      // a benched executor is not asked at all (circuit breaker): that is a step down too
      if (rung.ex && isDown(rung.ex)) { fell = true; log(`${rung.lane}  ${model}  benched until ${new Date(healthOf(rung.ex).downUntil).toISOString().slice(11, 19)} — stepping down`); continue; }
      const t0 = Date.now();
      try {
        const out = await rung.run();
        if (rung.ex) noteOk(rung.ex);
        if (fell) {
          stats.fellThrough++;
          recordDispatch(
            { id: "bridge-" + randomUUID(), taskClass: `bridge.${rung.lane}` },
            model,
            "fell-through",
            { ms: out.ms, inputTokens: promptTokensOf(out), outputTokens: outputTokensOf(out) },
            rung.lane,
          );
          log(`fell through  ${model}: a higher rung broke — ${rung.lane} served`);
        } else if (rung.lane !== "frontier") {
          // a native app or fleet worker served it: free and local, but on the record so the token meter can say what it saved
          recordDispatch({ id: "bridge-" + randomUUID(), taskClass: `bridge.${rung.lane}` }, model, rung.lane, { ms: out.ms, inputTokens: promptTokensOf(out), outputTokens: outputTokensOf(out), exact: Number.isFinite(out?.usage?.output) }, "deterministic/local");
        }
        return { ...out, lane: rung.lane };
      } catch (e) {
        if (opts?.signal?.aborted || e?.aborted) throw Object.assign(e, { aborted: true, beforeFirstToken: false });   // cancelled: no step-down, no health penalty
        if (rung.ex) noteFail(rung.ex, e);
        if (!e?.beforeFirstToken) throw e;
        fell = true;
        // every failed rung is on the record (bounded): the lane, what it said, and the HTTP status when it had one
        recordDispatch(
          { id: "bridge-" + randomUUID(), taskClass: `bridge.${rung.lane}` },
          model,
          "rung-failed",
          { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: false },
          rung.lane,
          { lane: rung.lane, error: String(e.message ?? e).slice(0, 200), status: e.status ?? null },
        );
        log(`${rung.lane}  ${model}  failed before the first token (${e.message}) — stepping down`);
      }
    }
    const err = new Error("every giver failed before the first token");
    err.beforeFirstToken = true;
    throw err;
  }

  /** What the provider REPORTED for the prompt / the answer, else (output only) the chunk count. */
  const promptTokensOf = (out) => (out?.usage ? (out.usage.input ?? 0) + (out.usage.cacheRead ?? 0) + (out.usage.cacheCreation ?? 0) : 0);
  const outputTokensOf = (out) => (Number.isFinite(out?.usage?.output) ? out.usage.output : (out?.tokens ?? 0));

  /** The OpenAI-shaped usage block, carrying the provider's EXACT counts when it reported them. */
  const usageOf = (out) => {
    const u = out.usage;
    if (!u) return { completion_tokens: out.tokens };
    const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreation ?? 0);
    return { prompt_tokens: prompt, completion_tokens: u.output ?? out.tokens, total_tokens: prompt + (u.output ?? out.tokens ?? 0), prompt_tokens_details: { cached_tokens: u.cacheRead ?? 0, cache_creation_tokens: u.cacheCreation ?? 0, fresh_tokens: u.input ?? null }, exact: true };
  };

  /** One chat on a configured frontier executor (Anthropic/OpenAI/… wire via
   *  remote.js inferOn). The caller has already passed the privacy gate; the
   *  body sent upstream is exactly what the Fold put there (the projection for
   *  its selected privacy mode). Every call lands a dispatch-ledger entry. */
  // the price of one served model, for the token ledger: a hosted provider's own estimate, else the default table
  const priceFor = (model, lane) => {
    const i = String(model).indexOf(":");
    const prov = i > 0 ? String(model).slice(0, i) : null;
    if (prov && isHostedOpen(prov)) return HOSTED_OPEN[prov];
    return priceOf(String(model).replace(/^[a-z]+:/i, ""), lane === "frontier" ? "frontier" : "remote");
  };
  // requests in flight per lane, and how many a lane may take at once (null = unbounded). The race reads these so it does not pile
  // more work on a lane that is already full; /api/frontier reports them.
  const laneInflight = new Map();
  const slotsFor = (ex) => laneSlots[ex.provider] ?? (isHostedOpen(ex.provider) ? HOSTED_OPEN[ex.provider].slots : null);
  const saturated = (ex) => { const n = slotsFor(ex); return n != null && (laneInflight.get(ex) || 0) >= n; };
  async function runOnFrontier(model, opts, onToken) {
    const ex = frontierMap.get(model);
    laneInflight.set(ex, (laneInflight.get(ex) || 0) + 1);
    try { return await runOnFrontierNow(model, opts, onToken); }
    finally { laneInflight.set(ex, Math.max(0, (laneInflight.get(ex) || 1) - 1)); }
  }
  async function runOnFrontierNow(model, { messages, temperature = 0.7, max_tokens = 1024, signal = null }, onToken) {
    const ex = frontierMap.get(model);
    const box = {};
    const lane = isHostedOpen(ex.provider) ? "open remote" : "frontier";
    const t0 = Date.now();
    let out;
    try {
      // first-byte bound inside the total timeout: a provider that accepts and never speaks steps the ladder down at 15 s, not 120
      out = await inferOn(ex, { messages, temperature, maxTokens: max_tokens, onToken, fetchImpl: auditedFetchFor(ex, box), firstByteMs: frontierFirstByteMs, timeoutMs: frontierTimeoutMs, signal });
    } catch (e) {
      // stopped by the caller (a race won elsewhere, a closed tab): on the record as cancelled, never as this lane's failure
      if (e?.aborted) recordDispatch({ id: "bridge-" + randomUUID(), taskClass: "bridge.frontier", privacy: "sealed-external" }, `${ex.provider}:${ex.model}`, "cancelled", { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: false }, lane);
      throw e;
    }
    if (box.handle && out.usage) box.handle.annotate({ usage: out.usage });
    recordDispatch(
      { id: "bridge-" + randomUUID(), taskClass: "bridge.frontier", privacy: "sealed-external" },
      `${ex.provider}:${ex.model}`,
      "frontier",
      { ms: out.ms, inputTokens: promptTokensOf(out), outputTokens: outputTokensOf(out), exact: Number.isFinite(out?.usage?.output) },
      lane,
    );
    log(`frontier  ${ex.provider}:${ex.model}  ${out.tokens} tokens  ${out.ms}ms`);
    return out;
  }

  /* ---------------------------------------------------------- helpers */

  /** The request body, bounded: past `limit` bytes it stops reading and rejects 413 (never buffered whole). */
  function readBody(req, limit = maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit) { req.resume(); return reject(new HttpError(413, `body is ${declared} bytes; the limit is ${limit}`)); }
      const chunks = [];
      let size = 0, over = false;
      req.on("data", (c) => {
        if (over) return;
        size += c.length;
        if (size > limit) { over = true; chunks.length = 0; return reject(new HttpError(413, `body exceeds the ${limit}-byte limit`)); }
        chunks.push(c);
      });
      req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
      req.on("error", reject);
    });
  }
  /** The JSON body, or an HttpError 400 — a malformed body is the caller's mistake, never a 500. */
  async function readJson(req, { fallback = {}, limit = maxBodyBytes } = {}) {
    const raw = (await readBody(req, limit)).toString();
    if (!raw.trim()) return fallback;
    try { return JSON.parse(raw); } catch { throw new HttpError(400, "body must be valid JSON"); }
  }

  function json(res, code, obj, headers = null) {
    res.writeHead(code, { "content-type": "application/json", ...(headers || {}) });
    res.end(JSON.stringify(obj));
  }

  function sendHtml(res, html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
  }

  /** The native-app linking page: store links for the phone, a live tester to
   *  add the app's server as a host. Served at /link on this bridge; works on
   *  macOS, Windows and Linux (nothing platform-specific in it). */
  /** Links as shown to anything that is not the owner's tool: the stored bearer key is never echoed (only whether one is set). */
  const publicLinks = () => links.map(({ key, lastFailAt, ...rest }) => ({ ...rest, hasKey: !!key, ...(lastFailAt ? { lastFailAt } : {}) }));

  function linkPage(localPort = port) {
    // Everything a stored link carries (name, url, tag, kind) is untrusted text: escaped here, and built with textContent in the script.
    const rows = links.map((l) =>
      `<li><b>${escapeHtml(l.name || l.url)}</b> <span class=n>${escapeHtml(l.kind || "?")}</span> <code>${escapeHtml(l.url)}</code>` +
      (l.tag ? ` &rarr; <code>${escapeHtml(l.tag)}</code>` : "") +
      ` <button data-url="${escapeHtml(l.url)}" class=rm>remove</button></li>`).join("");
    return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Link a phone — heimdall</title>
<style>
  :root{color-scheme:dark light}body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}
  h2{margin-top:1.6rem} .card{border:1px solid #8884;border-radius:10px;padding:1rem;margin:.6rem 0}
  a.btn{display:inline-block;margin:.25rem .4rem .25rem 0;padding:.5rem .8rem;border:1px solid #8886;border-radius:8px;text-decoration:none;color:inherit}
  a.btn.hot{border-color:#4ea1ff;box-shadow:0 0 0 1px #4ea1ff}
  code{background:#8882;padding:.1rem .3rem;border-radius:4px} input,select{font:inherit;padding:.4rem;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit}
  input[type=text]{width:min(420px,90vw)} .n{opacity:.7;font-size:.85em} li{margin:.35rem 0}
  .ok{color:#3fb950}.bad{color:#f85149}.rm{font-size:.8em}
</style>
<h1>Link a phone</h1>
<p>WebGPU in a phone browser is unreliable. A native app runs the model on the
phone's real GPU and serves an Ollama/OpenAI API. The phone can be on your LAN
<i>or</i> on a Tailscale address, so this works across networks.</p>

<h2>1. Install</h2>
<div class=card>
  <div><b>Android</b> — <a class=btn data-os=android href="https://play.google.com/store/apps/details?id=com.micklab.llama">LLM AI Server with llama.cpp</a>
  <a class=btn data-os=android href="https://play.google.com/store/apps/details?id=com.llmproxy">Ollama Local AI — Phone IDE</a></div>
  <div style="margin-top:.5rem"><b>iOS</b> — <a class=btn data-os=ios href="https://apps.apple.com/us/app/on-device-llm/id6770114399">OnDevice LLM</a></div>
</div>

<h2>2. Start its server</h2>
<div class=card>Open the app, download a model, and start the local API server.
It shows an address like <code>http://100.64.0.7:8000</code> (Tailscale) or
<code>http://192.168.1.50:8080</code> (LAN). Keep the app in the foreground —
iOS/Android suspend a background server.</div>

<h2>3. Link it</h2>
<div class=card>
  <input id=url type=text placeholder="100.64.0.7:8000"><br><br>
  <input id=key type=text placeholder="API key (only if the app requires one)"><br><br>
  <label>Advertise as Ollama tag <input id=tag type=text placeholder="auto from the model" style="width:auto"></label><br><br>
  <button id=test>Test</button> <button id=add>Test &amp; add</button>
  <div id=msg style="margin-top:.6rem"></div>
</div>

<h2>Linked hosts</h2>
<ul id=list>${rows || "<li class=n>none yet</li>"}</ul>
<p class=n>Saved to <code>${escapeHtml(linksFile)}</code>. This bridge already exposes them
to eoreader7 as one host — <code>ER7_OLLAMA_HOSTS="…,fleet=http://localhost:${localPort}"</code>.</p>

<script>
  var msg = document.getElementById("msg");
  function show(ok, text){ msg.className = ok ? "ok" : "bad"; msg.textContent = text; }
  function el(tag, text, cls){ var e = document.createElement(tag); if(text != null) e.textContent = text; if(cls) e.className = cls; return e; }
  function refresh(){
    fetch("${prefix}/link/hosts").then(function(r){return r.json()}).then(function(j){
      var ul = document.getElementById("list");
      ul.textContent = "";
      if(!j.links.length){ ul.appendChild(el("li","none yet","n")); return; }
      j.links.forEach(function(l){
        var li = document.createElement("li");
        li.appendChild(el("b", l.name||l.url)); li.appendChild(document.createTextNode(" "));
        li.appendChild(el("span", l.kind||"?", "n")); li.appendChild(document.createTextNode(" "));
        li.appendChild(el("code", l.url));
        if(l.tag){ li.appendChild(document.createTextNode(" \u2192 ")); li.appendChild(el("code", l.tag)); }
        li.appendChild(document.createTextNode(" "));
        var b = el("button","remove","rm"); b.setAttribute("data-url", l.url); li.appendChild(b);
        ul.appendChild(li);
      });
    });
  }
  function probe(){
    var url = document.getElementById("url").value;
    return fetch("${prefix}/link/probe",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({url:url,key:document.getElementById("key").value||null})}).then(function(r){return r.json()});
  }
  document.getElementById("test").onclick = function(){
    show(true,"testing…");
    probe().then(function(p){
      if(!p.ok) return show(false,"no answer: "+(p.error||"unknown"));
      show(true,"ok — "+p.kind+" — "+p.models.join(", "));
      if(!document.getElementById("tag").value && p.models[0]) document.getElementById("tag").value = p.models[0];
    }).catch(function(e){ show(false,String(e)); });
  };
  document.getElementById("add").onclick = function(){
    var url = document.getElementById("url").value;
    var tag = document.getElementById("tag").value || null;
    show(true,"testing…");
    probe().then(function(p){
      if(!p.ok) return show(false,"no answer: "+(p.error||"unknown"));
      return fetch("${prefix}/link/host",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({url:url,key:document.getElementById("key").value||null,tag:tag,model:p.models[0]})})
        .then(function(r){return r.json()}).then(function(j){
          if(!j.ok) return show(false,j.error||"could not link");
          show(true,"linked "+p.models[0]+" as "+ (j.links[j.links.length-1].tag||"") );
          refresh();
        });
    }).catch(function(e){ show(false,String(e)); });
  };
  document.addEventListener("click", function(e){
    if(e.target.classList && e.target.classList.contains("rm")){
      fetch("${prefix}/link/remove",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({url:e.target.getAttribute("data-url")})}).then(refresh);
    }
  });
  // highlight the store button for this device's OS
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  document.querySelectorAll("a.btn[data-os]").forEach(function(a){
    if((a.dataset.os==="ios") === ios) a.classList.add("hot");
  });
</script>`;
  }

  /* ------------------------------------------------- the floor: upstreams */

  const upstreamShape = (urlPath) => (String(urlPath).startsWith("/v1/messages") ? "anthropic" : String(urlPath).startsWith("/v1/") ? "openai" : "plain");
  /** An error in the shape the caller's wire speaks (OpenAI, Anthropic, or Ollama's plain string). */
  const errorBody = (shape, status, message) =>
    shape === "anthropic" ? { type: "error", error: { type: status === 429 ? "rate_limit_error" : "api_error", message } }
      : shape === "openai" ? { error: { message, type: status === 429 ? "rate_limit_error" : "upstream_error", code: status } }
        : { error: message };
  /** An error frame for a stream that already started (the status line is gone), in the stream's own framing. */
  const errorFrame = (shape, sse, message) =>
    shape === "anthropic" ? `event: error\ndata: ${JSON.stringify(errorBody("anthropic", 502, message))}\n\n`
      : sse ? `data: ${JSON.stringify(errorBody("openai", 502, message))}\n\n`
        : JSON.stringify({ error: message }) + "\n";
  /** Is this base khora's channel proxy (x-heimdall-channel) rather than Ollama? Learned from any answer, else probed once a minute. */
  const channelSeen = new Map(); // base -> { at, is }
  const noteChannel = (base, r) => { if (r?.headers?.get?.("x-heimdall-channel")) channelSeen.set(base, { at: Date.now(), is: true }); };
  const isChannel = async (base) => {
    const c = channelSeen.get(base);
    if (c && Date.now() - c.at < 60_000) return c.is;
    let is = false;
    try { const r = await fetch(base + "/api/version", { signal: AbortSignal.timeout(2000) }); is = !!r.headers.get("x-heimdall-channel"); await r.body?.cancel().catch(() => {}); } catch {}
    channelSeen.set(base, { at: Date.now(), is });
    return is;
  };

  /** Walk the floor in order. An upstream that answers 502/429/403/508 (or 503/504), refuses the connection, or has not answered by the
   *  first-byte bound is passed over for the next one — only here, BEFORE any byte has been written to the caller. The last upstream's
   *  answer is returned as it is. One request = one step-down record, however many upstreams were skipped. */
  async function openUpstream({ urlPath, method, headers, body, wantsStream, gone }) {
    const skipped = [];
    const t0 = Date.now();
    for (let i = 0; i < upstreamList.length; i++) {
      const base = upstreamList[i];
      const last = i === upstreamList.length - 1;
      const fb = new AbortController();
      const timer = wantsStream && upstreamFirstByteMs > 0 ? setTimeout(() => fb.abort(new DOMException(`no first byte in ${upstreamFirstByteMs}ms`, "TimeoutError")), upstreamFirstByteMs) : null;
      timer?.unref?.();
      const signal = AbortSignal.any([gone, AbortSignal.timeout(upstreamTimeoutMs), fb.signal]);
      try {
        const r = await fetch(base + urlPath, { method, headers, body, signal });
        clearTimeout(timer);
        noteChannel(base, r);
        if (UPSTREAM_STEPDOWN.has(r.status) && !last) { await r.body?.cancel().catch(() => {}); skipped.push(`${base} answered ${r.status}`); continue; }
        if (skipped.length) {
          stats.fellThrough++;
          recordDispatch({ id: "bridge-" + randomUUID(), taskClass: "bridge.upstream" }, base, "upstream-stepdown", { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: r.ok }, "deterministic/local", { skipped });
          log(`floor  stepped down to ${base} (${skipped.join("; ")})`);
        }
        return { r, base, signal };
      } catch (e) {
        clearTimeout(timer);
        if (gone.aborted) throw e; // the caller left: nothing to step down for
        skipped.push(`${base}: ${e?.message || e}`);
        if (last) throw Object.assign(new Error(skipped.join("; ")), { cause: e });
      }
    }
    throw new Error("no upstream configured");
  }

  /** Request-scoped abort when the caller goes away (the browser's Stop, a closed socket). */
  const clientGone = (res) => { const ac = new AbortController(); res.on("close", () => { if (!res.writableEnded) ac.abort(); }); return ac.signal; };
  const relayHeaders = (r) => Object.fromEntries(Object.entries(forwardHeaders(r)).filter(([k]) => k !== "content-type"));
  const forwardHeaders = (r) => { const h = { "content-type": r.headers.get("content-type") || "application/json" }; for (const [k, v] of r.headers) if (FORWARD_HEADERS.test(k)) h[k] = v; return h; };

  async function pipeUpstream(req, res, raw, urlPath = req.url) {
    stats.passthrough++;
    const shape = upstreamShape(urlPath);
    if (!passthrough) {
      let model = null;
      try { model = JSON.parse(raw.toString() || "{}").model; } catch {}
      return json(res, 404, errorBody(shape, 404, `model "${model}" not found in the fleet (no phone holds it, and pass-through is off)`));
    }
    // The caller's identity and Heimdall's hop marks ride through (2026-09-21):
    // upstream is Heimdall's channel, which keys the line per SERVER and
    // must see the original caller, not the bridge; and a turn the channel
    // sent HERE that fell through must re-enter marked, never re-queue.
    const headers = { "content-type": req.headers["content-type"] || "application/json" };
    for (const [k, v] of Object.entries(req.headers)) if (/^x-(er7|heimdall)-/.test(k) && typeof v === "string") headers[k] = v;
    if (!headers["x-er7-user"] && !headers["x-er7-caller"] && !headers["x-er7-session"]) headers["x-er7-caller"] = `heimdall-bridge:${localPortOf(req)}`;
    let wantsStream = req.method === "GET" || req.method === "HEAD";
    if (!wantsStream) { try { wantsStream = JSON.parse(raw.toString() || "{}").stream !== false; } catch { wantsStream = true; } }
    const gone = clientGone(res);
    let opened;
    try {
      opened = await openUpstream({ urlPath, method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : raw, wantsStream, gone });
    } catch (e) {
      if (gone.aborted) return res.end();
      return json(res, 502, errorBody(shape, 502, `upstream Ollama at ${upstreamList[0]} did not answer: ${e.message}`));
    }
    const { r } = opened;
    res.writeHead(r.status, forwardHeaders(r));
    if (!r.body) return res.end();
    const sse = /event-stream/i.test(r.headers.get("content-type") || "");
    try {
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) {
      // The upstream died (or was cut) after bytes were written: never a clean EOF. The caller gets an error frame and the socket is destroyed.
      if (gone.aborted || res.destroyed) return res.end();
      log(`floor  upstream failed mid-stream (${e?.message})`);
      res.write(errorFrame(shape, sse, `upstream failed mid-stream: ${e?.message || e}`), () => res.destroy(new Error("upstream failed mid-stream")));
    }
  }

  /** THE EMBED'S FLOOR (src/embed.js, docs/EMBED.md). Run ONE job on THIS instance's own floor (rung 4, `upstreamList`) and nothing else:
   *  no fleet, no frontier, and above all NEVER a peer — the loop rule is that a peer's job ends here. Yields `{type:"delta",text}`
   *  chunks then `{type:"done"}`; throws (with `.status`) when the floor refuses or fails. `job` is { model, messages | prompt, system?,
   *  options?, format?, tools? }; `signal` cancels the upstream call. */
  async function* runLocal(job, signal) {
    const gen = !Array.isArray(job?.messages);
    const body = { model: job?.model, stream: true, ...(gen ? { prompt: String(job?.prompt ?? ""), ...(job?.system ? { system: String(job.system) } : {}) } : { messages: job.messages }), ...(job?.options ? { options: job.options } : {}), ...(job?.format ? { format: job.format } : {}), ...(job?.tools?.length ? { tools: job.tools } : {}) };
    const gone = signal || new AbortController().signal;
    const { r } = await openUpstream({ urlPath: gen ? "/api/generate" : "/api/chat", method: "POST", headers: { "content-type": "application/json", "x-er7-caller": "heimdall-peer" }, body: JSON.stringify(body), wantsStream: true, gone });
    if (!r.ok) { const t = await r.text().catch(() => ""); throw Object.assign(new Error(`floor answered ${r.status} ${t.slice(0, 120)}`), { status: r.status }); }
    const dec = new TextDecoder();
    let buf = "";
    const take = function* (line) {
      line = line.trim();
      if (!line) return;
      let j; try { j = JSON.parse(line); } catch { throw new Error("the floor sent a malformed line"); }
      if (j.error) throw new Error(String(j.error).slice(0, 200));
      const text = gen ? j.response : j.message?.content;
      if (typeof text === "string" && text) yield { type: "delta", text };
      if (j.done) yield { type: "done", done_reason: j.done_reason ?? "stop", ...(Number.isFinite(j.eval_count) ? { eval_count: j.eval_count } : {}) };
    };
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); yield* take(l); }
    }
    if (buf.trim()) yield* take(buf);
  }

  /* ------- /v1/messages over a channel: translate to /v1/chat/completions and back (the channel does not serve the Anthropic wire) */

  const textOfBlocks = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? (p?.type === "tool_result" ? textOfBlocks(p.content) : ""))).join("") : "");
  const stopReasonOf = (finish) => (finish === "length" ? "max_tokens" : finish === "tool_calls" ? "tool_use" : "end_turn");

  async function anthropicViaChannel(req, res, b) {
    stats.passthrough++;
    const messages = [];
    const sys = textOfBlocks(b.system);
    if (sys) messages.push({ role: "system", content: sys });
    for (const m of b.messages || []) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOfBlocks(m.content) });
    const stream = b.stream === true;
    const oa = { model: b.model, messages, stream, ...(b.max_tokens ? { max_tokens: b.max_tokens } : {}), ...(b.temperature != null ? { temperature: b.temperature } : {}), ...(b.top_p != null ? { top_p: b.top_p } : {}), ...(Array.isArray(b.stop_sequences) && b.stop_sequences.length ? { stop: b.stop_sequences } : {}), ...(stream ? { stream_options: { include_usage: true } } : {}) };
    const headers = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(req.headers)) if (/^x-(er7|heimdall)-/.test(k) && typeof v === "string") headers[k] = v;
    if (!headers["x-er7-user"] && !headers["x-er7-caller"] && !headers["x-er7-session"]) headers["x-er7-caller"] = `heimdall-bridge:${localPortOf(req)}`;
    const gone = clientGone(res);
    let opened;
    try { opened = await openUpstream({ urlPath: "/v1/chat/completions", method: "POST", headers, body: JSON.stringify(oa), wantsStream: stream, gone }); }
    catch (e) { if (gone.aborted) return res.end(); return json(res, 502, errorBody("anthropic", 502, `the channel at ${upstreamList[0]} did not answer: ${e.message}`)); }
    const { r } = opened;
    const id = `msg_${randomUUID()}`;
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      let msg = t.slice(0, 300); try { const j = JSON.parse(t); msg = j?.error?.message || (typeof j?.error === "string" ? j.error : msg); } catch {}
      return json(res, r.status, errorBody("anthropic", r.status, msg || `upstream ${r.status}`), relayHeaders(r));
    }
    if (!stream) {
      const j = await r.json().catch(() => null);
      if (!j) return json(res, 502, errorBody("anthropic", 502, "the channel returned no JSON"));
      const c = j.choices?.[0];
      return json(res, 200, { id, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: c?.message?.content ?? "" }], stop_reason: stopReasonOf(c?.finish_reason), stop_sequence: null, usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 } }, relayHeaders(r));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...relayHeaders(r) });
    const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    let finish = null, usage = null, buf = "";
    const dec = new TextDecoder();
    const take = (line) => {
      line = line.replace(/\r$/, "").trim();
      if (!line.startsWith("data:")) return;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") return;
      let j; try { j = JSON.parse(p); } catch { return; }
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (ch?.finish_reason) finish = ch.finish_reason;
      const d = ch?.delta?.content;
      if (typeof d === "string" && d) ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: d } });
    };
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      if (buf) take(buf);
      ev("content_block_stop", { type: "content_block_stop", index: 0 });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReasonOf(finish), stop_sequence: null }, usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 } });
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    } catch (e) {
      if (gone.aborted || res.destroyed) return res.end();
      res.write(errorFrame("anthropic", true, `the channel failed mid-stream: ${e?.message || e}`), () => res.destroy(new Error("upstream failed mid-stream")));
    }
  }
  /** /v1/messages that the ladder did not take: translated when the floor is a channel, piped raw to a real Ollama. */
  async function anthropicFloor(req, res, raw, b) {
    if (passthrough && await isChannel(upstreamList[0])) return anthropicViaChannel(req, res, b);
    return pipeUpstream(req, res, raw);
  }

  const tagDetails = (webllmId) => ({
    parent_model: "",
    format: "mlc",
    family: (ollamaTagOf(webllmId) || webllmId).split(":")[0],
    families: [(ollamaTagOf(webllmId) || webllmId).split(":")[0]],
    parameter_size: (ollamaTagOf(webllmId) || "").split(":")[1]?.toUpperCase() ?? "",
    quantization_level: /q4f32/.test(webllmId) ? "q4f32_1" : "q4f16_1",
  });

  /** One entry per model the fleet can serve now (both names offered). */
  function fleetModels() {
    const seen = new Map();
    for (const w of readyWorkers()) {
      const tag = ollamaTagOf(w.model);
      // The worker's own reported backlog (WorkerEngine.pending, carried
      // through bridgeState()) — 0 when the tab hasn't said otherwise, never
      // guessed. A caller ranking by expected wait needs this to be honest,
      // not an optimistic "ready" while a phone is mid-generation.
      const q = Number.isFinite(w.queueDepth) ? w.queueDepth : 0;
      for (const name of [tag, w.model].filter(Boolean)) {
        const cur = seen.get(name);
        if (cur) { cur.heimdall.workers++; cur.heimdall.queueDepth += q; continue; }
        seen.set(name, {
          name,
          model: name,
          modified_at: new Date(stateAt).toISOString(),
          size: 0,
          digest: "",
          details: tagDetails(w.model),
          heimdall: { webllm: w.model, workers: 1, context_window: w.ctx ?? null, queueDepth: q },
        });
      }
    }
    // Native app hosts advertise under their own tag and reported model ids.
    for (const l of links) {
      for (const name of linkAdvertisedModels(l)) {
        const cur = seen.get(name);
        if (cur) { cur.heimdall.native = l.name; continue; }
        seen.set(name, {
          name,
          model: name,
          modified_at: new Date().toISOString(),
          size: 0,
          digest: "",
          details: { parent_model: "", format: l.kind || "native", family: name.split(":")[0], families: [name.split(":")[0]], parameter_size: name.split(":")[1]?.toUpperCase() ?? "", quantization_level: "" },
          heimdall: { native: l.name, url: l.url, kind: l.kind, queueDepth: 0 },
        });
      }
    }
    // Configured frontier providers appear under `provider:model` (and the bare
    // model id). Reachability is the executor's own live probe, never assumed.
    for (const [name, ex] of frontierMap) {
      if (seen.has(name)) continue;
      seen.set(name, {
        name,
        model: name,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: "",
        details: { parent_model: "", format: "frontier", family: ex.provider, families: [ex.provider], parameter_size: "", quantization_level: "" },
        heimdall: { frontier: ex.provider, privacy: "sealed-external", location: ex.location ?? "external", context_window: null, queueDepth: 0 },
      });
    }
    return [...seen.values()];
  }

  const chatMessagesOf = (b) => {
    if (Array.isArray(b.messages)) return b.messages.map((m) => ({ role: m.role, content: String(m.content ?? "") }));
    const out = [];
    if (b.system) out.push({ role: "system", content: String(b.system) });
    if (b.prompt != null) out.push({ role: "user", content: String(b.prompt) });
    return out;
  };

  const fleetCanTake = (b) =>
    !b.format && !(b.tools?.length) && !b.images?.length &&
    !(Array.isArray(b.messages) && b.messages.some((m) => m.images?.length || m.tool_calls)) &&
    fleetServes(b.model);

  /* -------------------------------------------- Ollama: chat + generate */

  async function ollamaRun(req, res, raw, kind) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: "invalid JSON" }); }
    const privacy = b.heimdall_privacy || b.privacy || null;
    defaultToWebllm(b);
    if (isFrontier(b.model) && !frontierGate(privacy)) {
      stats.frontierRefused++;
      return json(res, 400, { error: frontierRefusal(b.model) });
    }
    const messages = chatMessagesOf(b);
    const hasPrompt = messages.some((m) => m.content.trim());
    // A load / keep-alive call (no prompt): answered at once when a phone holds the model.
    if (!hasPrompt) {
      if (!fleetServes(b.model)) return pipeUpstream(req, res, raw);
      const done = { model: b.model, created_at: new Date().toISOString(), done: true, done_reason: "load" };
      return json(res, 200, kind === "chat" ? { ...done, message: { role: "assistant", content: "" } } : { ...done, response: "" });
    }
    if (!fleetCanTake(b)) return pipeUpstream(req, res, raw);

    const stream = b.stream !== false;
    const opts = b.options || {};
    const line = (delta, extra = {}) => ({
      model: b.model,
      created_at: new Date().toISOString(),
      ...(kind === "chat" ? { message: { role: "assistant", content: delta } } : { response: delta }),
      done: false,
      ...extra,
    });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      if (stream) res.writeHead(200, { "content-type": "application/x-ndjson" });
    };
    try {
      const out = await runOnGiver(
        b.model,
        { messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.num_predict > 0 ? opts.num_predict : 1024 },
        (delta) => {
          start();
          if (stream) res.write(JSON.stringify(line(delta)) + "\n");
        },
      );
      stats[out.lane] = (stats[out.lane] || 0) + 1;
      const ns = out.ms * 1e6;
      const final = { ...line(stream ? "" : out.text), done: true, done_reason: "stop", total_duration: ns, load_duration: 0, eval_count: out.tokens, eval_duration: ns, heimdall: out.lane };
      if (stream) { start(); res.end(JSON.stringify(final) + "\n"); }
      else json(res, 200, final);
      log(`fleet  ${b.model}  ${out.tokens} chunks  ${out.ms}ms`);
    } catch (e) {
      if (e?.beforeFirstToken && !started) {
        // Nothing reached the caller yet: answer from the real Ollama instead.
        stats.fellThrough++;
        log(`fleet  ${b.model}  failed before first token (${e.message}) — passing through`);
        return pipeUpstream(req, res, raw);
      }
      log(`fleet  ${b.model}  failed mid-stream: ${e?.message}`);
      if (stream) { start(); res.end(JSON.stringify({ error: e?.message || "fleet error" }) + "\n"); }
      else json(res, 502, { error: e?.message || "fleet error" });
    }
  }

  /* ------------------------------------------------ OpenAI: chat/completions */

  /** POST /api/race — one request to several small hosted models AT ONCE (the cheap remote tier).
   *  body { messages, models?: ["provider:model", …], n?: 1..6 (default 3), mode?: "first" | "all", max_tokens?, temperature?, heimdall_privacy }.
   *  No `models` = the loaded hosted open models, one per provider first so the lanes differ. The same sealed gate as chat:
   *  the Fold seals first and says so. "first" answers with the first success (the slower calls still finish and are
   *  ledgered — their cost is real); "all" waits for every call, so the caller can compare or witness. Benched lanes are
   *  skipped, and every outcome feeds the circuit breaker exactly as the ladder's does. */
  async function raceChat(req, res) {
    const b = await readJson(req);
    const privacy = b.heimdall_privacy || b.privacy || null;
    if (!frontierGate(privacy)) { stats.frontierRefused++; return json(res, 400, { error: `race lanes are sealed-only — send heimdall_privacy:"sealed-external" (or "explicit"); the Fold selects its privacy mode and seals first` }); }
    if (!Array.isArray(b.messages) || !b.messages.length) return json(res, 400, { error: "body needs { messages: [...] }" });
    const messages = b.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("") }));
    const mode = b.mode === "all" ? "all" : "first";
    const n = Math.min(6, Math.max(1, Math.floor(Number(b.n) || 3)));
    let lanes;
    if (Array.isArray(b.models) && b.models.length) {
      const unknown = b.models.filter((m) => !frontierMap.has(m));
      if (unknown.length) return json(res, 400, { error: `not loaded on this bridge: ${unknown.join(", ")} (see /api/frontier)` });
      lanes = [...new Set(b.models.map((m) => frontierMap.get(m)))].slice(0, 6);
    } else {
      const hostedOnes = [...new Set(frontierMap.values())].filter((ex) => isHostedOpen(ex.provider));
      const firstOfEach = [], rest = [], seenProv = new Set();
      for (const ex of hostedOnes) (seenProv.has(ex.provider) ? rest : firstOfEach).push(ex), seenProv.add(ex.provider);
      lanes = [...firstOfEach, ...rest];
      // a lane that is already full is left out; if every lane is full, the least loaded one still takes the call
      const open = lanes.filter((ex) => !isDown(ex) && !saturated(ex));
      const live = lanes.filter((ex) => !isDown(ex));
      lanes = (open.length ? open : live.sort((a, c) => (laneInflight.get(a) || 0) - (laneInflight.get(c) || 0)).slice(0, 1)).slice(0, n);
    }
    lanes = lanes.filter((ex) => !isDown(ex));
    if (!lanes.length) return json(res, 404, { error: "no hosted model is loaded (or all are benched) — add a key for OpenRouter, Together, Fireworks or DeepInfra" });
    const opts = { messages, temperature: b.temperature ?? 0.7, max_tokens: b.max_tokens ?? b.max_completion_tokens ?? 512 };
    const t0 = Date.now();
    const controllers = lanes.map(() => new AbortController());
    const calls = lanes.map(async (ex, idx) => {
      const id = `${ex.provider}:${ex.model}`;
      try {
        const out = await runOnFrontier(id, { ...opts, signal: controllers[idx].signal }, null);
        noteOk(ex);
        return { ok: true, model: id, provider: ex.provider, text: out.text, ms: out.ms ?? Date.now() - t0, tokens: outputTokensOf(out) };
      } catch (e) {
        if (!e?.aborted) noteFail(ex, e);
        return { ok: false, cancelled: !!e?.aborted, model: id, provider: ex.provider, error: String(e?.message ?? e).slice(0, 200), status: e?.status ?? null, ms: Date.now() - t0 };
      }
    });
    stats.race = (stats.race || 0) + 1;
    if (mode === "all") {
      const results = await Promise.all(calls);
      const winner = results.filter((r) => r.ok && r.text).sort((a, c) => a.ms - c.ms)[0] || null;
      return json(res, 200, { mode, winner, results, asked: results.length });
    }
    const settled = [];
    const winner = await new Promise((resolve) => {
      let left = calls.length;
      calls.forEach((c, idx) => c.then((r) => {
        settled.push(r);
        if (r.ok && r.text) { controllers.forEach((ac, k) => { if (k !== idx) ac.abort(); }); resolve(r); }   // the others stop NOW: their tokens are never spent
        else if (--left === 0) resolve(null);
      }));
    });
    return json(res, winner ? 200 : 502, { mode, winner, results: settled.slice(), asked: calls.length, pending: Math.max(0, calls.length - settled.length) });
  }

  async function openaiChat(req, res, raw) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
    const privacy = b.heimdall_privacy || b.privacy || null;
    defaultToWebllm(b);
    if (isFrontier(b.model) && !frontierGate(privacy)) {
      stats.frontierRefused++;
      return json(res, 400, { error: { message: frontierRefusal(b.model) } });
    }
    if (b.response_format || b.tools?.length || !fleetServes(b.model)) return pipeUpstream(req, res, raw);
    const messages = (b.messages || []).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : (m.content || []).map((p) => p.text || "").join("") }));
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null) => ({ id, object: "chat.completion.chunk", created, model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    let started = false;
    const start = () => {
      if (started || !b.stream) return;
      started = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
    };
    try {
      const out = await runOnGiver(
        b.model,
        { messages, temperature: b.temperature ?? 0.7, max_tokens: b.max_tokens ?? b.max_completion_tokens ?? 1024, signal: goneOr(res, 600_000) },
        (delta) => { start(); if (b.stream) res.write(`data: ${JSON.stringify(chunk({ content: delta }))}\n\n`); },
      );
      stats[out.lane] = (stats[out.lane] || 0) + 1;
      if (b.stream) {
        start();
        res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
        if (out.usage) res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: b.model, choices: [], usage: usageOf(out) })}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        json(res, 200, { id, object: "chat.completion", created, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }], usage: usageOf(out) });
      }
    } catch (e) {
      if (e?.beforeFirstToken && !started) { stats.fellThrough++; return pipeUpstream(req, res, raw); }
      if (b.stream) { start(); res.end(`data: ${JSON.stringify({ error: { message: e?.message } })}\n\n`); }
      else json(res, 502, { error: { message: e?.message || "fleet error" } });
    }
  }

  /* ---------------------------------------------- Anthropic: /v1/messages */

  async function anthropicChat(req, res, raw) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: { type: "invalid_request_error", message: "invalid JSON" } }); }
    const privacy = b.heimdall_privacy || b.privacy || null;
    defaultToWebllm(b);
    if (isFrontier(b.model) && !frontierGate(privacy)) {
      stats.frontierRefused++;
      return json(res, 400, { error: { type: "invalid_request_error", message: frontierRefusal(b.model) } });
    }
    if (!fleetServes(b.model)) return anthropicFloor(req, res, raw, b);
    const messages = [];
    if (b.system) messages.push({ role: "system", content: String(b.system) });
    for (const m of b.messages || []) {
      const content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((p) => p.text || "").join("") : "");
      messages.push({ role: m.role, content });
    }
    const id = `msg_${randomUUID()}`;
    const stream = b.stream === true;
    let started = false;
    const start = () => {
      if (started || !stream) return;
      started = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: b.model, content: [], stop_reason: null } })}\n\n`);
    };
    try {
      const out = await runOnGiver(
        b.model,
        { messages, temperature: b.temperature ?? 0.7, max_tokens: b.max_tokens ?? 1024 },
        (delta) => {
          start();
          if (stream) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } })}\n\n`);
        },
      );
      if (stream) {
        start();
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: out.tokens } })}\n\n`);
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      } else {
        json(res, 200, { id, type: "message", role: "assistant", model: b.model, content: [{ type: "text", text: out.text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: out.tokens } });
      }
    } catch (e) {
      if (e?.beforeFirstToken && !started) { stats.fellThrough++; return anthropicFloor(req, res, raw, b); }
      if (stream) { start(); res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e?.message } })}\n\n`); }
      else json(res, 502, { error: { type: "api_error", message: e?.message || "fleet error" } });
    }
  }

  /* ---------------------------------------------------------- static */

  function serveStatic(req, res) {
    if (!dist) return json(res, 404, { error: "no page is served by this bridge" });
    const u = new URL(req.url, "http://x");
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { return json(res, 400, { error: "malformed URL escape" }); }
    if (p === "/" || p === "") p = "/index.html";
    const root = path.resolve(dist);
    const file = path.resolve(path.join(root, p));
    // compare against dist + separator: a sibling like "dist-secret" shares the prefix "dist" and must not pass
    if (file !== root && !file.startsWith(root + path.sep)) return json(res, 403, { error: "forbidden" });
    // The bridge's own page hands the browser the access token (HttpOnly, SameSite=Strict, own origin only).
    const own = !req.headers.origin || selfOriginsOn(localPortOf(req)).has(req.headers.origin);
    const cookieHeader = own && (p === "/index.html" || p === "/app.html") ? { "set-cookie": tokenCookie() } : {};
    fs.readFile(file, (err, data) => {
      if (err) {
        if (p.includes(".")) return json(res, 404, { error: "not found" });
        return fs.readFile(path.join(root, "index.html"), (e2, idx) => {
          if (e2) return json(res, 500, { error: "dist/index.html missing — run npm run build" });
          res.writeHead(200, { "content-type": TYPES[".html"], ...(own ? { "set-cookie": tokenCookie() } : {}) });
          res.end(idx);
        });
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": p === "/index.html" || p.endsWith("sw.js") ? "no-cache" : "public, max-age=3600", ...cookieHeader });
      res.end(data);
    });
  }
  const tokenCookie = () => `heimdall_token=${accessToken}; Path=${cookiePath}; HttpOnly; SameSite=Strict`;

  // Keyless web search and page reading FROM THIS MACHINE (websearch.js): the query goes to the engine's own site
  // from the person's own address — no relay, no translate proxy in the middle.
  const searcher = makeSearcher();

  /* ---------------------------------------------------------- router */

  /** Does this route need the access token? (bridge-only surfaces; everything else is the open Ollama/OpenAI/Anthropic doors + accounting.) */
  const tokenRoute = (method, pathname) =>
    (pathname.startsWith("/bridge/") && !(method === "GET" && pathname === "/bridge/hello")) // hello stays open: khora's client uses it to tell a bridge from a daemon
    || (pathname.startsWith("/link/") && pathname !== "/link/") // /link/hosts, /link/probe, /link/host, /link/remove
    || pathname === "/api/code"
    || pathname.startsWith("/api/providers/")
    || pathname === "/api/dispatch/observe";
  const hasToken = (req) => {
    if (safeEqual(req.headers["x-heimdall-token"], accessToken)) return true;
    // the cookie counts only from this bridge's own origin (or no Origin at all): never on behalf of a foreign page
    const o = req.headers.origin;
    if (o && !selfOriginsOn(localPortOf(req)).has(o)) return false;
    return safeEqual(parseCookies(req.headers.cookie).heimdall_token, accessToken);
  };

  /** The handler: usable as this bridge's own listener (listen()) or mounted inside another server's listener. Under a prefix it
   *  answers only paths below it (and strips it); everything else is not its business and gets a plain 404 here. */
  async function handler(req, res) {
    if (prefix) {
      const q = req.url || "/";
      if (q !== prefix && !q.startsWith(prefix + "/") && !q.startsWith(prefix + "?")) return json(res, 404, { error: "not found" });
      req.url = q.slice(prefix.length) || "/";
    }
    // Only this page and an explicitly allowlisted page may talk to the bridge from a browser; origin-less local clients
    // are held by the Host check below and (on bridge-only routes) by the token. Never a blanket "*".
    const origin = req.headers.origin;
    const pageOrigin = typeof origin === "string" && (selfOriginsOn(localPortOf(req)).has(origin) || allowedOriginSet.has(origin)) ? origin : null;
    if (origin && !pageOrigin) return json(res, 403, { error: `origin ${origin} not allowed` });
    // DNS rebinding: a name that resolves to 127.0.0.1 but is not ours (attacker.test) must not read prompts or keys.
    if (!hostAllowed(req)) return json(res, 403, { error: `host ${req.headers.host || "(none)"} not allowed` });
    if (pageOrigin) {
      res.setHeader("access-control-allow-origin", pageOrigin);
      res.setHeader("vary", "Origin");
      // an allowlisted page (not our own) may send the cookie; the Origin wall already decided who it is
      if (allowedOriginSet.has(pageOrigin) && !selfOriginsOn(localPortOf(req)).has(pageOrigin)) res.setHeader("access-control-allow-credentials", "true");
    }
    if (req.method === "OPTIONS") {
      if (pageOrigin) {
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", String(req.headers["access-control-request-headers"] || "content-type"));
      }
      res.writeHead(204);
      return res.end();
    }
    let u;
    try { u = new URL(req.url, "http://x"); } catch { return json(res, 400, { error: "malformed URL" }); }
    const route = `${req.method} ${u.pathname}`;
    if (tokenRoute(req.method, u.pathname)) {
      // /api/code is also open to an explicitly allowlisted page origin (the fold's own origin) without a token
      const viaOrigin = u.pathname === "/api/code" && pageOrigin && allowedOriginSet.has(pageOrigin);
      if (!viaOrigin && !hasToken(req)) return json(res, 401, { error: "this route needs the bridge's access token (x-heimdall-token, or the cookie the bridge's own page sets)" });
    }
    // Request-scoped audit context: the surface's audit id, its place in a set of
    // possible worlds (never WHICH one is real), the route and the caller.
    const ctx = { auditId: String(req.headers["x-fold-audit"] || "").slice(0, 80) || null, worlds: parseWorlds(req.headers["x-fold-worlds"]), route, caller: String(req.headers["x-er7-caller"] || req.headers["x-fold-caller"] || "").slice(0, 60) || null };
    return callCtx.run(ctx, () => route_(req, res, u, route, pageOrigin));
  }

  const server = http.createServer(handler);

  async function route_(req, res, u, route, pageOrigin) {
    try {
      switch (route) {
        case "POST /api/dispatch/plan": {
          const b = await readJson(req);
          const ctxTokens = Number.isFinite(+b.ctxTokens) && +b.ctxTokens > 0 ? +b.ctxTokens : (Array.isArray(b.messages) ? messagesTokens(b.messages) : 0);
          const privacy = ["local-only", "sealed-external", "any"].includes(b.privacy) ? b.privacy : "sealed-external";
          const p = planDispatch({ taskClass: b.taskClass || "code.edit", ctxTokens, privacy, reserveOut: b.reserveOut }, await dispatchCandidates(), comp, { minPass: b.minPass ?? 0.7, explore: b.explore ?? 0.15, outTokens: b.outTokens ?? 600 });
          return json(res, 200, p);
        }
        case "POST /api/dispatch/observe": {
          const b = await readJson(req);
          // the table is bounded: a NEW (model, class, size) cell past the cap is refused (an existing cell can always be updated)
          if (typeof b.model !== "string" || b.model.length > 200 || (b.taskClass != null && (typeof b.taskClass !== "string" || b.taskClass.length > 80))) return json(res, 400, { error: "observe needs { model: string ≤200, taskClass?: string ≤80, ok }" });
          const cellBucket = bucketLabel(bucketOf(+b.ctxTokens || 0));
          const cells = comp.cells();
          if (cells.length >= maxCompetenceCells && !cells.some((x) => x.model === b.model && x.taskClass === (b.taskClass || "code.edit") && x.bucket === cellBucket)) return json(res, 429, { error: `the competence table is full (${maxCompetenceCells} cells)` });
          const c = comp.observe({ model: b.model, taskClass: b.taskClass || "code.edit", ctxTokens: +b.ctxTokens || 0, ok: b.ok, ms: b.ms ?? null, usd: b.usd ?? null, outTokens: b.outTokens ?? null });
          if (!c) return json(res, 400, { error: "observe needs { model, ok: true|false } — ok must be a verdict from a test or a ruling, never the model's own word" });
          saveComp();
          return json(res, 200, { ok: true, estimate: comp.estimate(b.model, b.taskClass || "code.edit", +b.ctxTokens || 0) });
        }
        case "GET /api/dispatch/competence":
          return json(res, 200, { cells: comp.cells() });
        case "GET /api/audit": {
          // WHAT LEFT THIS MACHINE, exactly as sent (bodies included). Optional:
          // ?since=<seq>  ?limit=<n>  ?auditId=<id>  ?setId=<world set>
          const q = u.searchParams;
          if (q.get("auditId")) return json(res, 200, { entries: ledger.byAuditId(q.get("auditId")), summary: ledger.summary() });
          if (q.get("setId")) return json(res, 200, { entries: ledger.bySet(q.get("setId")), summary: ledger.summary() });
          return json(res, 200, { ...ledger.list({ since: +q.get("since") || 0, limit: +q.get("limit") || 100 }), summary: ledger.summary() });
        }
        case "GET /bridge/hello":
          return json(res, 200, { bridge: true, site, upstream, passthrough, lendModel, port: localPortOf(req) });
        case "GET /bridge/events": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": heimdall bridge\n\n");
          tabs.add(res);
          noTabsSince = null;
          // bounded: past maxTabs the OLDEST controller connection is dropped (the newest is the controller anyway)
          while (tabs.size > maxTabs) { const old = tabs.values().next().value; tabs.delete(old); try { old.end(); } catch {} }
          const ka = setInterval(() => res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`), PING_MS);
          ka.unref?.();
          const dropped = () => {
            clearInterval(ka);
            tabs.delete(res);
            if (tabs.size === 0) noTabsSince = Date.now();
            // a job handed to a tab that is gone can only hang: fail it NOW, before its first token, so the ladder steps down
            for (const j of jobs.values()) if (j.tab === res) j.onMsg({ type: "error", message: "the controller tab closed" });
          };
          req.on("close", dropped);
          res.on("close", dropped);
          log(`controller tab connected (${tabs.size} open)`);
          return;
        }
        case "POST /bridge/state": {
          const st = await readJson(req, { limit: MAX_STATE_BYTES });
          if (!st || typeof st !== "object" || Array.isArray(st)) throw new HttpError(400, "state must be a JSON object");
          state = st;
          stateAt = Date.now();
          return json(res, 200, { ok: true });
        }
        case "POST /bridge/reply": {
          const batch = await readJson(req, { fallback: [], limit: MAX_STATE_BYTES });
          for (const m of Array.isArray(batch) ? batch : [batch]) jobs.get(m?.id)?.onMsg(m);
          return json(res, 200, { ok: true });
        }
        case "GET /bridge/upstream/tags":
          return pipeUpstream(req, res, Buffer.alloc(0), "/api/tags");
        case "POST /bridge/upstream/chat":
          return pipeUpstream(req, res, await readBody(req), "/api/chat");
        case "GET /status":
          // `pending` is this bridge's own in-flight fleet jobs — measured
          // here, not reported by the tab, so it's never stale between the
          // tab's 5s state posts.
          return json(res, 200, { tab: tabAlive(), room: state?.room ?? null, workers: state?.workers ?? [], lending: state?.self ?? null, pending: jobs.size, stats, upstream, upstreams: upstreamList, passthrough, links: publicLinks(), linksFile, diag: state?.diag ?? {}, hostRecv: state?.hostRecv ?? [] });
        case "GET /link":
        case "GET /link/": {
          // the link page is the bridge's own page: from its own origin it carries the token cookie its buttons need
          const own = !req.headers.origin || selfOriginsOn(localPortOf(req)).has(req.headers.origin);
          res.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
          if (own) res.setHeader("set-cookie", tokenCookie());
          return sendHtml(res, linkPage(localPortOf(req)));
        }
        case "GET /link/hosts":
          return json(res, 200, { links: publicLinks() });
        case "POST /link/probe": {
          const b = await readJson(req);
          if (typeof b.url !== "string" || !b.url.trim() || b.url.length > 300) throw new HttpError(400, "body needs { url }");
          return json(res, 200, await probeEndpoint(b.url, { key: typeof b.key === "string" ? b.key : null }));
        }
        case "POST /link/host": {
          const b = await readJson(req);
          // validated BEFORE anything is probed or stored: this route makes the bridge call an address and outranks the fleet
          if (typeof b.url !== "string" || !b.url.trim() || b.url.length > 300) throw new HttpError(400, "body needs { url }");
          for (const f of ["name", "tag", "model", "key"]) if (b[f] != null && (typeof b[f] !== "string" || b[f].length > 200)) throw new HttpError(400, `${f} must be a string of at most 200 characters`);
          const given = normalizeUrl(b.url);
          if (!given || !/^https?:\/\//i.test(b.url.trim().includes("://") ? b.url.trim() : "http://" + b.url.trim())) throw new HttpError(400, "url must be an http(s) address");
          if (isMetadataHost(given)) throw new HttpError(400, "that address is a cloud-metadata endpoint, not a model server");
          const probe = await probeEndpoint(b.url, { key: b.key || null });
          if (!probe.ok) return json(res, 400, probe);
          const model = b.model || probe.models[0] || "local";
          const tag = b.tag || guessTag(model) || probe.models[0] || "local";
          const name = b.name || probe.url.replace(/^https?:\/\//, "");
          links = saveLinks(upsertLink(links, { name, url: probe.url, kind: probe.kind, model, tag, models: probe.models, ...(b.key ? { key: b.key } : {}) }), linksFile);
          log(`linked native host ${name} (${probe.kind}) at ${probe.url} → ${tag}`);
          return json(res, 200, { ok: true, links: publicLinks() });
        }
        case "POST /link/remove": {
          const b = await readJson(req);
          if (typeof b.url !== "string") throw new HttpError(400, "body needs { url }");
          links = saveLinks(removeLink(links, b.url), linksFile);
          return json(res, 200, { ok: true, links: publicLinks() });
        }
        case "GET /api/version":
          return json(res, 200, { version: "0.0.0-heimdall-bridge" });
        case "GET /api/ps":
          return json(res, 200, { models: fleetModels().map((m) => ({ ...m, size_vram: 0, expires_at: new Date(Date.now() + tabFreshMs).toISOString() })) });
        case "GET /api/tags": {
          const fleet = fleetModels();
          let up = [];
          if (passthrough) {
            try { up = (await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(3000) })).json()).models ?? []; } catch {}
          }
          const names = new Set(fleet.map((m) => m.name));
          return json(res, 200, { models: [...fleet, ...up.filter((m) => !names.has(m.name))] });
        }
        case "POST /api/chat":
          return ollamaRun(req, res, await readBody(req), "chat");
        case "POST /api/generate":
          return ollamaRun(req, res, await readBody(req), "generate");
        case "POST /v1/chat/completions":
          return openaiChat(req, res, await readBody(req));
        case "POST /v1/messages":
          return anthropicChat(req, res, await readBody(req));
        case "GET /v1/models":
          return json(res, 200, { object: "list", data: fleetModels().map((m) => ({ id: m.name, object: "model", owned_by: m.heimdall?.frontier ? "heimdall-frontier:" + m.heimdall.frontier : "heimdall-fleet" })) });
        case "POST /api/race":
          return raceChat(req, res);
        case "POST /api/job": {
          // THE JOB LANE (escalation design): body { job, payload:{capsule|messages}, context? } → the decision trace, route used,
          // attempts, proposal and the local acceptance verdicts. See src/job-lane.js.
          let b = await readJson(req);
          const out = await jobLane.handle(b);
          if (out.status === 200) log(`job  ${out.body.jobId}  ${out.body.state}  via ${out.body.route}  ${out.body.attempts.length} attempt(s)`);
          return json(res, out.status, out.body);
        }
        case "GET /api/route-stats":
          // Measured accept rate per route × taskClass (Laplace-smoothed Beta prior; persisted).
          return json(res, 200, routeStats.snapshot());
        case "GET /api/ledger":
          return json(res, 200, { entries: dispatchLedger.slice(-200) });
        case "GET /api/meter":
          return json(res, 200, dispatchMeter(dispatchLedger, { ...ESTIMATE_COSTS, price: priceFor }));
        case "GET /api/frontier": {
          // Which frontier providers are configured on THIS machine and what
          // they expose — model names and privacy class, never keys.
          const providers = [];
          for (const [name, ex] of frontierMap) providers.push({ model: name, provider: ex.provider, privacy: "sealed-external", reachable: !!ex.live?.reachable, stale: !!ex.live?.stale, down: isDown(ex), inflight: laneInflight.get(ex) || 0, slots: slotsFor(ex), ...(isDown(ex) ? { downUntil: new Date(healthOf(ex).downUntil).toISOString(), lastStatus: healthOf(ex).lastStatus } : {}), endpoint: ex.endpoint });
          return json(res, 200, { configured: frontierMap.size > 0, providers, keySource: "server-side (heimdall key / HEIMDALL_KEY_* / the surface, never an outside executor)", gate: 'requests must carry heimdall_privacy:"sealed-external" (Fold privacy mode)' });
        }
        case "GET /api/providers/keys": {
          // Which providers have a key set — a masked tail only (••••abcd), never the key itself — and whether the
          // running bridge has actually LOADED it (`loaded`: it offers at least one model for that provider).
          const stored = readState(stateFile).providerKeys || {};
          const { maskKey } = await import("./keycheck.js");
          return json(res, 200, { providers: Object.entries(stored).map(([p, k]) => ({ provider: p, set: true, masked: maskKey(typeof k === "string" ? k : k?.key), loaded: providerModelsLoaded(p).length > 0, models: providerModelsLoaded(p) })), keySource: "server-side (never a browser)" });
        }
        case "POST /api/providers/refresh": {
          // Re-run discovery against the keys already stored on this machine (the CLI's `heimdall key` writes the state
          // file but cannot reach into a running bridge; this is the key-free nudge). No key in the request or response.
          if (!LOOPBACK_ADDR.test(req.socket?.remoteAddress || "")) return json(res, 403, { error: "only this machine can ask the bridge to reload keys" });
          const n = await refreshFrontier();
          const loaded = {};
          for (const [, ex] of frontierMap) (loaded[ex.provider] ||= new Set()).add(ex.model);
          log(`provider keys reloaded (${n < 0 ? "discovery failed" : n + " model(s) reachable"})`);
          return json(res, 200, { ok: n >= 0, models: n, providers: Object.fromEntries(Object.entries(loaded).map(([p, v]) => [p, [...v]])) });
        }
        case "POST /api/providers/check": {
          // "Test again": re-run the live check on the key ALREADY stored for a provider (the key is read here, server-side;
          // the request carries only the provider name) and report in plain words.
          if (!LOOPBACK_ADDR.test(req.socket?.remoteAddress || "")) return json(res, 403, { error: "provider keys can only be tested from this machine" });
          let b = await readJson(req);
          const provider = String(b.provider || "").toLowerCase();
          const stored = readState(stateFile).providerKeys?.[provider];
          const key = typeof stored === "string" ? stored : stored?.key;
          if (!key) return json(res, 404, { error: `no ${provider} key is stored on this machine` });
          return keyAdded(res, provider, key, { retest: true });
        }
        case "POST /api/providers/keys": {
          // Enter an Anthropic/OpenAI (or other catalogued) provider key from a
          // surface. It is written to the SAME server-side state the CLI uses
          // (`heimdall key`) and never echoed back. LOOPBACK ONLY: a key can
          // only be set by a request whose socket is on this machine, so a LAN
          // client or a proxied request cannot plant one.
          const addr = req.socket?.remoteAddress || "";
          if (!LOOPBACK_ADDR.test(addr)) return json(res, 403, { error: "provider keys can only be set from this machine" });
          let b = await readJson(req);
          const provider = String(b.provider || "").toLowerCase();
          const { catalogFor } = await import("./providers.js");
          if (!catalogFor(provider)) return json(res, 400, { error: `unknown provider "${provider}"` });
          if (provider === "vertex") return json(res, 403, { error: "the vertex lane is configured by the operator's environment (HEIMDALL_VERTEX_PROJECT), not entered from a surface" });
          if (b.remove) {
            return exclusive(async () => {
              const st = readState(stateFile);
              st.providerKeys = st.providerKeys || {};
              delete st.providerKeys[provider];
              if (st.providerModels) delete st.providerModels[provider];
              writeState(st, stateFile);
              const models = await refreshFrontier();
              log(`provider key removed for ${provider} (server-side; ${models < 0 ? "discovery failed" : models + " model(s) reachable"})`);
              return json(res, 200, { ok: true, provider, stored: false, configured: Object.keys(st.providerKeys), frontierModels: models, keySource: "server-side (never a browser)" });
            });
          }
          if (!(typeof b.key === "string" && b.key.trim())) return json(res, 400, { error: "body needs { provider, key } or { provider, remove: true }" });
          return keyAdded(res, provider, b.key.trim(), { named: Array.isArray(b.models) ? b.models.filter((m) => typeof m === "string" && m) : [] });
        }
        case "GET /api/code/status":
          return json(res, 200, { configured: !!opencodeUrl, url: opencodeUrl, note: "the machine door: coding runs on this machine's opencode server, routed through heimdall" });
        case "POST /api/code": {
          // The coding lane, through heimdall. A coding job is agentic file
          // and shell work on THIS machine, so it runs on the local opencode
          // server (a machine organ inside the trust domain) — never an
          // outside executor. The MODEL opencode reasons with is itself
          // routed by heimdall when opencode points at this bridge's /v1, so
          // the best/safest/cheapest rule still holds one level down.
          const b = await readJson(req); // parsed first: a malformed body is a 400 whether or not a machine is attached
          if (!opencodeUrl) return json(res, 501, { error: "no coding machine attached — run `opencode serve` and set HEIMDALL_OPENCODE (or OPENCODE_URL), then heimdall up" });
          if (!b || typeof b.prompt !== "string" || !b.prompt.trim()) return json(res, 400, { error: "body needs { prompt }" });
          const t0 = Date.now();
          // Plain model string: the fold sends { providerID, modelID }; penelope
          // wants the plain name.
          const ref = b.model || null;
          const plainModel = typeof ref === "string" ? ref : (ref?.modelID || ref?.id || "qwen2.5-coder:1.5b");
          // TOOL-CAPABILITY (the doctrine, 2026-10-04): a small local model is
          // NEVER handed tools. A model may drive the machine door (opencode)
          // only when it is genuinely tool-capable — an explicit caller flag, a
          // heimdall frontier model (sealed-external), or a name in
          // HEIMDALL_CODE_TOOL_CAPABLE. Everything else is a small local mouth:
          // the job routes to penelope's robust coding pipeline (artifact:
          // code-agent), where the machine composes the sub-agents — swarm →
          // field → hunt → mouth, parallel, escalating to a frontier mouth at
          // the wall — and the small model draws only residue, never tools.
          // a caller-supplied `toolCapable` is IGNORED: a request cannot promote a small model to a tool-driving one
          const toolCapable = isFrontier(plainModel) || String(process.env.HEIMDALL_CODE_TOOL_CAPABLE || "").split(",").map((s) => s.trim()).filter(Boolean).includes(plainModel);
          try {
            if (!toolCapable) {
              // THE PENELOPE LANE — the machine composes; the small mouth draws
              // residue. Penelope owns generation; heimdall only routes (the
              // /api/read and /api/weave pattern). ITERATION VIA THE RECORD: a
              // session that already coded carries its prior artifact forward as
              // context.prior, so the next turn is a CHANGE, not a fresh build.
              const prior = b.sessionId ? codeArtifacts.get(b.sessionId) : null;
              const r = await fetch(weaveUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-er7-user": "penelope", "x-er7-caller": "fold-bridge" },
                body: JSON.stringify({ intent: b.prompt, artifact: "code-agent", model: plainModel, constraints: b.constraints ?? null, context: { ...(b.context ?? {}), ...(prior ? { prior } : {}) }, verification: b.verification ?? null }),
                signal: goneOr(res, 1500000),
              });
              const j = await r.json().catch(() => ({ ok: false, status: "error", error: "penelope code-agent returned no json" }));
              const codeValue = j?.artifact?.value ?? null;
              // The store is keyed by the session id the CALLER receives — for
              // the first turn that is the id generated here (a caller with no
              // prior session must still land an artifact the next turn can
              // carry). Measured 2026-10-04: keying on the incoming id only
              // dropped the first artifact and iteration reinvented functions.
              const sessionId = b.sessionId || ("ses_" + randomUUID().replace(/-/g, "").slice(0, 22));
              if (codeValue) rememberCode(sessionId, { code: String(codeValue).slice(0, 200_000), task: String(b.prompt).slice(0, 20_000) });
              const outcomes = Array.isArray(j?.evidence?.outcomes) ? j.evidence.outcomes : [];
              // The sub-agent composition, one activity row per act.
              const activity = outcomes.map((o) => ({ tool: String(o.stage ?? "agent"), status: (o.refused || o.walled) ? (o.refused ? "refused" : "walled") : "done", title: o.unit ?? null }));
              if (j?.verification?.verdict?.reason) {
                activity.push({ tool: "gate", status: j.verification.verdict.ok ? "passed" : "failed", title: j.verification.verdict.reason });
              }
              const text = codeValue || "(penelope's coding pipeline returned no artifact — " + (j?.error || j?.status || "unknown") + ")";
              stats.code++;
              recordDispatch(
                { id: "code-" + randomUUID(), taskClass: "code.gen", privacy: "local-raw" },
                "penelope:code-agent",
                "machine-door",
                { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: !!codeValue },
                "deterministic/local",
              );
              log(`code  penelope-code-agent  ${outcomes.length} sub-agent step(s)  ${Date.now() - t0}ms`);
              return json(res, 200, {
                sessionId, text, activity, ms: Date.now() - t0,
                iterated: false, lane: "penelope-code-agent", executed: false,
                agents: { swarm: j?.swarm ?? null, dispositions: j?.subAgents?.dispositions ?? [], escalated: j?.subAgents?.escalated ?? false, frontier: j?.frontier ?? null, units: (j?.units ?? []).map((u) => u.name), verdict: j?.verification?.verdict ?? null },
              });
            }
            // OPENCODE LANE — the agentic outside device. With a tool-capable
            // model it reads/writes/runs on the real tree and may spawn its own
            // sub-agents (opencode's task tool); opencode-lane surfaces those
            // spans as activity.
            const out = await opencodeCode(opencodeUrl, { prompt: b.prompt, title: b.title || null, model: b.model || null, agent: b.agent || null, system: b.system || null, sessionId: b.sessionId || null, cwd: b.cwd || null }, { fetchImpl: opencodeFetch });
            stats.code++;
            recordDispatch(
              { id: "code-" + randomUUID(), taskClass: "code.repair", privacy: "local-raw" },
              "opencode:" + (out.sessionId || "session"),
              "machine-door",
              { ms: out.ms, inputTokens: 0, outputTokens: 0, accepted: !!out.text },
              "deterministic/local",
            );
            log(`code  opencode  ${out.activity.length} tool step(s)  ${out.ms}ms`);
            return json(res, 200, { sessionId: out.sessionId, text: out.text, activity: out.activity, ms: out.ms, iterated: !!out.iterated, lane: "opencode", executed: true });
          } catch (e) {
            return json(res, 502, { error: "the coding lane did not answer: " + String(e?.message || e) });
          }
        }
        case "POST /api/weave": {
          // THE GENERATION LANE (2026-10-04): the fold surfaces' "write /
          // compose / draft …" turns enter HERE and ride penelope's weave —
          // the generation system's void detection (units read from the ask,
          // a void read with a hunt) and writing across prompts (one unit per
          // draw, field → hunt → mouth, test decides, EOT). Penelope owns
          // generation; the bridge only routes (the /api/read pattern). Named
          // /api/weave, NOT /api/generate — the bridge's /api/generate is the
          // Ollama-compatible generate door (model+prompt), and a generation
          // request is not an ollama draw. A weave hunts and draws many times,
          // so the socket waits on penelope's own pace, never a short read
          // timeout.
          const b = await readJson(req);
          if (!b || typeof b.intent !== "string" || !b.intent.trim()) return json(res, 400, { error: "body needs { intent }" });
          try {
            const r = await fetch(weaveUrl, {
              method: "POST",
              headers: { "content-type": "application/json", "x-er7-user": "penelope", "x-er7-caller": "fold-bridge" },
              body: JSON.stringify({ intent: b.intent, artifact: b.artifact ?? "text", constraints: b.constraints, context: b.context, verification: b.verification, model: b.model ?? null, noModel: b.noModel === true }),
              signal: AbortSignal.timeout(1500000),
            });
            const j = await r.json().catch(() => ({ ok: false, status: "error", error: "penelope weave returned no json" }));
            log(`weave  penelope  intent="${String(b.intent).slice(0, 60)}"  ${j.status ?? r.status}  ${(j.evidence?.units || []).length} unit(s)`);
            return json(res, r.ok ? 200 : (j.status === "void" ? 200 : 422), j);
          } catch (e) {
            return json(res, 502, { error: "penelope weave did not answer: " + String(e?.message || e) });
          }
        }
        case "GET /api/search": {
          // Web search from this machine. Same shape as the Fold's relay (`{scope,q,engine,count,results}`) so a
          // page can use either; `via` says who made the request, and a failure is typed (`tried` names each
          // engine and why it did not answer) — never an empty list pretending nothing exists.
          const q = String(u.searchParams.get("q") || "").trim();
          if (!q) return json(res, 400, { error: "q is required" });
          const t0 = Date.now();
          const out = await searcher.search(q);
          log(`search  web  ${out.error ? "FAILED" : out.engine}${out.cached ? " (cached)" : ""}  "${q.slice(0, 50)}"  ${out.results?.length ?? 0} result(s)  ${Date.now() - t0}ms`);
          if (out.error) return json(res, 502, { scope: "web", q, error: out.error, tried: out.tried, via: "this machine" });
          return json(res, 200, { scope: "web", q, engine: out.engine, count: out.results.length, results: out.results, tried: out.tried, via: "this machine", cached: !!out.cached });
        }
        case "GET /api/page": {
          // Read one public web page from this machine (no CORS wall, no third-party proxy learning the address).
          // Public hosts only, capped, time-boxed; the origin gate above already refuses other websites.
          const target = String(u.searchParams.get("url") || "").trim();
          if (!target) return json(res, 400, { error: "url is required" });
          const t0 = Date.now();
          const page = await fetchPage(target);
          log(`page    web  ${page.ok ? "ok" : "refused:" + page.code}  ${target.slice(0, 70)}  ${page.ok ? page.text.length + "B" : ""}  ${Date.now() - t0}ms`);
          if (!page.ok) return json(res, page.code === "http" ? 502 : 422, { ok: false, error: page.error, code: page.code, url: target });
          res.writeHead(200, { "content-type": page.contentType || "text/html; charset=utf-8", "x-fold-via": "this machine", "x-fold-final-url": page.finalUrl, "x-fold-truncated": page.truncated ? "1" : "0", "cache-control": "no-store" });
          return res.end(page.text);
        }
        case "POST /api/read": {
          // Attachments are READ, never forwarded raw. The bridge hands the
          // bytes to the khora's model-free constitutional reader (the
          // perceiver) and returns the reading (EORead@1) — referents,
          // relations, basis. The surface shows the reading; the model never
          // receives the raw file. The reader URL is the khora engine proxy.
          const b = await readJson(req, { limit: maxReadBytes });
          const text = String(b.text ?? "");
          if (!text.trim()) return json(res, 400, { error: "body needs { text }" });
          try {
            const r = await fetch(readUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text, ...(b.source ? { source: b.source } : {}), ...(b.sessionId ? { session: b.sessionId } : {}) }),
              signal: AbortSignal.timeout(60000),
            });
            const j = await r.json().catch(() => ({ error: "khora read returned no json" }));
            log(`read  khora  ${(j.referents ?? []).length} referent(s)  ${j.ms ?? "?"}ms`);
            return json(res, r.ok ? 200 : 502, j);
          } catch (e) {
            return json(res, 502, { error: "khora read did not answer: " + String(e?.message || e) });
          }
        }
        case "POST /api/reason": {
          // JANUS — the reasoner. A reasoner states its reasoning as claims,
          // universals ("every X … tested n, counterexamples [measured …]"),
          // equations and orderings; the engine's own organs decide what
          // holds. The reasoner never grades itself. The bridge hands the spec
          // to the khora proxy's /v1/reason and returns the verdict
          // ({ ok, errors, findings:[{kind, severity, detail, at}] }).
          const b = await readJson(req);
          if (!b || typeof b !== "object" || Array.isArray(b)) return json(res, 400, { error: "body needs a reasoning spec: { claims?, universals?, equations?, order?, inferences? }" });
          const t0 = Date.now();
          try {
            const r = await fetch(khoraUrl + "/v1/reason", {
              method: "POST",
              headers: { "content-type": "application/json", "x-er7-reason-flags": "--json --compact", "x-er7-user": "fold-bridge", "x-er7-caller": "fold-bridge" },
              body: JSON.stringify(b),
              signal: AbortSignal.timeout(60000),
            });
            const j = await r.json().catch(() => ({ error: "khora reason returned no json" }));
            recordDispatch({ id: "reason-" + randomUUID(), taskClass: "reason.check", privacy: "local-raw" }, "khora:reason", "machine-door", { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: r.ok && !j.error }, "deterministic/local");
            log(`reason  khora  ${(j.findings ?? []).length} finding(s)  ${Date.now() - t0}ms`);
            return json(res, r.ok ? 200 : 502, j);
          } catch (e) {
            return json(res, 502, { error: "khora reason did not answer: " + String(e?.message || e) });
          }
        }
        case "POST /api/agent": {
          // THE KHORA'S OPEN CODING LOOP — Claude Code's shape (list / read /
          // write / run over several turns) inside a severed sandbox: an
          // in-memory file system and a vm with no disk and no egress, so
          // nothing it touches is real. Returns { done, answer, rounds, files,
          // notes } — the rounds are the display, the notes are the record.
          const b = await readJson(req);
          if (!b || typeof b.task !== "string" || !b.task.trim()) return json(res, 400, { error: "body needs { task }" });
          const ref = b.model || null;
          const model = typeof ref === "string" ? ref : (ref?.modelID || ref?.id || null);
          const t0 = Date.now();
          try {
            const r = await fetch(khoraUrl + "/v1/agent", {
              method: "POST",
              headers: { "content-type": "application/json", "x-er7-user": "fold-bridge", "x-er7-caller": "fold-bridge", ...(b.sessionId ? { "x-er7-session": String(b.sessionId) } : {}) },
              body: JSON.stringify({ task: b.task, ...(model ? { model } : {}), ...(b.maxTurns ? { maxTurns: b.maxTurns } : {}), ...(b.sessionId ? { sessionId: b.sessionId } : {}) }),
              signal: goneOr(res, 1500000),
            });
            const j = await r.json().catch(() => ({ error: "khora agent returned no json" }));
            stats.code++;
            recordDispatch({ id: "agent-" + randomUUID(), taskClass: "code.agent", privacy: "local-raw" }, "khora:agent", "machine-door", { ms: Date.now() - t0, inputTokens: 0, outputTokens: 0, accepted: !!j.done }, "deterministic/local");
            log(`agent  khora  ${(j.rounds ?? []).length} round(s)  ${Object.keys(j.files ?? {}).length} file(s)  ${Date.now() - t0}ms`);
            return json(res, r.ok ? 200 : 502, j);
          } catch (e) {
            return json(res, 502, { error: "khora agent did not answer: " + String(e?.message || e) });
          }
        }
        default:
          if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/v1/")) return pipeUpstream(req, res, await readBody(req));
          if (req.method === "GET") return serveStatic(req, res);
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (e instanceof HttpError) { if (!res.headersSent) json(res, e.status, { error: e.message }, e.status === 413 ? { connection: "close" } : null); else res.end(); return; }
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
      else res.end();
    }
  }

  return {
    server,
    /** Mount point for another server's listener: `bridge.handler(req, res)`. */
    handler,
    /** The route table (method + path); anything else under /api/ or /v1/ is piped to the floor, GETs elsewhere serve the page. */
    routes: ROUTES,
    /** The per-boot access token (also in tokenFile when one is set) — an embedding server hands it to its own page/tools. */
    token: accessToken,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((r) => { clearInterval(noTabTimer); for (const t of tabs) t.end(); server.close(() => r()); server.closeIdleConnections?.(); }),
    stats,
    runLocal,
    fleetServes,
    normalizeTag,
  };
}
