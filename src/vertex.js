// vertex.js — Google Vertex AI as a heimdall lane (managed DeepSeek and the other "MaaS" open models).
//
// OWNER-ONLY. This lane runs on the operator's own Google credentials. It is configured by the operator's environment
// (HEIMDALL_VERTEX_PROJECT) and by nothing else: no surface can enter it (the key route refuses "vertex"), and nothing
// should route another person's request to it. Opening it to other users is undecided, and would put the operator's
// server between those users and the model — it would see their prompts.
//
// Vertex speaks the OpenAI chat wire on an endpoint that is per-project, so a lane needs two things a static key
// lane does not: a project-scoped BASE, and a CREDENTIAL THAT EXPIRES (an OAuth access token, about an hour). The
// token is never stored: it is fetched when a request needs it and held in memory for a little less than its life.
//
// Where the token comes from, in order:
//   1. HEIMDALL_VERTEX_TOKEN            — a token you minted yourself (tests, CI)
//   2. the GCE/GKE metadata server      — a server running on Google Cloud, as its service account (no secret on disk)
//   3. `gcloud auth print-access-token` — a developer machine that has run `gcloud auth login`
//
// REGION. `global` is the one location where DeepSeek V3.2 answered when this was wired (2026-10-05); the europe-west
// endpoints returned "not found" for this project. A `global` request is served from wherever Google chooses, so this
// lane is NOT region-pinned. `location` is a parameter so a pinned region is a one-word change the day Google serves it,
// and the lane's record says plainly what it is (VERTEX_NOTE).
//
// Pure except for the token source, whose process and network access are injectable.

import { spawn } from "node:child_process";

export const VERTEX_PROVIDER = "vertex";
export const VERTEX_DEFAULT_MODELS = Object.freeze(["deepseek-ai/deepseek-v3.2-maas"]);
export const VERTEX_PATH = "/chat/completions";   // NOT /v1/chat/completions: the Vertex openapi endpoint has no /v1 segment after `openapi`
export const VERTEX_NOTE = "OWNER-ONLY Google Vertex AI managed models. The global endpoint is served from wherever Google chooses — not region-pinned (europe-west4/west1 returned 'not found' for DeepSeek V3.2 on 2026-10-05).";
export const KEY_MARKER = "gcloud-adc";            // stands in the key slot so the lane reads as configured; never sent anywhere

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^(global|[a-z]+-[a-z]+\d+)$/;

/** The OpenAI-compatible base for one project and location, or null when either is not a valid Google identifier. */
export function vertexBase({ project, location = "global" } = {}) {
  if (!PROJECT.test(String(project || "")) || !LOCATION.test(String(location))) return null;
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

/** The Vertex settings from env and the stored state, or null when none are set. Env wins. */
export function vertexConfig({ env = process.env, state = {} } = {}) {
  const st = state?.providerKeys?.vertex;
  const stObj = st && typeof st === "object" ? st : null;
  const project = env.HEIMDALL_VERTEX_PROJECT || stObj?.project;
  const location = env.HEIMDALL_VERTEX_LOCATION || stObj?.location || "global";
  const base = vertexBase({ project, location });
  if (!base) return null;
  const named = String(env.HEIMDALL_VERTEX_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const models = named.length ? named : (Array.isArray(stObj?.models) && stObj.models.length ? stObj.models : [...VERTEX_DEFAULT_MODELS]);
  return { key: KEY_MARKER, base, project, location, models };
}

const runGcloud = () => new Promise((resolve, reject) => {
  let out = "", err = "";
  let p;
  try { p = spawn("gcloud", ["auth", "print-access-token"], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return reject(e); }
  const timer = setTimeout(() => { p.kill(); reject(new Error("gcloud timed out")); }, 20_000);
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("error", (e) => { clearTimeout(timer); reject(e); });
  p.on("close", (code) => { clearTimeout(timer); code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error("gcloud could not mint a token" + (err ? ": " + (err.split("\n").find((l) => /ERROR|error/.test(l)) || "").slice(0, 160) : ""))); });
});

const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** A token source: `get()` resolves a bearer token, cached in memory for `ttlMs` (default 45 min of the ~60 a token lives). */
export function createTokenSource({ env = process.env, fetchImpl = fetch, run = runGcloud, now = () => Date.now(), ttlMs = 45 * 60_000 } = {}) {
  let cached = null, at = 0, inflight = null;
  const mint = async () => {
    if (env.HEIMDALL_VERTEX_TOKEN) return { token: env.HEIMDALL_VERTEX_TOKEN, via: "env" };
    try {
      const r = await fetchImpl(METADATA, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1500) });
      if (r.ok) { const j = await r.json(); if (j?.access_token) return { token: j.access_token, via: "metadata", ttlMs: Math.max(60_000, ((j.expires_in || 3600) - 300) * 1000) }; }
    } catch { /* not on Google Cloud: fall through to gcloud */ }
    return { token: await run(), via: "gcloud" };
  };
  return {
    async get({ force = false } = {}) {
      if (!force && cached && now() - at < (cached.ttlMs || ttlMs)) return cached.token;
      if (!inflight) inflight = mint().then((m) => { cached = m; at = now(); return m.token; }).finally(() => { inflight = null; });
      return inflight;
    },
    /** Where the last token came from, without the token. */
    via() { return cached?.via || null; },
    clear() { cached = null; },
  };
}

let shared = null;
/** The process-wide token source. */
export function vertexTokens() { return (shared ||= createTokenSource()); }

/** The credential to put on a request for `provider`: the real token for Vertex, the stored key for everything else. */
export async function resolveKey(provider, key, { tokens = vertexTokens() } = {}) {
  return provider === VERTEX_PROVIDER ? tokens.get() : key;
}
