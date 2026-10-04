// providers.js — the self-healing provider catalog (2026-10).
//
// Heimdall should NOT bake the free-tier table in; it should rediscover it.
// A provider record is a place for observed facts to land: what auth class it
// holds, whether a card was required, what models it listed on the last live
// discovery, what rate limits its own responses revealed, when it was last
// verified. "Free" is observed (freeQuota), never assumed forever.
//
// The catalog seeds three kinds of lane:
//   - local / user-owned: WebLLM, Transformers.js, Ollama, llama.cpp,
//     LM Studio, LocalAI, Heimdall peers — no external-provider key,
//   - keyless-cloud adapters: Puter.js (user-pays, no developer key),
//   - credentialed providers with free tiers: OpenRouter, Groq, Mistral,
//     Cohere, Gemini, Cloudflare Workers AI, Hugging Face. Together is
//     deliberately NOT free-listed (docs require a $5 credit purchase as of
//     2025-07).
//
// Pure data + pure transitions; no network here (see discovery.js).

import { AUTH_CLASSES } from "./auth-class.js";

/** The two discovery surfaces a provider may expose. */
export const DISCOVERY = Object.freeze({
  openai: (base) => `${base}/v1/models`,
  ollama: (base) => `${base}/api/tags`,
  localai: (base) => `${base}/.well-known/localai.json`,
});

/** Endpoint template per provider. `openai` and `ollama` are wire shapes;
 *  `base` is the default base URL. */
