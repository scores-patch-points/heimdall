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
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { answers, normalizeTag, ollamaTagOf } from "./models.js";
import {
  loadLinks, saveLinks, upsertLink, removeLink, probeEndpoint,
  guessTag, resolveLink, linkAdvertisedModels, DEFAULT_LINKS_FILE,
} from "./links.mjs";
import { inferOn } from "./remote.js";
import { record as dispatchRecord, meter as dispatchMeter, ESTIMATE_COSTS } from "./dispatch.js";
import { code as opencodeCode } from "./opencode-lane.js";

// The tab posts its state every 5 s — but a hidden tab's timers are throttled
// to about once a minute, so the bridge also pings over the open event stream
// (an event handler, which is not throttled) and the tab answers with its
// state. Fresh = heard within this long.
// The open stream itself is the liveness (the browser closes it with the
// tab); the posted state only has to be recent enough to trust its list of
// ready phones, and a throttled tab still posts once a minute.
const TAB_FRESH_MS = 5 * 60_000;
const PING_MS = 10_000;
const FIRST_TOKEN_MS = 180_000; // a phone's cold first token (model already loaded) — then fall through
const IDLE_MS = 120_000; // silence mid-stream this long ends the job

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
  passthrough = true,
  site = "https://scores-patch-points.github.io/heimdall/",
  lendModel = null,
  autoOpen = true, // try to open a controller tab ourselves when none is connected
  linksFile = DEFAULT_LINKS_FILE,
  frontierExecutors = [], // discovered credentialed providers (discovery.js discoverAll); keys live on this machine
  allowedOrigins = [], // extra page origins allowed to talk to the bridge (e.g. the fold's GitHub Pages origin); never "*"
  stateFile = STATE_FILE, // where `heimdall key` stores providerKeys (injectable for tests)
  frontierFetch = fetch,
  opencodeUrl = process.env.HEIMDALL_OPENCODE || process.env.OPENCODE_URL || null, // a running `opencode serve` — the machine door for coding
  opencodeFetch = defaultOpencodeFetch,
  log = () => {},
} = {}) {
  const tabs = new Set(); // open SSE responses; the newest one is the controller
  let state = null; // last state the tab posted
  let stateAt = 0;
  const jobs = new Map(); // id -> { onMsg }
  const stats = { fleet: 0, passthrough: 0, fellThrough: 0, native: 0, frontier: 0, frontierRefused: 0, code: 0 };
  let links = loadLinks(linksFile); // native app servers linked by hand or the page

  // Frontier executors (provider keys configured server-side — `heimdall key`,
  // HEIMDALL_KEY_*). Each answers its model id and `provider:model`. They are
  // SEALED-ONLY: a request reaches them only when the caller marks the body
  // `heimdall_privacy: "sealed-external" | "explicit"` — never raw by default.
  const frontierMap = new Map(); // served model name -> executor record
  for (const ex of frontierExecutors || []) {
    if (!ex?.model || !ex?.endpoint) continue;
    for (const name of [ex.model, `${ex.provider}:${ex.model}`]) frontierMap.set(name, ex);
  }
  // Re-run discovery against the CURRENT server-side keys and rebuild the
  // frontier map, so a key just stored through the surface takes effect without
  // restarting `heimdall up`. Returns the number of reachable models, or -1 on
  // a discovery failure (the key is still stored; the map just stays as it was).
  async function refreshFrontier() {
    try {
      const { discoverAll } = await import("./discovery.js");
      const { loadProviderKeys } = await import("./providers.js");
      const keys = loadProviderKeys({ state: readState(stateFile) });
      const discovered = await discoverAll({ config: { providers: keys } }, { fetchImpl: frontierFetch });
      const next = new Map();
      let n = 0;
      for (const ex of discovered) {
        if (!(ex?.live?.reachable && ex.location === "external" && ex.model && ex.endpoint)) continue;
        for (const name of [ex.model, `${ex.provider}:${ex.model}`]) next.set(name, ex);
        n++;
      }
      frontierMap.clear();
      for (const [k, v] of next) frontierMap.set(k, v);
      return n;
    } catch (e) { log("frontier refresh failed: " + e.message); return -1; }
  }
  const isFrontier = (model) => !!model && frontierMap.has(model);
  const frontierGate = (privacy) => privacy === "sealed-external" || privacy === "explicit";
  const frontierRefusal = (model) => `frontier model ${model} is sealed-only — send heimdall_privacy:"sealed-external" (or "explicit") in the body; the Fold selects its privacy mode and seals first`;

  // The dispatch ledger (dispatch.js): every frontier choice and its measured
  // tokens, so /api/meter reports exact external tokens, never an estimate.
  const dispatchLedger = [];
  const recordDispatch = (job, selected, reason, actual, lane = null) => {
    dispatchLedger.push(dispatchRecord({ job, selected, reason, actual, lane }));
    if (dispatchLedger.length > 2000) dispatchLedger.splice(0, dispatchLedger.length - 2000);
  };
  const selfOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  // Any page on THIS box, any port, may use the bridge from a browser (a
  // caller like the-fold's app.js is served from its own port and needs a
  // real CORS allowance to get past the browser's own preflight) -- mirrors
  // eoreader7/proxy.mjs's identical LOOPBACK_PAGE_ORIGIN reflection for the
  // same reason stated there: an arbitrary website must never be able to
  // drive local inference through the user's browser, so only loopback
  // origins are ever reflected back, never a blanket "*".
  const LOOPBACK_PAGE_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  // Pages served from an EXPLICIT, named allowlist (e.g. the fold's own GitHub
  // Pages origin) may also talk to the bridge. This is deliberately a closed
  // list, never "*": a public page the person named can reach their own bridge,
  // an arbitrary website still cannot. Env HEIMDALL_ALLOWED_ORIGINS adds more
  // (comma-separated).
  const allowedOriginSet = new Set(
    [...(allowedOrigins || []), ...String(process.env.HEIMDALL_ALLOWED_ORIGINS || "").split(",")]
      .map((s) => String(s).trim()).filter(Boolean),
  );
  const originAllowed = (origin) => selfOrigins.has(origin) || LOOPBACK_PAGE_ORIGIN.test(origin) || allowedOriginSet.has(origin);

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

  const tabAlive = () => tabs.size > 0 && Date.now() - stateAt < TAB_FRESH_MS;
  const readyWorkers = () => (tabAlive() ? (state?.workers ?? []).filter((w) => w.ready && w.model) : []);
  // `any` (or `fleet`) asks for whatever a ready phone holds — the caller
  // chose not to pin a model. Every other name is pinned exactly.
  const isAny = (model) => model === "any" || model === "fleet";
  // A native app host (linked by the page or `heimdall link`) answers the
  // models it advertised; a browser worker answers the WebLLM ids it holds.
  const linkedGiver = (model) => resolveLink(links, model);
  const fleetServes = (model) =>
    !!model && (isFrontier(model) || !!linkedGiver(model) || readyWorkers().some((w) => isAny(model) || answers(w.model, model)));

  function toTab(msg) {
    const tab = [...tabs].at(-1);
    if (!tab) return false;
    tab.write(`data: ${JSON.stringify(msg)}\n\n`);
    return true;
  }

  /** Run one chat on the fleet. Calls onToken(text) per delta; resolves
   *  { text, ms, tokens } or rejects with { beforeFirstToken, message }. */
  function runOnFleet({ model, messages, temperature, max_tokens }, onToken) {
    return new Promise((resolve, reject) => {
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
      if (!toTab({ type: "job", id, model: isAny(model) ? null : model, messages, temperature, max_tokens })) finish(null, "no controller tab");
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
      try {
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (!r.ok || !r.body) throw new Error(`${link.kind || "app"} ${r.status}: ${await r.text().catch(() => "")}`);
        for await (const chunk of r.body) feed(new TextDecoder().decode(chunk));
        resolve({ text, ms: Date.now() - t0, tokens });
      } catch (e) {
        reject({ beforeFirstToken: tokens === 0, message: e?.message || "native host error" });
      }
    });
  }

  /** One chat on whichever giver is best: a linked native app first (real
   *  GPU, survives without a controller tab), else the browser fleet. */
  function runOnGiver(model, opts, onToken) {
    if (frontierMap.has(model)) return runOnFrontier(model, opts, onToken);
    const link = linkedGiver(model);
    if (link) return runOnLink(link, opts, onToken);
    return runOnFleet({ model, ...opts }, onToken);
  }

  /** One chat on a configured frontier executor (Anthropic/OpenAI/… wire via
   *  remote.js inferOn). The caller has already passed the privacy gate; the
   *  body sent upstream is exactly what the Fold put there (the projection for
   *  its selected privacy mode). Every call lands a dispatch-ledger entry. */
  async function runOnFrontier(model, { messages, temperature = 0.7, max_tokens = 1024 }, onToken) {
    const ex = frontierMap.get(model);
    const t0 = Date.now();
    const out = await inferOn(ex, { messages, temperature, maxTokens: max_tokens, onToken, fetchImpl: frontierFetch });
    stats.frontier++;
    recordDispatch(
      { id: "bridge-" + randomUUID(), taskClass: "bridge.frontier", privacy: "sealed-external" },
      `${ex.provider}:${ex.model}`,
      "frontier",
      { ms: out.ms, inputTokens: 0, outputTokens: out.tokens },
      "frontier",
    );
    log(`frontier  ${ex.provider}:${ex.model}  ${out.tokens} tokens  ${out.ms}ms`);
    return out;
  }

  /* ---------------------------------------------------------- helpers */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  function json(res, code, obj) {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  function sendHtml(res, html) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
  }

  /** The native-app linking page: store links for the phone, a live tester to
   *  add the app's server as a host. Served at /link on this bridge; works on
   *  macOS, Windows and Linux (nothing platform-specific in it). */
  function linkPage() {
    const rows = links.map((l) =>
      `<li><b>${l.name || l.url}</b> <span class=n>${l.kind || "?"}</span> <code>${l.url}</code>` +
      (l.tag ? ` &rarr; <code>${l.tag}</code>` : "") +
      ` <button data-url="${l.url}" class=rm>remove</button></li>`).join("");
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
<p class=n>Saved to <code>${linksFile}</code>. This bridge already exposes them
to eoreader7 as one host — <code>ER7_OLLAMA_HOSTS="…,fleet=http://localhost:${port}"</code>.</p>

<script>
  var msg = document.getElementById("msg");
  function show(ok, text){ msg.className = ok ? "ok" : "bad"; msg.textContent = text; }
  function refresh(){
    fetch("/link/hosts").then(function(r){return r.json()}).then(function(j){
      var ul = document.getElementById("list");
      if(!j.links.length){ ul.innerHTML = "<li class=n>none yet</li>"; return; }
      ul.innerHTML = j.links.map(function(l){
        return "<li><b>"+(l.name||l.url)+"</b> <span class=n>"+(l.kind||"?")+"</span> <code>"+l.url+"</code>"+
          (l.tag?" &rarr; <code>"+l.tag+"</code>":"")+" <button class=rm data-url='"+l.url+"'>remove</button></li>";
      }).join("");
    });
  }
  function probe(){
    var url = document.getElementById("url").value;
    return fetch("/link/probe",{method:"POST",headers:{"content-type":"application/json"},
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
      return fetch("/link/host",{method:"POST",headers:{"content-type":"application/json"},
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
      fetch("/link/remove",{method:"POST",headers:{"content-type":"application/json"},
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

  async function pipeUpstream(req, res, raw, urlPath = req.url) {
    stats.passthrough++;
    if (!passthrough) {
      let model = null;
      try { model = JSON.parse(raw.toString() || "{}").model; } catch {}
      return json(res, 404, { error: `model "${model}" not found in the fleet (no phone holds it, and pass-through is off)` });
    }
    try {
      // The caller's identity and Heimdall's hop marks ride through (2026-09-21):
      // upstream is Heimdall's channel, which keys the line per SERVER and
      // must see the original caller, not the bridge; and a turn the channel
      // sent HERE that fell through must re-enter marked, never re-queue.
      const headers = { "content-type": req.headers["content-type"] || "application/json" };
      for (const [k, v] of Object.entries(req.headers)) if (/^x-(er7|heimdall)-/.test(k) && typeof v === "string") headers[k] = v;
      if (!headers["x-er7-user"] && !headers["x-er7-caller"] && !headers["x-er7-session"]) headers["x-er7-caller"] = `heimdall-bridge:${port}`;
      const r = await fetch(upstream + urlPath, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : raw,
      });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json" });
      if (!r.body) return res.end();
      for await (const chunk of r.body) res.write(chunk);
      res.end();
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: `upstream Ollama at ${upstream} did not answer: ${e.message}` });
      else res.end();
    }
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
      stats.fleet++;
      const ns = out.ms * 1e6;
      const final = { ...line(stream ? "" : out.text), done: true, done_reason: "stop", total_duration: ns, load_duration: 0, eval_count: out.tokens, eval_duration: ns, heimdall: "fleet" };
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

  async function openaiChat(req, res, raw) {
    let b;
    try { b = JSON.parse(raw.toString() || "{}"); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
    const privacy = b.heimdall_privacy || b.privacy || null;
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
        { messages, temperature: b.temperature ?? 0.7, max_tokens: b.max_tokens ?? b.max_completion_tokens ?? 1024 },
        (delta) => { start(); if (b.stream) res.write(`data: ${JSON.stringify(chunk({ content: delta }))}\n\n`); },
      );
      stats.fleet++;
      if (b.stream) {
        start();
        res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        json(res, 200, { id, object: "chat.completion", created, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: out.text }, finish_reason: "stop" }], usage: { completion_tokens: out.tokens } });
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
    if (isFrontier(b.model) && !frontierGate(privacy)) {
      stats.frontierRefused++;
      return json(res, 400, { error: { type: "invalid_request_error", message: frontierRefusal(b.model) } });
    }
    if (!fleetServes(b.model)) return pipeUpstream(req, res, raw);
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
      if (e?.beforeFirstToken && !started) { stats.fellThrough++; return pipeUpstream(req, res, raw); }
      if (stream) { start(); res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: e?.message } })}\n\n`); }
      else json(res, 502, { error: { type: "api_error", message: e?.message || "fleet error" } });
    }
  }

  /* ---------------------------------------------------------- static */

  function serveStatic(req, res) {
    const u = new URL(req.url, "http://x");
    let p = decodeURIComponent(u.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const file = path.normalize(path.join(dist, p));
    if (!file.startsWith(path.normalize(dist))) return json(res, 403, { error: "forbidden" });
    fs.readFile(file, (err, data) => {
      if (err) {
        if (p.includes(".")) return json(res, 404, { error: "not found" });
        return fs.readFile(path.join(dist, "index.html"), (e2, idx) => {
          if (e2) return json(res, 500, { error: "dist/index.html missing — run npm run build" });
          res.writeHead(200, { "content-type": TYPES[".html"] });
          res.end(idx);
        });
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": p === "/index.html" || p.endsWith("sw.js") ? "no-cache" : "public, max-age=3600" });
      res.end(data);
    });
  }

  /* ---------------------------------------------------------- router */

  const server = http.createServer(async (req, res) => {
    // Only this page, any other loopback page (the-fold, eoreader7's own
    // /ui, curl), and origin-less local clients may talk to the bridge —
    // the same loopback-only CORS reflection eoreader7/proxy.mjs uses for
    // its own channel, never a blanket "*".
    const origin = req.headers.origin;
    const pageOrigin = typeof origin === "string" && originAllowed(origin) ? origin : null;
    if (origin && !pageOrigin) return json(res, 403, { error: `origin ${origin} not allowed` });
    if (pageOrigin) {
      res.setHeader("access-control-allow-origin", pageOrigin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (pageOrigin) {
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-allow-headers", String(req.headers["access-control-request-headers"] || "content-type"));
      }
      res.writeHead(204);
      return res.end();
    }
    const u = new URL(req.url, "http://x");
    const route = `${req.method} ${u.pathname}`;
    try {
      switch (route) {
        case "GET /bridge/hello":
          return json(res, 200, { bridge: true, site, upstream, passthrough, lendModel, port });
        case "GET /bridge/events": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(": heimdall bridge\n\n");
          tabs.add(res);
          noTabsSince = null;
          const ka = setInterval(() => res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`), PING_MS);
          req.on("close", () => {
            clearInterval(ka);
            tabs.delete(res);
            if (tabs.size === 0) noTabsSince = Date.now();
          });
          log(`controller tab connected (${tabs.size} open)`);
          return;
        }
        case "POST /bridge/state": {
          state = JSON.parse((await readBody(req)).toString() || "{}");
          stateAt = Date.now();
          return json(res, 200, { ok: true });
        }
        case "POST /bridge/reply": {
          const batch = JSON.parse((await readBody(req)).toString() || "[]");
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
          return json(res, 200, { tab: tabAlive(), room: state?.room ?? null, workers: state?.workers ?? [], lending: state?.self ?? null, pending: jobs.size, stats, upstream, passthrough, links, linksFile, diag: state?.diag ?? {}, hostRecv: state?.hostRecv ?? [] });
        case "GET /link":
        case "GET /link/":
          return sendHtml(res, linkPage());
        case "GET /link/hosts":
          return json(res, 200, { links });
        case "POST /link/probe": {
          const b = JSON.parse((await readBody(req)).toString() || "{}");
          return json(res, 200, await probeEndpoint(b.url, { key: b.key || null }));
        }
        case "POST /link/host": {
          const b = JSON.parse((await readBody(req)).toString() || "{}");
          const probe = await probeEndpoint(b.url, { key: b.key || null });
          if (!probe.ok) return json(res, 400, probe);
          const model = b.model || probe.models[0] || "local";
          const tag = b.tag || guessTag(model) || probe.models[0] || "local";
          const name = b.name || probe.url.replace(/^https?:\/\//, "");
          links = saveLinks(upsertLink(links, { name, url: probe.url, kind: probe.kind, model, tag, models: probe.models, ...(b.key ? { key: b.key } : {}) }), linksFile);
          log(`linked native host ${name} (${probe.kind}) at ${probe.url} → ${tag}`);
          return json(res, 200, { ok: true, links });
        }
        case "POST /link/remove": {
          const b = JSON.parse((await readBody(req)).toString() || "{}");
          links = saveLinks(removeLink(links, b.url), linksFile);
          return json(res, 200, { ok: true, links });
        }
        case "GET /api/version":
          return json(res, 200, { version: "0.0.0-heimdall-bridge" });
        case "GET /api/ps":
          return json(res, 200, { models: fleetModels().map((m) => ({ ...m, size_vram: 0, expires_at: new Date(Date.now() + TAB_FRESH_MS).toISOString() })) });
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
        case "GET /api/ledger":
          return json(res, 200, { entries: dispatchLedger.slice(-200) });
        case "GET /api/meter":
          return json(res, 200, dispatchMeter(dispatchLedger, ESTIMATE_COSTS));
        case "GET /api/frontier": {
          // Which frontier providers are configured on THIS machine and what
          // they expose — model names and privacy class, never keys.
          const providers = [];
          for (const [name, ex] of frontierMap) providers.push({ model: name, provider: ex.provider, privacy: "sealed-external", reachable: !!ex.live?.reachable, endpoint: ex.endpoint });
          return json(res, 200, { configured: frontierMap.size > 0, providers, keySource: "server-side (heimdall key / HEIMDALL_KEY_* / the surface, never an outside executor)", gate: 'requests must carry heimdall_privacy:"sealed-external" (Fold privacy mode)' });
        }
        case "GET /api/providers/keys": {
          // Which providers have a key set — names only, never the key values.
          const stored = readState(stateFile).providerKeys || {};
          return json(res, 200, { providers: Object.keys(stored).map((p) => ({ provider: p, set: true })), keySource: "server-side (never a browser)" });
        }
        case "POST /api/providers/keys": {
          // Enter an Anthropic/OpenAI (or other catalogued) provider key from a
          // surface. It is written to the SAME server-side state the CLI uses
          // (`heimdall key`) and never echoed back. LOOPBACK ONLY: a key can
          // only be set by a request whose socket is on this machine, so a LAN
          // client or a proxied request cannot plant one.
          const addr = req.socket?.remoteAddress || "";
          if (!LOOPBACK_ADDR.test(addr)) return json(res, 403, { error: "provider keys can only be set from this machine" });
          let b;
          try { b = JSON.parse((await readBody(req)).toString() || "{}"); } catch { return json(res, 400, { error: "body must be JSON" }); }
          const provider = String(b.provider || "").toLowerCase();
          const { catalogFor } = await import("./providers.js");
          if (!catalogFor(provider)) return json(res, 400, { error: `unknown provider "${provider}"` });
          const st = readState(stateFile);
          st.providerKeys = st.providerKeys || {};
          if (b.remove) delete st.providerKeys[provider];
          else if (typeof b.key === "string" && b.key.trim()) st.providerKeys[provider] = b.key.trim();
          else return json(res, 400, { error: "body needs { provider, key } or { provider, remove: true }" });
          writeState(st, stateFile);
          const models = await refreshFrontier();
          log(`provider key ${b.remove ? "removed" : "stored"} for ${provider} (server-side; ${models < 0 ? "discovery failed" : models + " model(s) reachable"})`);
          return json(res, 200, { ok: true, provider, stored: !b.remove, configured: Object.keys(st.providerKeys), frontierModels: models, keySource: "server-side (never a browser)" });
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
          if (!opencodeUrl) return json(res, 501, { error: "no coding machine attached — run `opencode serve` and set HEIMDALL_OPENCODE (or OPENCODE_URL), then heimdall up" });
          const b = JSON.parse((await readBody(req)).toString() || "{}");
          if (!b || typeof b.prompt !== "string" || !b.prompt.trim()) return json(res, 400, { error: "body needs { prompt }" });
          const t0 = Date.now();
          try {
            const out = await opencodeCode(opencodeUrl, { prompt: b.prompt, title: b.title || null, model: b.model || null, agent: b.agent || null, system: b.system || null, sessionId: b.sessionId || null }, { fetchImpl: opencodeFetch });
            stats.code++;
            recordDispatch(
              { id: "code-" + randomUUID(), taskClass: "code.repair", privacy: "local-raw" },
              "opencode:" + (out.sessionId || "session"),
              "machine-door",
              { ms: out.ms, inputTokens: 0, outputTokens: 0, accepted: !!out.text },
              "deterministic/local",
            );
            log(`code  opencode  ${out.activity.length} tool step(s)  ${out.ms}ms`);
            return json(res, 200, { sessionId: out.sessionId, text: out.text, activity: out.activity, ms: out.ms, iterated: !!out.iterated, lane: "opencode" });
          } catch (e) {
            return json(res, 502, { error: "opencode did not answer: " + String(e?.message || e) });
          }
        }
        case "POST /api/read": {
          // Attachments are READ, never forwarded raw. The bridge hands the
          // bytes to the khora's model-free constitutional reader (the
          // perceiver) and returns the reading (EORead@1) — referents,
          // relations, basis. The surface shows the reading; the model never
          // receives the raw file. The reader URL is the khora engine proxy.
          const b = JSON.parse((await readBody(req)).toString() || "{}");
          const text = String(b.text ?? "");
          if (!text.trim()) return json(res, 400, { error: "body needs { text }" });
          const readUrl = process.env.ER7_READ_URL || process.env.KHORA_READ_URL || "http://127.0.0.1:11436/v1/read";
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
        default:
          if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/v1/")) return pipeUpstream(req, res, await readBody(req));
          if (req.method === "GET") return serveStatic(req, res);
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e?.message || e) });
      else res.end();
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise((r) => { clearInterval(noTabTimer); for (const t of tabs) t.end(); server.close(() => r()); }),
    stats,
    fleetServes,
    normalizeTag,
  };
}
