#!/usr/bin/env node
// heimdall — run the fleet on this computer, or mint an invite.
//   heimdall up      [--port 8790] [--no-open] [--no-passthrough] [--lend gemma2:2b|none]
//   heimdall invite [--name "Your Name"] [--room !id:hs] [--new]
//   heimdall login --user @me:hs --password …
//   heimdall reset
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
// The Matrix SDK is large and slow to load; only the commands that talk to
// Matrix pay for it (`up` never does — the page does its own Matrix).
const matrixLib = () => import("../src/matrix.js");
const inviteLib = () => import("../src/invite.js");

const SITE = process.env.HEIMDALL_SITE || "https://scores-patch-points.github.io/heimdall/";
const HS = "https://hyphae.social";
const STATE_DIR = join(homedir(), ".heimdall");
const STATE = join(STATE_DIR, "state.json");
const PIDFILE = join(STATE_DIR, "bridge.pid");

const args = process.argv.slice(2);
const cmd = args[0] || "invite";
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(name);

function load() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}
function save(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

const baseUrl = flag("--hs", HS);

async function credsFor() {
  const { login, registerAuto, randomUsername } = await matrixLib();
  const { randomPassword } = await inviteLib();
  const user = flag("--user", "");
  const pass = flag("--password", "");
  if (user && pass) return login({ baseUrl, username: user, password: pass });
  const state = load();
  if (state.creds?.accessToken) return state.creds;
  const password = randomPassword();
  const creds = await registerAuto({ baseUrl, username: randomUsername("heimdall"), password });
  return { ...creds, password };
}

if (cmd === "login") {
  const user = flag("--user", "");
  const pass = flag("--password", "");
  if (!user || !pass) {
    console.error("usage: heimdall login --user @me:server --password …");
    process.exit(1);
  }
  const { login } = await matrixLib();
  const creds = await login({ baseUrl, username: user, password: pass });
  const state = load();
  state.creds = creds;
  save(state);
  console.log("signed in as", creds.userId);
} else if (cmd === "invite") {
  const state = load();
  const creds = await credsFor();
  const roomId = flag("--room", has("--new") ? "" : state.roomId);
  const name = flag("--name", creds.userId);
  const { createInvite } = await inviteLib();
  const { url, shortUrl, exp, roomId: rid } = await createInvite({ baseUrl, creds, roomId, displayName: name, site: SITE });
  save({ creds, roomId: rid });
  console.log("INVITE   " + url);
  if (shortUrl) {
    console.log("SHORT    " + shortUrl + "   <-- type this by hand on a worker's computer");
  }
  console.log("ROOM     " + rid);
  console.log("HOST     " + creds.userId);
  console.log("EXPIRES  " + new Date(exp).toISOString());
  console.log("");
  console.log("the 6-digit pairing code lives on the WORKER's device (its key fingerprint) —");
  console.log("have them read it to you, then Record it in the controller site (or fold).");
  console.log("keep the controller site open and signed into " + creds.userId + " so codes can be confirmed.");
} else if (cmd === "discover") {
  // Heimdall's boot sequence: probe the localhost lanes and the configured
  // providers, report every endpoint with its auth observation. The page does
  // the same on load (plus the browser-only lanes: WebLLM, Transformers,
  // Puter); this command is the headless view of the same inventory.
  const { discoverAll } = await import("../src/discovery.js");
  const { loadProviderKeys } = await import("../src/providers.js");
  const state = load();
  const providers = loadProviderKeys({ state });
  const endpoints = (state.endpoints || []).filter((e) => e?.url);
  const execs = await discoverAll({ config: { providers, endpoints, keylessExternal: true } });
  console.log("HEIMDALL DISCOVERY");
  console.log("");
  console.log("1. In-process      (WebGPU / WebLLM / Transformers.js — browser lanes)");
  console.log("2. localhost probes(:11434 Ollama · :1234 LM Studio · :8080 llama.cpp/LocalAI · :8000 vLLM)");
  console.log("3. configured LAN / heimdall peers");
  console.log("4. keyless external (Pollinations · LLM7 · OVHcloud — no key)");
  console.log("5. browser keyless-cloud (Puter.js)");
  console.log("6. configured credentialed providers (OpenRouter, Groq, …)");
  console.log("");
  const lanes = { "in_process": [], "local_open": [], "user_pays": [], "optional_auth": [], "api_key": [], "discovery_only": [] };
  for (const rec of execs) (lanes[rec.authClass] ||= []).push(rec);
  const line = (rec) => {
    const auth = rec.auth?.tested ? (rec.auth.inferenceKeyless ? "no auth (probed)" : "auth required (probed)") : "auth unknown (not probed)";
    return `  ${String(rec.executor).padEnd(40)} ${rec.location.padEnd(14)} ${auth}`;
  };
  console.log("AVAILABLE NOW");
  console.log("  in-process");
  for (const r of lanes.in_process) console.log(line(r));
  console.log("  local / LAN (no auth by default)");
  for (const r of lanes.local_open) console.log(line(r));
  console.log("  user-pays (no developer key)");
  for (const r of lanes.user_pays) console.log(line(r));
  console.log("  configured / optional auth");
  for (const r of lanes.optional_auth) console.log(line(r));
  console.log("  credentialed providers");
  for (const r of lanes.api_key) console.log(line(r));
  console.log("  discovery-only (NOT inference)");
  for (const r of lanes.discovery_only) console.log(line(r));
  console.log("");
  console.log(`legit keyless sources: ours · user LAN · heimdall peers · explicitly-public · user-session`);
  console.log(`(never "port 8080 answered somewhere on the internet")`);
} else if (cmd === "link") {
  const { probeEndpoint, upsertLink, saveLinks, loadLinks, guessTag, DEFAULT_LINKS_FILE } = await import("../src/links.mjs");
  const url = !args[1] || args[1].startsWith("--") ? flag("--url", "") : args[1];
  if (!url) {
    console.error("usage: heimdall link <host:port> [--tag gemma2:2b] [--model ID] [--key TOKEN] [--name phone]");
    process.exit(1);
  }
  const key = flag("--key", "") || null;
  const probe = await probeEndpoint(url, { key });
  if (!probe.ok) {
    console.error(`no Ollama/OpenAI endpoint at ${url}: ${probe.error}`);
    process.exit(1);
  }
  const model = flag("--model", probe.models[0] || "local");
  const tag = flag("--tag", guessTag(model) || probe.models[0] || "local");
  const name = flag("--name", probe.url.replace(/^https?:\/\//, ""));
  const links = saveLinks(upsertLink(loadLinks(), { name, url: probe.url, kind: probe.kind, model, tag, models: probe.models, ...(key ? { key } : {}) }));
  console.log(`linked  ${name}  (${probe.kind})  ${probe.url}`);
  console.log(`models  ${probe.models.join(", ") || "(none reported)"}`);
  console.log(`serves  ${tag}`);
  console.log(`saved   ${DEFAULT_LINKS_FILE}  (${links.length} link${links.length === 1 ? "" : "s"})`);
} else if (cmd === "key") {
  // Frontier-provider API keys live HERE, on the heimdall machine, never in a
  // browser page. The command tests the key live, stores it unless the provider
  // rejects it, tells a running bridge to reload, and says in plain words what
  // it unlocks and what to do next (src/key-cli.js). The key is never echoed.
  //   `--model <id>` (repeatable) names the models a provider serves; with none
  //   named, Anthropic's models are taken from the live check.
  const { keyCommand } = await import("../src/key-cli.js");
  const r = await keyCommand({ args, state: load(), save, stateLabel: STATE, port: Number(flag("--port", process.env.HEIMDALL_PORT || 8790)) });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
} else if (cmd === "route-stats") {
  // Measured accept rate per route × taskClass (the divisor in the router's score). Reads the running bridge when it
  // answers (--port, default 8790), else the persisted table in ~/.heimdall/route-stats.json. --json for machines.
  const { createRouteStats, formatStats, DEFAULT_STATS_FILE } = await import("../src/route-stats.js");
  const port = Number(flag("--port", process.env.HEIMDALL_PORT || 8790));
  let snap = null, source = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/route-stats`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { snap = await r.json(); source = `bridge :${port}`; }
  } catch {}
  if (!snap) { snap = createRouteStats({ file: DEFAULT_STATS_FILE }).snapshot(); source = DEFAULT_STATS_FILE; }
  if (has("--json")) console.log(JSON.stringify(snap, null, 2));
  else { console.log(formatStats(snap)); console.log(`(source: ${source})`); }
} else if (cmd === "route-sim") {
  // The routing simulator: prove local-wins / remote-wins / accept-rate flip / deadline / privacy filter on fake routes.
  const { spawnSync: sp } = await import("node:child_process");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  process.exit(sp(process.execPath, [join(root, "scripts", "route-sim.mjs"), ...args.slice(1)], { stdio: "inherit" }).status ?? 0);
} else if (cmd === "reset") {
  save({});
  console.log("stored session cleared");
} else if (cmd === "up") {
  await up();
} else {
  console.log("heimdall — distributed inference invites");
  console.log("");
  console.log("  heimdall up      run the fleet on this computer: page + Ollama-compatible bridge");
  console.log("                   [--port 8790] [--no-open] [--no-passthrough] [--no-keyless] [--lend <ollama model>|none]");
  console.log("                   --no-keyless skips probing the keyless external providers at boot");
  console.log("  heimdall discover  probe localhost + configured providers, report auth observations");
  console.log("  heimdall key       store/remove frontier provider API keys for THIS machine (server-side, never in a browser)");
  console.log("                     heimdall key <provider> <key> [--model <id> …]  ·  heimdall key --rm <provider>  ·  heimdall key (list)");
  console.log("                     the key is tested live, stored unless the provider rejects it, and you are told what it unlocks");
  console.log("                     heimdall key <provider>  tests the saved key again · --model names the models to offer (repeatable)");
  console.log("  heimdall route-stats  measured accept rate per route x taskClass [--port 8790] [--json]  (the router's divisor; see docs/ESCALATION.md)");
  console.log("  heimdall route-sim    the routing simulator: local wins idle, remote wins saturated, accept-rate flip, deadline, privacy filter");
  console.log("  heimdall invite  [--name \"Your Name\"] [--room !id:hs] [--new] [--hs URL]");
  console.log("                   [--user @me:hs --password …]");
  console.log("  heimdall link    <host:port> [--tag gemma2:2b] [--model ID] [--key TOKEN] [--name phone]");
  console.log("                   link a native app's local API (LAN or Tailscale) as a host");
  console.log("  heimdall login   --user @me:hs --password …");
  console.log("  heimdall reset");
  console.log("");
  console.log("env: HEIMDALL_SITE overrides the link base, e.g. for local dev.");
  console.log("     HEIMDALL_NO_OPEN=1 is --no-open for a headless/server-only start (no startup open, no auto-reopen).");
}
/* ------------------------------------------------------------------ up */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, just isn't ours to signal — still alive
  }
}

// A second `heimdall up` on the SAME port hits EADDRINUSE below and dies
// loudly — but a second one started with a different --port binds fine and
// becomes a second, independently-reachable bridge nobody chose to run: the
// "two servers silently splitting traffic" bug class behind this codebase's
// Ollama-predecessor reload-storm incident. This lock is one per machine,
// not keyed by port, so that case is refused too, before either bridge
// finishes coming up.
function acquireLock(port) {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const prev = JSON.parse(readFileSync(PIDFILE, "utf8"));
    if (pidAlive(prev.pid)) {
      console.error(`heimdall is already up — pid ${prev.pid}, port ${prev.port ?? "?"} (started ${prev.startedAt ?? "unknown time"}).`);
      console.error(`stop it first, or if that's stale: rm ${PIDFILE}`);
      process.exit(1);
    }
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; // anything but "no lock yet" is real
  }
  writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2));
}

