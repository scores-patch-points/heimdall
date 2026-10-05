// key-cli.js — the `heimdall key` command, as a pure-ish function so it can be
// tested with fake keys and a stub provider (bin/heimdall.mjs only wires it to
// the real state file, the real network and the real console).
//
//   heimdall key                          list stored keys (masked) + whether the running bridge loaded them
//   heimdall key <provider> <key> [--model <id> …]   add: test it live, store it, tell the running bridge, explain
//   heimdall key <provider>               test the key already stored (the "test again")
//   heimdall key --rm <provider>          remove it
//
// Every line returned is safe to print: the key never appears, only its masked tail.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogFor, loadProviderKeys } from "./providers.js";
import { addProviderKey, keyReport, maskKey, providerName } from "./keycheck.js";

const KNOWN = "anthropic openai groq openrouter mistral google cohere together cerebras (and more — see `heimdall discover`)";

/** The running bridge's per-boot access token (written 0600 by `heimdall up`), or null. The CLI runs as the same user, so it can read it. */
export function readBridgeToken(file = process.env.HEIMDALL_TOKEN_FILE || path.join(os.homedir(), ".heimdall", "bridge.token")) {
  try { return fs.readFileSync(file, "utf8").trim() || null; } catch { return null; }
}
const tokenHeaders = (tokenFile) => { const t = readBridgeToken(tokenFile); return t ? { "x-heimdall-token": t } : {}; };

/** Ask a RUNNING bridge to reload the stored keys. Key-free. Returns
 *  { state: "ready"|"not_running"|"older"|"error", models: [names for `provider`], total } . */
export async function pingBridge(provider, { port = 8790, fetchImpl = fetch, timeoutMs = 25_000, tokenFile } = {}) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/providers/refresh`, { method: "POST", headers: tokenHeaders(tokenFile), signal: AbortSignal.timeout(timeoutMs) });
    // The bridge answered, but has no such route: it started before this feature existed and runs older code.
    if (r.status === 404) return { state: "older", models: [], total: 0 };
    if (!r.ok) return { state: "error", models: [], total: 0, http: r.status };
    const j = await r.json().catch(() => ({}));
    return { state: "ready", models: Array.isArray(j.providers?.[provider]) ? j.providers[provider] : [], total: Number.isFinite(j.models) ? j.models : 0 };
  } catch {
    return { state: "not_running", models: [], total: 0 };
  }
}

/** Run one `heimdall key …` command. `args` is argv after the program name
 *  (args[0] === "key"). `state` is the parsed state.json; `save(state)` writes it.
 *  Returns { code, lines }. */
export async function keyCommand({ args, state, save, stateLabel = "~/.heimdall/state.json", fetchImpl = fetch, port = 8790, env = process.env, timeoutMs } = {}) {
  const lines = [];
  const say = (...l) => lines.push(...l);
  const providers = state.providerKeys || (state.providerKeys = {});
  const modelsOf = state.providerModels || (state.providerModels = {});
  const named = args.reduce((acc, a, i) => (a === "--model" && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
  const rm = args.includes("--rm");
  const provider = (args[1] === "--rm" ? args[2] : args[1])?.toLowerCase();
  const keyArg = args[1] === "--rm" ? args[3] : args[2];

  if (!provider || provider.startsWith("--")) {
    const rows = Object.entries(loadProviderKeys({ env, state }));
    say(rows.length ? "PROVIDER KEYS ON THIS COMPUTER" : "NO PROVIDER KEYS SAVED YET");
    let loaded = null;
    if (rows.length) {
      try {
        const r = await fetchImpl(`http://127.0.0.1:${port}/api/providers/keys`, { headers: tokenHeaders(), signal: AbortSignal.timeout(4000) });
        if (r.ok) loaded = Object.fromEntries(((await r.json()).providers || []).filter((p) => typeof p.loaded === "boolean").map((p) => [p.provider, p.loaded]));
      } catch {}
    }
    for (const [p, v] of rows) {
      const m = modelsOf[p]?.length ? `  models: ${modelsOf[p].join(", ")}` : "";
      const live = loaded == null ? "" : loaded[p] === true ? "  loaded by the running heimdall" : loaded[p] === false ? "  saved, but the running heimdall has NOT loaded it (restart it: heimdall up)" : "";
      say(`  ${providerName(p).padEnd(10)} ${maskKey(v.key)}${m}${live}`);
    }
    say("", "add:     heimdall key anthropic <your key>     (it is tested live and you are told what it unlocks)",
      "test:    heimdall key anthropic                (tests the saved key again)",
      "remove:  heimdall key --rm anthropic",
      "env:     HEIMDALL_KEY_<PROVIDER> also counts (nothing is stored).");
    return { code: 0, lines };
  }

  const known = catalogFor(provider);
  if (!known) {
    say(`"${provider}" is not a provider heimdall knows. Known ones: ${KNOWN}.`);
    return { code: 1, lines };
  }

  if (rm) {
    delete providers[provider];
    delete modelsOf[provider];
    save(state);
    const p = await pingBridge(provider, { port, fetchImpl });
    say(`Removed the ${providerName(provider)} key from this computer.`);
    if (p.state === "ready") say("The running heimdall has dropped it too.");
    else if (p.state === "older") say("The running heimdall started before this key was removed and could not reload; restart it with: heimdall up. (Until then it may still use the old key.)");
    return { code: 0, lines };
  }

  // Add (a key was given) or re-test (the stored one).
  let key = keyArg;
  const retest = !keyArg;
  if (retest) {
    key = loadProviderKeys({ env, state })[provider]?.key;
    if (!key) {
      say(`No ${providerName(provider)} key is saved yet. Add one with: heimdall key ${provider} <your key>`);
      return { code: 1, lines };
    }
  }
  const fromState = !!providers[provider];
  const out = await addProviderKey(state, provider, key, { named, fetchImpl, env, timeoutMs });
  if (out.saved && (!retest || fromState)) save(state); // never copy an env-only key into the state file
  const ping = out.saved ? await pingBridge(provider, { port, fetchImpl }) : { state: "not_checked", models: [], total: 0 };
  // What the person is told heimdall offers: what the running bridge really loaded, else what it will offer after a (re)start.
  const predicted = state.providerModels?.[provider] || [];
  const heimdall = ping.state === "ready" ? "ready" : ping.state === "older" ? "older" : "not_running";
  const models = ping.state === "ready" ? ping.models : predicted;
  const rep = keyReport({ provider, key, check: out.check, saved: out.saved, retest, models, heimdall: out.check.status === "works" ? heimdall : "ready", surface: "cli" });
  say(rep.headline, "", ...rep.lines.map((l) => "  " + l));
  if (out.saved && ping.state === "ready") {
    say("", ping.models.length
      ? `  Your running bridge picked it up: ${ping.models.length} ${providerName(provider)} model${ping.models.length === 1 ? "" : "s"} now available.`
      : `  Your running bridge reloaded, but it is not offering any ${providerName(provider)} model yet.`);
  } else if (out.saved && ping.state === "older" && out.check.status !== "works") {
    say("", "  Your running bridge started before this key and could not reload it. Restart it with: heimdall up (the key is saved, nothing is lost).");
  }
  if (!retest && named.length) say(`  Models you named: ${[...new Set(named)].join(", ")}`);
  if (!retest && out.registered.length) say(`  Models chosen from the live check: ${out.registered.join(", ")}  (add --model <name> to pick your own)`);
  say("", `  (stored in ${stateLabel}; the key is never shown again, only ${maskKey(key) || "••••"})`);
  return { code: out.check.status === "rejected" ? 1 : 0, lines };
}
