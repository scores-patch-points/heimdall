// keycheck.js — what a person sees when they add an API key (2026-10).
//
// Adding a key used to print "stored" and nothing else: no proof the key
// worked, no word on what it unlocked, nothing about what to do if it did not.
// This module is the one place that answers all four questions, in plain words:
//
//   1. RECEIVED   the key was stored — shown only as a masked tail (••••abcd)
//   2. WORKS?     a live, one-token check against the provider itself
//                 → works | rejected | rate_limited | no_network (+ the real reason)
//   3. UNLOCKS    which models heimdall now serves, that the Fold's online
//                 escalation can use them, and what stays private
//   4. NEXT       what to do if it did not work
//
// The key never appears in anything returned from here: every string that could
// carry provider text passes through redactKey(), and only maskKey() is shown.
// Network crossings take an injected fetch (tests use a stub server and FAKE
// keys; a real key is only ever used by the person's own `heimdall key` call).

import { endpointFor, catalogFor } from "./providers.js";
import { isHostedOpen, pickHostedModels } from "./hosted.js";
import { joinBase } from "./url.js";

const BULLET = "•";

/** Show only that a key exists and how it ends: ••••abcd. A key too short to
 *  hide behind a 4-character tail shows no tail at all. Never the whole key. */
export function maskKey(key) {
  const k = String(key ?? "").trim();
  if (!k) return "";
  return k.length >= 12 ? BULLET.repeat(4) + k.slice(-4) : BULLET.repeat(4);
}

/** Replace every occurrence of the key (and its trimmed form) inside any text
 *  with its masked form — used on anything a provider sent back. */
export function redactKey(text, key) {
  let s = String(text ?? "");
  const k = String(key ?? "").trim();
  if (k.length >= 6) s = s.split(k).join(maskKey(k));
  return s;
}

/** Plain provider names for the sentences. */
const NAMES = { anthropic: "Anthropic", openai: "OpenAI", groq: "Groq", openrouter: "OpenRouter", mistral: "Mistral", google: "Google", cohere: "Cohere", together: "Together", cerebras: "Cerebras", fireworks: "Fireworks", deepinfra: "DeepInfra" };
export const providerName = (p) => NAMES[p] || (p ? p[0].toUpperCase() + p.slice(1) : "the provider");

/** Where a person gets a fresh key, per provider. */
const KEY_PAGES = {
  anthropic: "console.anthropic.com/settings/keys",
  openai: "platform.openai.com/api-keys",
  groq: "console.groq.com/keys",
  openrouter: "openrouter.ai/keys",
  mistral: "console.mistral.ai/api-keys",
  together: "api.together.ai/settings/api-keys",
  fireworks: "app.fireworks.ai/settings/users/api-keys",
  deepinfra: "deepinfra.com/dash/api_keys",
};
const BILLING_PAGES = { anthropic: "console.anthropic.com (Plans & Billing)", openai: "platform.openai.com (Billing)" };

const ANTHROPIC_VERSION = "2023-06-01";
/** The cheapest Claude, used for the one-token test when none is named. */
export const ANTHROPIC_CHECK_MODEL = "claude-haiku-4-5";
const CHECK_TIMEOUT_MS = 15_000;

/** Where to send the test. `HEIMDALL_KEYCHECK_BASE_<PROVIDER>` overrides it
 *  (a proxy, or a stub server in tests). */
export function checkBase(provider, env = process.env) {
  const o = env?.["HEIMDALL_KEYCHECK_BASE_" + String(provider).toUpperCase()];
  if (o) return String(o).replace(/\/+$/, "");
  const ep = endpointFor(provider) || {};
  return (catalogFor(provider)?.base || ep.base || "").replace(/\/+$/, "") || null;
}

async function readJson(r) {
  try { if (typeof r.json === "function") return await r.json(); } catch {}
  return null;
}
const providerMessage = (j) => String(j?.error?.message ?? j?.error ?? j?.message ?? "").slice(0, 200);

/** The Anthropic model ids this key can see (newest first), best effort: a
 *  failure here is never a verdict on the key. */
