// url.js — join a provider base and an OpenAI-wire path without doubling /v1.
//
// Catalogued bases are inconsistent: some are origins ("https://api.llm7.io") and some already
// end in the version segment ("https://openrouter.ai/api/v1", "https://api.together.xyz/v1").
// The chat/discovery code appends "/v1/…", so a /v1 base used to produce ".../v1/v1/chat/completions" —
// a 404 that the auth probe counts as "reached inference", i.e. a silently dead lane.

/** `joinBase("https://x/api/v1", "/v1/models")` → "https://x/api/v1/models".
 *  Only a trailing /v1 on the base collapses against a leading /v1 on the path. */
export function joinBase(base, path = "") {
  const root = String(base ?? "").replace(/\/+$/, "");
  const p = String(path ?? "");
  if (VERSIONED_ROOT.test(root) && /^\/v1(\/|$)/.test(p)) return root + p.slice(3);
  return root + p;
}
// a base that already ends in the version segment: …/v1, DeepInfra's …/v1/openai, Google's …/v1beta/openai
const VERSIONED_ROOT = /\/v1(beta)?(\/openai)?$/;