const PROVIDER_ENDPOINTS = Object.freeze({
  openrouter: { kind: "openai", base: "https://openrouter.ai/api/v1" },
  groq: { kind: "openai", base: "https://api.groq.com/openai/v1" },
  mistral: { kind: "openai", base: "https://api.mistral.ai/v1" },
  cohere: { kind: "openai", base: "https://api.cohere.com/v2" },
  google: { kind: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  cloudflare: { kind: "openai", base: null }, // account-dependent: https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/v1
  huggingface: { kind: "openai", base: "https://router.huggingface.co/v1" },
  openai: { kind: "openai", base: "https://api.openai.com/v1" },
  anthropic: { kind: "anthropic", base: "https://api.anthropic.com/v1" },
  together: { kind: "openai", base: "https://api.together.xyz/v1" },
  cerebras: { kind: "openai", base: "https://api.cerebras.ai/v1" },
  // ---- free-tier, no-card providers (2026): OpenAI-compatible unless noted
  sambanova: { kind: "openai", base: "https://api.sambanova.ai/v1" },
  github: { kind: "openai", base: "https://models.github.ai/inference" },
  nvidia: { kind: "openai", base: "https://integrate.api.nvidia.com/v1" },
  ollamacloud: { kind: "openai", base: "https://ollama.com/v1" },
  zai: { kind: "openai", base: "https://api.z.ai/api/paas/v4" },
  modelscope: { kind: "openai", base: "https://api-inference.modelscope.cn/v1" },
  // ---- genuinely keyless inference (no developer key, no user session)
  // Bases are ORIGINS (discovery appends /v1/models, chat /v1/chat/completions).
  // Pollinations' OpenAI surface is /openai and its model list is /openai/models
  // (not /openai/v1/models), so its discovery path is overridden via path.
  pollinations: { kind: "openai", base: "https://text.pollinations.ai/openai", path: "/models" },
  llm7: { kind: "openai", base: "https://api.llm7.io" },
  ovh: { kind: "openai", base: "https://oai.endpoints.kepler.ai.cloud.ovh.net" },
});

/** Known free / keyless lanes, seeded so discovery has somewhere to start.
 *  `models` here is a CLAIM the provider publishes, not a measurement; live
 *  discovery overwrites it. `freeQuota` is a claim too until a response
 *  header or a doorbench proves it. */
export const PROVIDER_CATALOG = Object.freeze([
  // ---- local / user-owned (no external key, never leaves the trust domain)
  { provider: "webllm", authClass: "in_process", location: "local", cardRequired: false, trust: "local-raw", browser: true, models: [] },
  { provider: "transformers", authClass: "in_process", location: "local", cardRequired: false, trust: "local-raw", browser: true, models: [] },
  { provider: "ollama", authClass: "local_open", location: "local/LAN", cardRequired: false, trust: "local-raw", endpointKind: "ollama", base: "http://127.0.0.1:11434", models: [] },
  { provider: "llamacpp", authClass: "local_open", location: "local/LAN", cardRequired: false, trust: "local-raw", endpointKind: "openai", base: "http://127.0.0.1:8080", models: [] },
  { provider: "lmstudio", authClass: "local_open", location: "local/LAN", cardRequired: false, trust: "local-raw", endpointKind: "openai", base: "http://127.0.0.1:1234", models: [] },
  { provider: "localai", authClass: "optional_auth", location: "local/LAN", cardRequired: false, trust: "configured", endpointKind: "openai", base: "http://127.0.0.1:8080", models: [] },
  { provider: "vllm", authClass: "optional_auth", location: "local/LAN", cardRequired: false, trust: "configured", endpointKind: "openai", base: "http://127.0.0.1:8000", models: [] },
  { provider: "heimdall-peer", authClass: "local_open", location: "private-fleet", cardRequired: false, trust: "local-raw", browser: true, models: [] },
  // ---- keyless-cloud: the user's session pays, the developer holds no key
  { provider: "puter", authClass: "user_pays", location: "external", cardRequired: false, trust: "sealed-only", browser: true, endpointKind: "puter", models: [] },
  // ---- genuinely keyless inference (no developer key AND no user session).
  // These are public/anonymous OpenAI-compatible endpoints (some take an
  // optional key for higher limits). They are external and sealed-only; a
  // discovery probe measures reachability, and classifies them local_open
  // because inference is keyless.
  { provider: "pollinations", authClass: "local_open", location: "external", cardRequired: false, trust: "sealed-only", keyless: true, freeQuota: "anonymous tier, rate-limited (openai-fast)", models: ["openai-fast"] },
  { provider: "llm7", authClass: "local_open", location: "external", cardRequired: false, trust: "sealed-only", keyless: true, freeQuota: "anonymous 'turbo' models; a free token raises limits", models: [] },
  { provider: "ovh", authClass: "local_open", location: "external", cardRequired: false, trust: "sealed-only", keyless: true, freeQuota: "anonymous, 2 req/min/IP/model, 20+ open models", models: [] },
  // ---- credentialed providers with free tiers (claims; live discovery wins)
  { provider: "openrouter", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "50 req/day (free models)", models: ["openrouter/free", "openrouter/auto"] },
  { provider: "groq", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "30 RPM / 1k req/day / 200k tok/day (gpt-oss-120b)", models: ["gpt-oss-120b", "gpt-oss-20b", "qwen/qwen3-27b"] },
  { provider: "mistral", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "free tier, limited", models: [] },
  { provider: "cohere", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "~1k calls/month trial", models: [] },
  { provider: "google", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "model-specific free tier (data may train Google)", models: [] },
  { provider: "cloudflare", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "10k neurons/day", models: [] },
  { provider: "huggingface", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "$0.10/mo credit", models: [] },
  { provider: "sambanova", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "rate-limited free tier (no card); commercial license", models: [] },
  { provider: "github", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "GitHub account; Copilot-tier limits (15 RPM/150 RPD)", models: [] },
  { provider: "nvidia", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "40 RPM recurring rate limit", models: [], note: "NVIDIA NIM trial ToS: evaluation-only, not production" },
  { provider: "ollamacloud", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "$0 Free plan: cloud-hosted open models, 1 concurrent / 5h session", models: [] },
  { provider: "zai", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "permanent free models (GLM flash tier)", models: [] },
  { provider: "modelscope", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "free API-Inference; Alibaba Cloud + real-name verification required", models: [] },
  // ---- credentialed, paid
  { provider: "openai", authClass: "api_key", location: "external", cardRequired: true, trust: "sealed-only", models: [] },
  { provider: "anthropic", authClass: "api_key", location: "external", cardRequired: true, trust: "sealed-only", models: [] },
  { provider: "together", authClass: "api_key", location: "external", cardRequired: true, trust: "sealed-only", models: [], note: "not free — requires >= $5 credit as of 2025-07" },
  { provider: "cerebras", authClass: "api_key", location: "external", cardRequired: true, trust: "sealed-only", models: [] },
]);

/** A discovered server on someone's IP is NOT a legitimate free worker. These
 *  are the only legitimate sources of keyless compute. */
export const LEGITIMATE_SOURCES = Object.freeze([
  "ours/user machine",
  "user-authorized LAN endpoint",
  "heimdall peers",
  "explicitly public service with keyless terms",
  "user-session service (Puter)",
]);

export function catalogFor(providerName) {
  return PROVIDER_CATALOG.find((p) => p.provider === providerName) ?? null;
}

/** The configured provider keys, merged from env (`HEIMDALL_KEY_<PROVIDER>`)
 *  and the CLI's stored `state.providerKeys` (keys are entered on this
 *  machine and never reach a browser). Pure; returns { provider: { key } }.
 *
 *  `state.providerModels` (set by `heimdall key <provider> <key> --model …`)
 *  rides along as `{ provider: { key, models } }` so discovery can register a
 *  provider whose `/v1/models` cannot answer (Anthropic) as real executors. */
export function loadProviderKeys({ env = process.env, state = {} } = {}) {
  const providers = {};
  for (const [name, val] of Object.entries(env)) {
    const m = /^HEIMDALL_KEY_([A-Z0-9_]+)$/.exec(name);
    if (m && val) providers[m[1].toLowerCase()] = { key: val };
  }
  // `heimdall key` stores bare strings; discovery expects { key }. Normalize
  // both shapes so a stored key is never silently dropped (the pre-2026-10-04
  // `discover` bug: Object.assign passed strings straight through).
  for (const [name, val] of Object.entries(state.providerKeys || {})) {
    if (typeof val === "string" && val) providers[name] = { key: val };
    else if (val && typeof val === "object" && val.key) providers[name] = { key: val.key };
  }
  for (const [name, models] of Object.entries(state.providerModels || {})) {
    if (providers[name] && Array.isArray(models) && models.length) providers[name].models = models.filter(Boolean);
  }
  return providers;
}

export function endpointFor(providerName) {
  return PROVIDER_ENDPOINTS[providerName] ?? null;
}

/** A provider record with the self-healing shape. `claim` values are what we
 *  were told; discovery and doorbench overwrite them with measurements. */
export function makeProviderRecord(providerName, overrides = {}) {
  const claim = catalogFor(providerName);
  const ep = endpointFor(providerName);
  if (!claim) return null;
  return {
    provider: claim.provider,
    authClass: claim.authClass,
    location: claim.location,
    trust: claim.trust,
    cardRequired: claim.cardRequired,
    browser: claim.browser ?? false,
    endpointKind: claim.endpointKind ?? ep?.kind ?? "openai",
    base: overrides.base ?? claim.base ?? ep?.base ?? null,
    // claimed vs observed
    models: [...(claim.models || [])],
    freeQuota: claim.freeQuota ?? null,
    dataPolicy: overrides.dataPolicy ?? null,
    note: claim.note ?? null,
    // observed (null = never measured)
    live: {
      reachable: overrides.reachable ?? false,
      lastVerified: overrides.lastVerified ?? null,
      lastError: overrides.lastError ?? null,
    },
    rateLimits: {
      rpm: overrides.rpm ?? null,
      daily: overrides.daily ?? null,
      observed429: overrides.observed429 ?? 0,
    },
    lastVerified: overrides.lastVerified ?? null,
  };
}

/** A provider record is "live-discovered" once its model list has been
 *  replaced by a real probe (never trusted from the catalog alone). */
export function isLiveDiscovered(rec) {
  return Array.isArray(rec.models) && rec.models.length > 0 && rec.live?.lastVerified != null;
}

export function isValidAuthClass(cls) {
  return AUTH_CLASSES.includes(cls);
}