export async function listAnthropicModels({ key, base, fetchImpl = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  try {
    const r = await fetchImpl((base || checkBase("anthropic")) + "/models?limit=50", { headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return [];
    const j = await readJson(r);
    return (Array.isArray(j?.data) ? j.data : []).map((m) => m?.id).filter((id) => typeof id === "string" && /^claude-/i.test(id));
  } catch { return []; }
}

/** The models worth registering as heimdall lanes when the person named none:
 *  the newest few the key can actually see. */
export function pickModels(listed, { max = 4 } = {}) {
  return [...new Set((listed || []).filter(Boolean))].slice(0, max);
}

function verdict(status, extra = {}) {
  return { status, label: LABELS[status], ...extra };
}
const LABELS = {
  works: "works",
  rejected: "rejected (wrong or expired key)",
  no_credit: "key is real, but the account has no credit",
  rate_limited: "rate limited",
  no_network: "no network",
  provider_error: "the provider had a problem",
  unchecked: "not checked",
};

/** One live test of a key against its provider. Never throws; never returns the
 *  key. Anthropic: a real 1-token message (the only proof it can generate).
 *  OpenAI-style providers: the model-list call, which also needs the key and
 *  costs nothing. Returns
 *    { status, label, http, reason, model, models, base }
 *  where status is one of works | rejected | no_credit | rate_limited |
 *  no_network | provider_error | unchecked. */
export async function checkProviderKey(provider, key, { model = null, fetchImpl = fetch, timeoutMs = CHECK_TIMEOUT_MS, env = process.env } = {}) {
  const name = providerName(provider);
  const ep = endpointFor(provider);
  const base = checkBase(provider, env);
  const k = String(key ?? "").trim();
  const done = (v) => ({ ...v, reason: redactKey(v.reason, k), provider, base });
  if (!k) return done(verdict("rejected", { http: null, reason: `No key was given, so there is nothing to test.` }));
  if (!ep || !base) return done(verdict("unchecked", { http: null, reason: `heimdall does not know how to test ${name} keys yet, so this one was saved but not tested.` }));

  const classify = (status, j, ctx) => {
    const msg = providerMessage(j);
    if (status === 401) {
      const shape = provider === "anthropic" && !k.startsWith("sk-ant-") ? ` Anthropic keys start with "sk-ant-" and this one does not, so it may be the wrong thing copied.` : "";
      return verdict("rejected", { http: status, reason: `${name} said this key is not valid. It is mistyped, cut short when copied, or it has been revoked or has expired.${shape}` });
    }
    if (status === 403) return verdict("rejected", { http: status, reason: `${name} recognised the key but will not let it do this${msg ? ` (${msg})` : ""}. Its permissions, workspace or region block it.` });
    if (status === 429) return verdict("rate_limited", { http: status, reason: `${name} says there have been too many requests, or this key's usage cap is reached. The key itself is probably fine.${ctx.retryAfter ? ` It asked to wait ${ctx.retryAfter} seconds.` : ""}` });
    if (status === 402 || (status === 400 && /credit|billing|balance|quota/i.test(msg))) return verdict("no_credit", { http: status, reason: `${name} accepted the key, but the account has no credit left${msg ? ` ("${msg}")` : ""}.` });
    if (status >= 500) return verdict("provider_error", { http: status, reason: `${name}'s service had a problem (HTTP ${status}${msg ? `: ${msg}` : ""}). That is on their side, not yours.` });
    return verdict("provider_error", { http: status, reason: `${name} answered something unexpected (HTTP ${status}${msg ? `: ${msg}` : ""}), so the key could not be confirmed.` });
  };
  const offline = (e) => verdict("no_network", { http: null, reason: e?.name === "TimeoutError" || e?.name === "AbortError" ? `${name} did not answer within ${Math.round(timeoutMs / 1000)} seconds, so the key could not be tested. Nothing says it is wrong.` : `This computer could not reach ${name} (${String(e?.message || e).slice(0, 80)}). That is the connection (offline, a firewall or a proxy), not the key.` });

  try {
    if (ep.kind === "anthropic") {
      const send = (m) => fetchImpl(base + "/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": k, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: m, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let tried = model || ANTHROPIC_CHECK_MODEL;
      let r = await send(tried);
      if (r.status === 0) return done(offline(new Error("no response")));
      if (r.status === 404) {
        // Unknown model name: the key itself was accepted (the key is checked first).
        // Find a model this key can really use and test that one.
        const listed = await listAnthropicModels({ key: k, base, fetchImpl, timeoutMs });
        if (listed.length) { tried = listed[0]; r = await send(tried); }
        else return done(verdict("works", { http: 404, model: tried, models: [], reason: `${name} accepted the key (it only said the test model "${tried}" is not available to it).` }));
      }
      if (r.status === 0) return done(offline(new Error("no response")));
      if (r.ok) {
        const models = pickModels([...(model ? [model] : []), ...(await listAnthropicModels({ key: k, base, fetchImpl, timeoutMs }))].concat([tried]));
        return done(verdict("works", { http: r.status, model: tried, models, reason: `${name} accepted the key and answered a one-word test with ${tried}.` }));
      }
      const j = await readJson(r);
      return done(classify(r.status, j, { retryAfter: r.headers?.get?.("retry-after") }));
    }
    // OpenAI-style: GET {base}/models with a Bearer key.
    const r = await fetchImpl(joinBase(base, "/models"), { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 0) return done(offline(new Error("no response")));
    if (r.ok) {
      const j = await readJson(r);
      const models = (Array.isArray(j?.data) ? j.data : []).map((m) => m?.id).filter(Boolean);
      return done(verdict("works", { http: r.status, model: null, models: models.slice(0, 50), listed: models.slice(0, 2000), reason: `${name} accepted the key and listed ${models.length} model${models.length === 1 ? "" : "s"} for it.` }));
    }
    const j = await readJson(r);
    return done(classify(r.status, j, { retryAfter: r.headers?.get?.("retry-after") }));
  } catch (e) {
    return done(offline(e));
  }
}

/** What to do next, in the words of the surface the person is on. `surface`:
 *  "cli" (terminal) or "app" (the Fold's settings). */
export function nextSteps(provider, check, { surface = "cli" } = {}) {
  const name = providerName(provider);
  const page = KEY_PAGES[provider];
  const again = surface === "app" ? `press Save again` : `run: heimdall key ${provider} <your key>`;
  const retest = surface === "app" ? `press "Test again"` : `run: heimdall key ${provider}   (with no key, to test the saved one)`;
  switch (check?.status) {
    case "works": return [];
    case "rejected": return [
      `Get a fresh key${page ? ` at ${page}` : ` from your ${name} account`}, copy the WHOLE thing, and ${again}.`,
    ];
    case "no_credit": return [`Add credit${BILLING_PAGES[provider] ? ` at ${BILLING_PAGES[provider]}` : ` to your ${name} account`}, then ${retest}.`];
    case "rate_limited": return [`Wait a minute, then ${retest}. If it keeps happening, check your ${name} usage limits.`];
    case "no_network": return [`Check this computer's internet connection, then ${retest}. The key is saved either way.`];
    case "provider_error": return [`This is ${name}'s side. Try again in a few minutes: ${retest}.`];
    default: return [];
  }
}

/** What a good key opens up, and what it does not. `models` are the model names
 *  heimdall now serves for this provider; `heimdall` is "ready" (the running
 *  bridge picked them up), "not_running" (start it), or "older" (a running bridge
 *  that cannot report). */
export function unlockLines(provider, { models = [], heimdall = "ready" } = {}) {
  const name = providerName(provider);
  const list = models.length ? models.join(", ") : null;
  const out = [];
  if (heimdall === "not_running") {
    out.push(`heimdall is not running right now, so nothing is switched on yet. Start it with: heimdall up. It will load this key and offer ${list ? list : `${name}'s models`}.`);
  } else if (heimdall === "older") {
    out.push(`Your running heimdall started before this key was saved and could not reload it. Restart it with: heimdall up. The key is saved, nothing is lost${list ? `; after the restart it will offer ${list}` : ""}.`);
  } else if (list) {
    out.push(`Unlocked: ${list}. heimdall now offers ${models.length === 1 ? "this model" : "these models"} (they show under "${isHostedOpen(provider) ? "Open remote" : "Frontier · sealed"}" in the Fold's model list).`);
    out.push(`The Fold's online help can now use ${models.length === 1 ? "it" : "them"}: when your own computer's model is slow or gets stuck on a code task, the Fold can ask ${name} for one more try.`);
  } else {
    out.push(`The key is saved, but heimdall is not offering any ${name} model yet. Name one when you add it, e.g.: heimdall key ${provider} <your key> --model <model name>.`);
  }
  out.push(`Stays private: your files and workspace never leave this computer. ${name} only ever sees the text of the question you send it, and only through the Fold's sealed gate. The key itself stays on this computer and is never sent to the browser page or to any other model.`);
  return out;
}

/** The full, plain-language report for a key that was just added (or re-tested).
 *  Pure. Returns { ok, tone, headline, lines, text } — `lines` is everything to
 *  show under the headline; `text` is headline + lines for a terminal.
 *  Never contains the key. */
export function keyReport({ provider, key, check, saved = true, retest = false, models = [], heimdall = "ready", surface = "cli" } = {}) {
  const name = providerName(provider);
  const mask = maskKey(key);
  const tail = mask ? ` (${mask})` : "";
  const st = check?.status || "unchecked";
  const good = st === "works";
  const heads = {
    works: `${name} key works${tail}`,
    rejected: retest ? `${name} rejected the saved key${tail}` : `${name} rejected this key${tail}. It was NOT saved.`,
    no_credit: `${name} accepts this key${tail}, but the account has no credit`,
    rate_limited: `${name} is rate limiting right now${tail}. Saved, not yet confirmed.`,
    no_network: `Saved, but could not be tested: no network${tail}`,
    provider_error: `Saved, but ${name} had a problem answering${tail}`,
    unchecked: `Saved${tail}, but not tested`,
  };
  const lines = [];
  lines.push(retest
    ? `Tested the ${name} key stored on this computer ${mask || "(hidden)"}.`
    : saved
    ? `Received and stored: your ${name} key ${mask || "(hidden)"}, kept on this computer only. It is never shown again.`
    : `Received, but not stored: your ${name} key ${mask || "(hidden)"}. Anything you had saved before is untouched.`);
  lines.push(`Live check: ${check?.label || LABELS[st]}. ${check?.reason || ""}`.trim());
  if (good || (st === "rate_limited" && models.length)) lines.push(...unlockLines(provider, { models, heimdall }));
  else if (saved && st !== "rejected") lines.push(`Nothing is switched on yet: ${name} models stay off in the Fold until a check passes.`);
  for (const s of nextSteps(provider, check, { surface })) lines.push(`Next: ${s}`);
  const tone = good ? "ok" : (st === "rejected" ? "bad" : "warn");
  const headline = heads[st] || heads.unchecked;
  return { ok: good, tone, headline, lines, text: [headline, ...lines.map((l) => "  " + l)].join("\n") };
}

/** Which models (if any) to write into state.providerModels for a provider the
 *  person gave no model names for. Only providers whose own model list heimdall
 *  cannot read without a key (Anthropic) need this; models come from the live
 *  check, never from a guess. Returns an array (possibly empty). */
export function verifiedModelsToRegister(provider, check, existing = []) {
  if (existing?.length) return [];
  // hosted open-model providers: register a few SMALL models the key's own list confirms, so the key unlocks lanes at once
  if (isHostedOpen(provider)) return check?.status === "works" ? pickHostedModels(provider, check.listed || check.models || []) : [];
  if (endpointFor(provider)?.kind !== "anthropic") return [];
  if (check?.status !== "works") return [];
  return pickModels([check.model, ...(check.models || [])]);
}

/** The whole add-a-key step, shared by the CLI and the bridge so they cannot
 *  disagree: test the key live, then change `state` (the parsed state.json) ONLY
 *  when the key was not rejected. A rejected key never replaces a saved one and
 *  is never recorded as working. `named` are models the person asked for with
 *  --model; when there are none, the models the live check proved are registered
 *  (Anthropic only), so the key actually unlocks lanes.
 *  Returns { check, saved, registered:[models written to state] }. */
export async function addProviderKey(state, provider, key, { named = [], fetchImpl = fetch, env = process.env, timeoutMs } = {}) {
  const k = String(key ?? "").trim();
  const modelsOf = state.providerModels || (state.providerModels = {});
  const providers = state.providerKeys || (state.providerKeys = {});
  const check = await checkProviderKey(provider, k, { model: named[0] || null, fetchImpl, env, ...(timeoutMs ? { timeoutMs } : {}) });
  if (check.status === "rejected") return { check, saved: false, registered: [] };
  providers[provider] = k;
  if (named.length) modelsOf[provider] = [...new Set(named)];
  const registered = verifiedModelsToRegister(provider, check, modelsOf[provider] || []);
  if (registered.length) modelsOf[provider] = registered;
  return { check, saved: true, registered };
}
