// discovery.js — the boot sequence: what can infer, and with what auth (2026-10).
//
// Discovery is FOUR separate assays, and Heimdall never infers one from another:
//
//   DISCOVER        does the endpoint exist and answer at all?
//   AUTH PROBE      can inference be invoked without a credential?
//   CAPABILITY      what model/protocol/capabilities exist there?
//   DOORBENCH       what can it actually do reliably?  (lived in executors.js)
//
// The trap this separation exists to prevent: a keyless /v1/models (Pollinations,
// LocalAI's /.well-known) says nothing about whether generation needs a key.
// Each endpoint carries TWO raw assays — discoveryKeyless and inferenceKeyless —
// and auth-class.js classifies from both.
//
// Sources of legitimate compute, in order (never "port 8080 answered somewhere
// on the internet"):
//   1. in-process         WebGPU / WebLLM / Transformers.js
//   2. localhost probes   :11434 Ollama · :1234 LM Studio · :8080 llama.cpp/LocalAI · :8000 vLLM
//   3. configured LAN / heimdall peers (test the discovery endpoint, observe auth)
//   4. browser keyless-cloud adapters (Puter.js)
//   5. configured credentialed providers (OpenAI-compatible, free tiers first)
//
// Pure-ish: network crossings take an injected fetch (node tests inject a fake;
// the page uses the real one). Returns executor records ready for executors.js.

import { authObservation, classifyAuth } from "./auth-class.js";
import { VERTEX_PROVIDER, VERTEX_PATH, resolveKey } from "./vertex.js";
import { emptyExecutor } from "./executors.js";
import { makeProviderRecord, PROVIDER_CATALOG, endpointFor } from "./providers.js";
import { listAnthropicModels, pickModels } from "./keycheck.js";
import { joinBase } from "./url.js";

export const LOCALHOST_PROBES = Object.freeze([
  { provider: "ollama", kind: "ollama", base: "http://127.0.0.1:11434", discovery: "/api/tags" },
  { provider: "lmstudio", kind: "openai", base: "http://127.0.0.1:1234", discovery: "/v1/models" },
  { provider: "llamacpp", kind: "openai", base: "http://127.0.0.1:8080", discovery: "/v1/models" },
  { provider: "localai", kind: "openai", base: "http://127.0.0.1:8080", discovery: "/.well-known/localai.json" },
  { provider: "vllm", kind: "openai", base: "http://127.0.0.1:8000", discovery: "/v1/models" },
]);

/** One discovery probe: does the endpoint exist, and what models does it claim?
 *  Pure result; no auth is sent. Returns { ok, kind, models, url } or { ok:false }. */
