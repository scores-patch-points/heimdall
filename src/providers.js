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
  // ---- credentialed providers with free tiers (claims; live discovery wins)
  { provider: "openrouter", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "50 req/day (free models)", models: ["openrouter/free", "openrouter/auto"] },
  { provider: "groq", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "30 RPM / 1k req/day / 200k tok/day (gpt-oss-120b)", models: ["gpt-oss-120b", "gpt-oss-20b", "qwen/qwen3-27b"] },
  { provider: "mistral", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "free tier, limited", models: [] },
  { provider: "cohere", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "~1k calls/month trial", models: [] },
  { provider: "google", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "model-specific free tier (data may train Google)", models: [] },
  { provider: "cloudflare", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "10k neurons/day", models: [] },
  { provider: "huggingface", authClass: "api_key", location: "external", cardRequired: false, trust: "sealed-only", freeQuota: "$0.10/mo credit", models: [] },
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