function releaseLock() {
  try {
    const cur = JSON.parse(readFileSync(PIDFILE, "utf8"));
    if (cur.pid === process.pid) rmSync(PIDFILE, { force: true });
  } catch {}
}

async function up() {
  const { createBridge } = await import("../src/bridge-server.mjs");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) {
    console.log("building the page (first run only)…");
    const r = spawnSync("npx", ["--yes", "vite", "build"], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("build failed — run `npm install && npm run build` in " + root);
      process.exit(1);
    }
  }
  const port = Number(flag("--port", process.env.HEIMDALL_PORT || 8790));
  acquireLock(port);
  // THE FLOOR. :11434 is usually khora's channel proxy (x-heimdall-channel: it queues one request at a time and can refuse), and the
  // real Ollama sits on :11435. Probe both, normalise any OLLAMA_HOST spelling, and give the bridge the ordered list; warn loudly when
  // the channel is the only floor. (The module that decides all this is src/floor.js; nothing in bridge-server.mjs prints or exits.)
  const { normalizeOllamaHost, probeFloor } = await import("../src/floor.js");
  const primary = normalizeOllamaHost(process.env.OLLAMA_HOST) || "http://127.0.0.1:11434";
  const floor = await probeFloor({ primary, direct: "http://127.0.0.1:11435" });
  const upstreams = floor.upstreams.length ? floor.upstreams : [primary];
  const upstream = upstreams[0];
  for (const w of floor.warnings) console.error("  WARNING  " + w);
  const passthrough = !has("--no-passthrough");
  // Headless/server start: skip both the startup open below AND the
  // bridge's own later auto-reopen when the tab drops.
  const noOpen = has("--no-open") || process.env.HEIMDALL_NO_OPEN === "1";

  // What this computer lends back to the phones: the caller's default model
  // if Ollama has it, else the first chat model installed. --lend none = don't.
  let installed = [];
  try {
    installed = ((await (await fetch(upstream + "/api/tags", { signal: AbortSignal.timeout(3000) })).json()).models ?? []).map((m) => m.name);
  } catch {}
  const lendFlag = flag("--lend", "");
  const preferred = [lendFlag, process.env.ER7_DEFAULT_MODEL, "gemma2:2b"].filter(Boolean);
  const lendModel = lendFlag === "none" ? null
    : preferred.find((m) => installed.includes(m)) ?? installed.find((m) => !/embed/i.test(m)) ?? null;

  // Frontier providers configured on THIS machine (`heimdall key` + the
  // HEIMDALL_KEY_* env) — discovered once at boot and lent to the bridge as
  // sealed-only executors. The keys never reach a browser. Alongside them, the
  // keyless external endpoints (Pollinations, LLM7, OVHcloud) are probed
  // with no credential. A provider whose probe failed is not offered:
  // reachable is measured, never assumed.
  let frontierExecutors = [];
  try {
    const { discoverAll } = await import("../src/discovery.js");
    const { loadProviderKeys } = await import("../src/providers.js");
    const keyState = load();
    const discovered = await discoverAll({ config: { providers: loadProviderKeys({ state: keyState }), keylessExternal: has("--keyless") || !has("--no-keyless") } });
    frontierExecutors = discovered.filter((r) => r.live?.reachable && r.location === "external" && r.model && r.endpoint);
    if (frontierExecutors.length) console.log("  remote lane        " + frontierExecutors.map((r) => `${r.provider}:${r.model}`).join(", ") + "  (sealed-external only)");
  } catch (e) {
    console.log("  remote lane        discovery failed: " + e.message);
  }

  // The machine door (coding): a running `opencode serve`. Explicit env wins;
  // otherwise PROBE the usual port so `heimdall up` finds an opencode that is
  // already running instead of silently serving no code lane (measured: the
  // bridge reported "no coding machine attached" while opencode listened on
  // 4099, because `up` never passed the URL the bridge already reads from env).
  const opencodeUrl = process.env.HEIMDALL_OPENCODE || process.env.OPENCODE_URL || (await (async () => {
    for (const base of ["http://127.0.0.1:4099", "http://127.0.0.1:4096"]) {
      // ANY HTTP answer means an opencode server is listening — a 401/400 is a
      // live door that wants auth or a body, never "not attached". Only a
      // connection failure (thrown) means absent.
      try { const r = await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1500) }); if (r.status > 0) return base; } catch {}
    }
    return null;
  })());
  if (opencodeUrl) console.log("  code lane          " + opencodeUrl + "  (the machine door)");

  const bridge = createBridge({
    port,
    dist,
    upstream,
    upstreams,
    passthrough,
    lendModel,
    autoOpen: !noOpen,
    tokenFile: join(STATE_DIR, "bridge.token"), // per-boot access token (0600): bridge-only routes need it; `heimdall key` reads it
    keylessExternal: has("--keyless") || !has("--no-keyless"),
    site: process.env.HEIMDALL_SITE || SITE,
    frontierExecutors,
    opencodeUrl,
    log: (line) => console.log(new Date().toISOString().slice(11, 19) + "  " + line),
  });
  try {
    await bridge.listen();
  } catch (e) {
    releaseLock();
    if (e.code === "EADDRINUSE") {
      console.error(`port ${port} is taken — is heimdall already up? (open http://localhost:${port}) or pass --port`);
      process.exit(1);
    }
    throw e;
  }
  const url = `http://localhost:${port}/`;
  console.log("");
  console.log("  heimdall is up        " + url);
  console.log("  floor (upstream)      " + upstreams.join("  ->  ") + (floor.primaryIsChannel ? "   [first is khora's channel]" : "") + (installed.length ? `  (${installed.length} models)` : "  (not answering — pass-through will fail)"));
  console.log("  lending to phones     " + (lendModel || "nothing (no Ollama model)"));
  console.log("");
  console.log("  1. the page opens — it makes the fleet and shows a QR code");
  console.log("  2. scan it with your phone, tap Accept, type the phone's code on the page");
  console.log("     (or install a native app and link it at " + `http://localhost:${port}/link` + " — more reliable than WebGPU)");
  console.log("  3. point eoreader7 (or anything that speaks Ollama) at the fleet:");
  console.log(`       ER7_OLLAMA_HOSTS="local=${upstream},fleet=http://localhost:${port}"`);
  console.log("");
  console.log("  keep the page open — it is the fleet's controller. ctrl-c to stop.");
  console.log("");
  if (!noOpen) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
  }
  const stop = () => bridge.close().then(() => { releaseLock(); process.exit(0); });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
