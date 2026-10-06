// hosted.js — small hosted open-model lanes: the cheap remote tier (2026-10).
//
// OpenRouter / Together / Fireworks / DeepInfra serve small open models (Gemma, Qwen, Llama) over the
// OpenAI wire for cents per million tokens. They are credentialed and SEALED-ONLY like any outside lane,
// but they are not "frontier": priced and counted as open-remote, and a request may be sent to several
// of them at once (race).
//
// Model ids change; the defaults below are CLAIMS. A key's own /models list decides what is registered
// (pickHostedModels), and the person can always name models themselves.
//
// Pure data + pure functions; no network, no fs.

/** provider -> { defaultModels (claims), usdInPerM/usdOutPerM (estimates, for the ledger), slots (requests we send at once; hosted APIs batch on their side, so this is our own politeness bound, not a measurement) }. */
export const HOSTED_OPEN = Object.freeze({
  openrouter: { defaultModels: ["google/gemma-2-9b-it", "qwen/qwen-2.5-7b-instruct", "meta-llama/llama-3.2-3b-instruct"], usdInPerM: 0.05, usdOutPerM: 0.1, slots: 8 },
  together: { defaultModels: ["google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct-Turbo", "meta-llama/Llama-3.2-3B-Instruct-Turbo"], usdInPerM: 0.1, usdOutPerM: 0.1, slots: 8 },
  fireworks: { defaultModels: ["accounts/fireworks/models/llama-v3p1-8b-instruct", "accounts/fireworks/models/llama-v3p2-3b-instruct"], usdInPerM: 0.1, usdOutPerM: 0.1, slots: 8 },
  deepinfra: { defaultModels: ["google/gemma-2-9b-it", "Qwen/Qwen2.5-7B-Instruct", "meta-llama/Meta-Llama-3.1-8B-Instruct"], usdInPerM: 0.03, usdOutPerM: 0.05, slots: 8 },
});

export const isHostedOpen = (provider) => Object.prototype.hasOwnProperty.call(HOSTED_OPEN, String(provider));

const NOT_CHAT = /(embed|rerank|guard|moderat|whisper|tts|speech|image|vision|flux|stable-?diffusion|sdxl|\bvl\b|ocr|transcri)/i;
// no reasoning models locally or hosted: the fold does the reasoning (product rule)
const REASONING = /(\br1\b|-r1|reason|think|qwq|o1-|o3-)/i;

/** Parameter count in billions read from a model id ("…-7b-…", "…8B…", "…3.2-3b…"); null when the id says nothing. */
export function paramsB(id) {
  const m = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
}

/** Small chat models out of a provider's model list: ≤ maxB parameters (an id that names no size is skipped),
 *  not an embedding/vision/guard/reasoning model, best-known families first. */
export function selectSmallModels(listed, { maxB = 14, max = 3 } = {}) {
  const FAMILY = /(gemma|qwen|llama|mistral|phi)/i;
  const rows = [...new Set((listed || []).filter((x) => typeof x === "string" && x))]
    .filter((id) => !NOT_CHAT.test(id) && !REASONING.test(id) && FAMILY.test(id))
    .map((id) => ({ id, b: paramsB(id) }))
    .filter((r) => r.b != null && r.b <= maxB && r.b >= 1);
  // gemma and qwen first (the fold's tested families), then bigger-within-limit first
  const rank = (r) => (/gemma/i.test(r.id) ? 0 : /qwen/i.test(r.id) ? 1 : 2);
  rows.sort((a, c) => rank(a) - rank(c) || c.b - a.b);
  return rows.slice(0, max).map((r) => r.id);
}

/** The models to register for a hosted provider's key: its defaults that the key's list confirms; when none is
 *  confirmed (ids moved), the best small models the list does show; when the list is unknown, the defaults. */
export function pickHostedModels(provider, listed = []) {
  const def = HOSTED_OPEN[provider]?.defaultModels ?? [];
  if (!listed?.length) return [...def];
  const have = new Set(listed);
  const confirmed = def.filter((m) => have.has(m));
  return confirmed.length ? confirmed : selectSmallModels(listed);
}

/** What a hosted lane looks like to the peer layer (PeerHello@1, peers.js): this server's key-holding lanes as
 *  one peer. The key never rides it, and the privacy class is sealed-external, so another Fold server may ask
 *  THIS server to run a job on a hosted model but can never see or reuse the credential. `slots` is how many
 *  requests the provider takes at once (hosted APIs batch on their side). Pure. */
export function hostedHello({ id, name = id, url = "", models = [], slots = 8, load = {}, now = Date.now() } = {}) {
  return {
    type: "PeerHello@1",
    id,
    name,
    url,
    models: [...new Set(models.filter(Boolean))].slice(0, 64),
    caps: { tools: false, structured: false, context: 0 },
    load: { inflight: Math.max(0, load.inflight ?? 0), queue: Math.max(0, load.queue ?? 0), tokensPerSec: Math.max(0, load.tokensPerSec ?? 0), slots },
    privacyClass: "sealed-external",
    ts: now,
  };
}