export async function discoverEndpoint({ base, kind, path = null, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const url = (base || "").replace(/\/+$/, "");
  if (!url) return { ok: false, error: "no base url" };
  const discoveryPath = path ?? (kind === "ollama" ? "/api/tags" : kind === "localai" ? "/.well-known/localai.json" : "/v1/models");
  const probe = async (p) => {
    try {
      const r = await fetchImpl(joinBase(url, p), { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const j = await r.json();
      return j;
    } catch {
      return null;
    }
  };
  // For an OpenAI-ish server that may also be LocalAI, try the well-known
  // discovery first (anonymous by design even when inference is protected).
  let json = kind === "localai" ? await probe("/.well-known/localai.json") : null;
  if (json && json.version) {
    const models = (json.models || []).map((m) => m.id || m).filter(Boolean);
    return { ok: true, kind: "openai", url, models: [...new Set(models)], discoveryKeyless: true, localai: true, version: json.version };
  }
  if (json) {
    // .well-known answered with something unrecognized — still a live endpoint.
    return { ok: true, kind: "openai", url, models: [], discoveryKeyless: true };
  }
  json = await probe(discoveryPath);
  if (kind === "ollama" && json && Array.isArray(json.models)) {
    return { ok: true, kind: "ollama", url, models: json.models.map((m) => m.name).filter(Boolean), discoveryKeyless: true };
  }
  if (json && Array.isArray(json.data)) {
    return { ok: true, kind: "openai", url, models: json.data.map((m) => m.id).filter(Boolean), discoveryKeyless: true };
  }
  return { ok: false, error: "no discovery endpoint answered" };
}

/** AUTH PROBE — the assay that must NOT be inferred from discovery. Can
 *  inference be invoked with no credential? Sends a one-token probe; a 401/403
 *  is "no", a 200 is "yes", a 429 is unknown (rate-limited, never convicted),
 *  and a 404 is a qualified "yes" — the request reached the inference endpoint
 *  without a credential and was refused on the model, not on the key. */
export async function probeInferenceAuth({ url, kind, key = null, model = "t", fetchImpl = fetch, timeoutMs = 20_000, path = null } = {}) {
  const base = (url || "").replace(/\/+$/, "");
  let headers = { "content-type": "application/json" };
  let endpoint, body;
  if (kind === "ollama") {
    endpoint = "/api/chat";
    headers.authorization = `Bearer ${key}`;
    body = { model, messages: [{ role: "user", content: "hi" }], stream: false, options: { num_predict: 1 } };
  } else if (kind === "anthropic") {
    // Anthropic's own wire: x-api-key (never Bearer) + anthropic-version, on
    // /v1/messages, base being the API root (…/v1 without a double /v1).
    endpoint = "/v1/messages";
    const root = base.replace(/\/v1$/, "");
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  } else {
    endpoint = path || "/v1/chat/completions";
    headers.authorization = `Bearer ${key}`;
    body = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false };
  }
  try {
    const r = await fetchImpl(joinBase(base, endpoint), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (r.status === 401 || r.status === 403) return { keyless: false, tested: true, status: r.status };
    if (r.status === 200) return { keyless: true, tested: true, status: r.status };
    if (r.status === 404) return { keyless: true, tested: true, status: r.status, note: "reached inference without a key (refused on the model)" };
    if (r.status === 429) return { keyless: null, tested: false, status: r.status, note: "rate-limited before probe" };
    return { keyless: null, tested: false, status: r.status };
  } catch (e) {
    return { keyless: null, tested: false, status: null, note: e?.message };
  }
}

/** One full endpoint assay: discovery, then auth probe, then an executor
 *  record with its auth observation. */
export async function assayEndpoint(settings, { fetchImpl = fetch } = {}) {
  const d = await discoverEndpoint({ ...settings, fetchImpl });
  if (!d.ok) return null;
  const a = await probeInferenceAuth({ url: d.url, kind: d.kind, key: settings.key ?? null, model: d.models[0] ?? "t", fetchImpl });
  const authClass = classifyAuth({
    developerKey: !!settings.key,
    userSession: settings.userSession ?? false,
    discoveryKeyless: d.discoveryKeyless,
    inferenceKeyless: a.keyless,
  });
  const exec = emptyExecutor({
    executor: `${settings.provider}:${d.models[0] || "local"}`,
    endpoint: d.url,
    model: d.models[0] ?? "local",
    provider: settings.provider,
    location: settings.location ?? "local/LAN",
    authClass,
    privacyClass: settings.location === "external" ? "sealed-only" : "local-raw",
  });
  exec.live.reachable = true;
  exec.advertised.structured = settings.advertised?.structured ?? false;
  exec.advertised.tools = settings.advertised?.tools ?? false;
  exec.auth = authObservation({
    kind: authClass,
    developerKey: !!settings.key,
    userSession: settings.userSession ?? false,
    discoveryKeyless: d.discoveryKeyless,
    inferenceKeyless: a.keyless,
    tested: a.tested,
    note: a.note ?? null,
  });
  exec.models = d.models;
  exec.cost = { kind: settings.location === "external" ? (settings.userSession ? "user-pays" : "provider") : "free/local", freeLocal: settings.location !== "external" };
  return exec;
}

/** Step 1 of boot: probe the well-known localhost ports. Each becomes an
 *  executor record with its own auth observation. */
export async function discoverLocalhost({ fetchImpl = fetch } = {}) {
  const out = [];
  for (const p of LOCALHOST_PROBES) {
    try {
      const rec = await assayEndpoint({ ...p, location: "local/LAN" }, { fetchImpl });
      if (rec) out.push(rec);
    } catch { /* a closed port is not a finding */ }
  }
  return out;
}

/** Step 2: configured credentialed providers (free tiers and paid alike).
 *  `config` is { provider: { key, base?, models? } }. A configured provider
 *  with a key gets its model list refreshed by live discovery.
 *
 *  When the configured models are NAMED (`cfg.models` non-empty), they are
 *  the models: each becomes its own executor, and the `/v1/models` assay is
 *  skipped. This is what makes a provider whose discovery endpoint is not an
 *  OpenAI `{data:[…]}` list — Anthropic's `/v1/models` — an actual frontier
 *  executor instead of a doctor that finds nothing. Discovery is a courtesy,
 *  not a gate: it can only REMOVE a lane it saw is dead (a successful probe
 *  that listed nothing), never a lane the person named. A provider with no
 *  named models keeps the old behavior — one executor from the discovered
 *  list, or the claims the catalog seeded. Pinned models only override by
 *  intent; when discovery also lists models they are merged in. */
export async function discoverProviders(config = {}, { fetchImpl = fetch } = {}) {
  const out = [];
  for (const [provider, cfg] of Object.entries(config || {})) {
    if (!cfg?.key) continue;
    const rec = makeProviderRecord(provider, { base: cfg.base, reachable: false });
    if (!rec) continue;
    let named = Array.isArray(cfg.models) ? cfg.models.filter(Boolean) : [];
    // Anthropic's model list needs the key and is not the OpenAI shape, so a key with no named models used to yield NO lanes at
    // all (measured 2026-10-05: key stored, /v1/models empty). Ask Anthropic which models this key can see and use the newest few.
    if (!named.length && rec.endpointKind === "anthropic") named = pickModels(await listAnthropicModels({ key: cfg.key, base: rec.base, fetchImpl }));
    // A named model list is a declaration, not a discovery result: it always
    // yields executors, so no `/v1/models` assay is needed (and Anthropic's
    // non-list shape can never blank the lane). Reachability is still measured:
    // each named model is inference-probed, and only a probe that did not
    // observe an auth failure is offered (a 200/404/keyless is reachable; a
    // 401/403 marks the executor unreachable with the reason, never silent).
    if (named.length) {
      // the models of one provider are probed together, not one after another (a save re-probes every provider's lanes)
      const execs = await Promise.all(named.map(async (model) => {
        const exec = executorFor(rec, cfg, model);
        // Vertex: the credential is a token minted now and the path has no /v1. No Google credential is a dead lane with its reason, never a throw.
        const isVertex = rec.provider === VERTEX_PROVIDER;
        let probeKey = cfg.key, a = null;
        if (isVertex) { try { probeKey = await resolveKey(VERTEX_PROVIDER, cfg.key); } catch (e) { a = { keyless: null, tested: false, status: null, note: "no Google credential: " + (e?.message || e) }; } }
        a = a || await probeInferenceAuth({ url: rec.base, kind: rec.endpointKind, key: probeKey, model, fetchImpl, path: isVertex ? VERTEX_PATH : null });
        // Reachable only on an answer that proves the key got through: 200/404 (keyless true) or a 429 (alive, throttled).
        // A refused key, a billing/validation error, a 5xx, or no answer at all (offline) is NOT a working lane.
        // A 404 elsewhere means "reached inference, refused on the model" and counts as reachable. For Vertex it means the publisher model is not
        // served at this location (the europe-west 404s of 2026-10-05), so only a real answer (or a throttle) counts.
        const alive = isVertex ? (a.status === 200 || a.status === 429) : (a.keyless === true || a.status === 429);
        exec.live.reachable = alive;
        exec.live.lastVerified = alive ? Date.now() : null;
        exec.live.lastError = alive ? null : a.keyless === false ? "inference probe refused the key (" + (a.status ?? "?") + ")" : a.status == null ? "could not reach the provider (" + (a.note || "no answer") + ")" : "provider answered " + a.status + " to the test message";
        exec.auth.inferenceKeyless = a.keyless;
        exec.auth.tested = a.tested;
        return exec;
      }));
      out.push(...execs);
      continue;
    }
    const d = await discoverEndpoint({ base: cfg.base || rec.base, kind: rec.endpointKind, fetchImpl }).catch(() => ({ ok: false }));
    if (!d.ok) {
      rec.live.lastError = "discovery failed";
      rec.executor = `${rec.provider}:?`; // still a named record for the UI, never `undefined`
      out.push(rec);
      continue;
    }
    const models = d.models.length ? d.models : rec.models;
    if (!models.length) {
      // The probe answered but listed nothing to infer on: not an executor.
      rec.live.lastError = "discovery listed no models";
      rec.executor = `${rec.provider}:?`;
      out.push(rec);
      continue;
    }
    for (const model of models) out.push(executorFor(rec, cfg, model, d.kind, true));
  }
  return out;
}

/** One frontier executor for one configured model: the provider record's
 *  claims, plus the auth verdict the inference probe gives (a configured key
 *  implies inference auth unless the probe explicitly observed otherwise).
 *  `reachable` is MEASURED by the caller's assay — true only where a probe
 *  answered; the named-model path sets it from its own inference probe. */
function executorFor(rec, cfg, model, kind = rec.endpointKind, reachable = false) {
  const exec = emptyExecutor({
    executor: `${rec.provider}:${model}`,
    endpoint: rec.base,
    model,
    provider: rec.provider,
    location: "external",
    authClass: rec.authClass,
    privacyClass: "sealed-only",
  });
  exec.live.reachable = reachable;
  exec.live.lastVerified = reachable ? Date.now() : null;
  exec.live.lastError = rec.live.lastError ?? null;
  exec.auth = authObservation({ kind: rec.authClass, developerKey: true, tested: true, inferenceKeyless: false, note: null });
  // The provider key rides the executor (inferOn reads auth.apiKey), so a
  // discovered frontier executor can actually speak — measured 2026-10-04:
  // the anthropic lane reached api.anthropic.com but 401'd because the key
  // never left the discovery config for the executor record.
  if (cfg?.key) exec.auth.apiKey = cfg.key;
  else if (cfg?.provider?.key) exec.auth.apiKey = cfg.provider.key;
  exec.models = [model];
  exec.advertised.structured = false;
  exec.advertised.tools = false;
  exec.cost = { kind: "provider", freeLocal: false };
  return exec;
}

/** Step 3: configured LAN / heimdall peers — a user-authorized endpoint list.
 *  `endpoints` is [{ base, kind?, key?, location, provider }]. These are
 *  always assayed (discovery + auth probe), never assumed keyless. */
export async function discoverConfigured(endpoints = [], { fetchImpl = fetch } = {}) {
  const out = [];
  for (const e of endpoints || []) {
    const rec = await assayEndpoint({ ...e, location: e.location ?? "local/LAN" }, { fetchImpl }).catch(() => null);
    if (rec) out.push(rec);
  }
  return out;
}

/** Step 4: Puter.js — the browser keyless-cloud adapter. In a browser, the
 *  developer does not provision a provider key; the user's Puter session pays.
 *  Detection is the SDK's own global; no key, no config. Returns null in node. */
export async function discoverPuter({ puter = null } = {}) {
  const p = puter ?? (typeof window !== "undefined" ? window.puter : null);
  if (!p?.auth?.isSignedIn) return null;
  try {
    const models = await p.ai.getModels?.();
    const names = Array.isArray(models) ? models.map((m) => m.id || m).filter(Boolean) : [];
    const rec = emptyExecutor({
      executor: names.length ? `puter:${names[0]}` : "puter:local",
      endpoint: "puter",
      model: names[0] ?? null,
      provider: "puter",
      location: "external",
      authClass: "user_pays",
      privacyClass: "sealed-only",
    });
    rec.live.reachable = true;
    rec.models = names;
    rec.auth = authObservation({ kind: "user_pays", userSession: true, tested: true, inferenceKeyless: true, note: "user session pays; no developer key" });
    rec.cost = { kind: "user-pays", freeLocal: false };
    return rec;
  } catch {
    return null;
  }
}

/** The keyless EXTERNAL providers from the catalog: public endpoints that
 *  infer with no developer key (some take an optional key for higher limits).
 *  Pollinations, LLM7, OVHcloud. They are `local_open` by auth
 *  (inference is keyless) but `external` and sealed-only by location, so a
 *  `local-raw` job never reaches them. */
export function keylessExternalProviders() {
  return PROVIDER_CATALOG.filter((p) => p.keyless && p.location === "external");
}

/** Step 3b: probe the keyless external providers. No key is configured, so
 *  each is discovered and inference-probed with no credential; only a probe
 *  that did not observe an auth failure yields executors, and one executor is
 *  made per model the endpoint lists (or the catalog's claim when it lists
 *  none). A provider with no usable model is dropped, never guessed. */
export async function discoverKeylessExternal({ fetchImpl = fetch, only = null } = {}) {
  const out = [];
  for (const claim of keylessExternalProviders()) {
    if (only && !only.includes(claim.provider)) continue;
    const ep = endpointFor(claim.provider);
    const base = claim.base ?? ep?.base ?? null;
    if (!base) continue;
    const kind = claim.endpointKind ?? ep?.kind ?? "openai";
    const path = claim.path ?? ep?.path ?? null; // e.g. Pollinations' /models
    const d = await discoverEndpoint({ base, kind, path, fetchImpl }).catch(() => ({ ok: false }));
    if (!d.ok) continue;
    const a = await probeInferenceAuth({ url: d.url, kind: d.kind, model: d.models[0] ?? "t", fetchImpl });
    // A models LISTING proves nothing about inference. Only a one-token chat probe that got through (200, or a 404 refused on
    // the model not the key) makes a keyless lane reachable; a 401/403 (asked for a credential), a 429/5xx or no answer does not.
    if (a.keyless !== true) continue;
    const models = d.models.length ? d.models : (claim.models || []);
    for (const model of models) {
      const rec = emptyExecutor({
        executor: `${claim.provider}:${model}`,
        endpoint: base,
        model,
        provider: claim.provider,
        location: "external",
        authClass: "local_open",
        privacyClass: "sealed-only",
      });
      rec.live.reachable = true;
      rec.live.lastVerified = Date.now();
      rec.models = [model];
      rec.auth = authObservation({ kind: "local_open", discoveryKeyless: d.discoveryKeyless, inferenceKeyless: a.keyless, tested: a.tested, note: "keyless external inference; no developer key" });
      rec.cost = { kind: "free/local", freeLocal: false };
      out.push(rec);
    }
  }
  return out;
}

/** The full boot: in-process (browser only) + localhost probes + configured
 *  LAN/peers + keyless external + Puter + credentialed providers. Returns
 *  executor records. */
export async function discoverAll({ config = null, browser = typeof window !== "undefined" } = {}, { fetchImpl = fetch } = {}) {
  const out = [];
  const cfg = config || {};
  if (browser) {
    const puterRec = await discoverPuter().catch(() => null);
    if (puterRec) out.push(puterRec);
    // In-process lanes are declared, not probed (no network).
    const inProcess = ["webllm", "transformers"];
    for (const p of inProcess) {
      const rec = emptyExecutor({ executor: `${p}:in-process`, model: null, provider: p, location: "local", authClass: "in_process", privacyClass: "local-raw" });
      rec.live.reachable = true;
      rec.cost = { kind: "free/local", freeLocal: true };
      rec.auth = authObservation({ kind: "in_process", tested: true, inferenceKeyless: true, note: "in-process inference; no HTTP credential" });
      out.push(rec);
    }
  }
  const local = await discoverLocalhost({ fetchImpl });
  out.push(...local);
  const configured = await discoverConfigured(cfg.endpoints || [], { fetchImpl });
  out.push(...configured);
  // Keyless external providers only when the caller opted in (the bridge's
  // boot asks for them; a bare probe sweep stays local by default).
  if (cfg.keylessExternal) {
    const keyless = await discoverKeylessExternal({ fetchImpl }).catch(() => []);
    out.push(...keyless);
  }
  const providers = await discoverProviders(cfg.providers || {}, { fetchImpl });
  out.push(...providers);
  return out;
}