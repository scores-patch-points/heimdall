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
import { emptyExecutor } from "./executors.js";
import { makeProviderRecord } from "./providers.js";

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
      const r = await fetchImpl(url + p, { signal: AbortSignal.timeout(timeoutMs) });
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
export async function probeInferenceAuth({ url, kind, key = null, model = "t", fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const base = (url || "").replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const endpoint = kind === "ollama" ? "/api/chat" : "/v1/chat/completions";
  const body = kind === "ollama"
    ? { model, messages: [{ role: "user", content: "hi" }], stream: false, options: { num_predict: 1 } }
    : { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false };
  try {
    const r = await fetchImpl(base + endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
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
 *  with a key gets its model list refreshed by live discovery. */
export async function discoverProviders(config = {}, { fetchImpl = fetch } = {}) {
  const out = [];
  for (const [provider, cfg] of Object.entries(config || {})) {
    if (!cfg?.key) continue;
    const rec = makeProviderRecord(provider, { base: cfg.base, reachable: false });
    if (!rec) continue;
    const d = await discoverEndpoint({ base: cfg.base || rec.base, kind: rec.endpointKind, fetchImpl }).catch(() => ({ ok: false }));
    if (!d.ok) {
      rec.live.lastError = "discovery failed";
      out.push(rec);
      continue;
    }
    const a = await probeInferenceAuth({ url: d.url, kind: d.kind, key: cfg.key, model: d.models[0] ?? "t", fetchImpl });
    rec.auth = authObservation({
      kind: rec.authClass,
      developerKey: true,
      inferenceKeyless: a.keyless,
      tested: a.tested,
    });
    rec.models = d.models.length ? d.models : rec.models;
    rec.live.reachable = true;
    rec.live.lastVerified = Date.now();
    rec.rateLimits.observed429 = 0;
    out.push(rec);
  }
  return out;
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

/** The full boot: in-process (browser only) + localhost probes + configured
 *  LAN/peers + Puter + credentialed providers. Returns executor records. */
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
  const providers = await discoverProviders(cfg.providers || {}, { fetchImpl });
  out.push(...providers);
  return out;
}