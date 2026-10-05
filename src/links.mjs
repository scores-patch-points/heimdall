// links.mjs — native app hosts linked to the fleet (2026-10).
//
// heimdall's browser worker needs WebGPU, which is unreliable on phones. A
// native app (Android: "LLM AI Server with llama.cpp", "Ollama Local AI";
// iOS: "OnDevice LLM") runs the model on the phone's real GPU and exposes an
// Ollama- or OpenAI-compatible server on the LAN (or a Tailscale address, so
// it reaches across LANs and VPNs).
//
// This module is the pure, node-testable half: it persists the links, probes
// an endpoint to learn its wire and models, and resolves which link answers a
// requested model. The bridge carries the other half (routing + the page).
//
// A link is { name, url, kind: "ollama"|"openai", model, tag, models[], key? }:
//   - `model`  the native model id to send upstream (e.g. a GGUF filename)
//   - `tag`    the Ollama tag this link advertises, so eoreader7's ask matches
//   - `models` every model the endpoint reported on the last probe
//   - `key`    optional bearer token (some Android servers require one)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeTag } from "./models.js";

/** Where linked hosts live. macOS/Linux/Windows all happy with this. */
export const DEFAULT_LINKS_FILE = path.join(os.homedir(), ".heimdall", "hosts.json");

export function loadLinks(file = DEFAULT_LINKS_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j?.links) ? j.links : [];
  } catch {
    return [];
  }
}

export function saveLinks(links, file = DEFAULT_LINKS_FILE) {
  // lastFailAt is runtime health, never persisted
  const clean = (Array.isArray(links) ? links : []).filter((l) => l && l.url).map(({ lastFailAt, ...rest }) => rest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ links: clean }, null, 2));
  return clean;
}

/** Add or replace a link, keyed by URL. */
export function upsertLink(links, link) {
  const url = normalizeUrl(link?.url);
  if (!url) return Array.isArray(links) ? links.slice() : [];
  const rest = (links || []).filter((l) => normalizeUrl(l.url) !== url);
  return [...rest, { ...link, url }];
}

export function removeLink(links, url) {
  const u = normalizeUrl(url);
  return (links || []).filter((l) => normalizeUrl(l.url) !== u);
}

/** A user-pasted address, made fetchable. Defaults to http (LAN/Tailscale). */
export function normalizeUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Link-local / cloud-metadata addresses (169.254.0.0/16, fd00:ec2::254) are never a native host. */
export function isMetadataHost(url) {
  try { const h = new URL(url).hostname.toLowerCase(); return /^169\.254\./.test(h) || /^\[?fd00:ec2::/.test(h) || h === "metadata.google.internal"; } catch { return true; }
}

/** From a probe's JSON, what wire is it and which models does it list. */
export function classifyProbe(tagsJson, modelsJson) {
  const models = [];
  let kind = null;
  if (tagsJson && Array.isArray(tagsJson.models)) {
    kind = "ollama";
    for (const m of tagsJson.models) if (m?.name) models.push(String(m.name));
  } else if (modelsJson && Array.isArray(modelsJson.data)) {
    kind = "openai";
    for (const m of modelsJson.data) if (m?.id) models.push(String(m.id));
  }
  return { kind, models: [...new Set(models)] };
}

const FAMILY_TAGS = [
  [/gemma[-_ ]?2[-_ ]?2b/i, "gemma2:2b"],
  [/qwen2\.?5[-_ ]?0\.?5b/i, "qwen2.5:0.5b"],
  [/qwen3[-_ ]?1\.?7b/i, "qwen3:1.7b"],
  [/qwen3[-_ ]?4b/i, "qwen3:4b"],
  [/llama[-_ ]?3\.?2[-_ ]?1b/i, "llama3.2:1b"],
  [/llama[-_ ]?3\.?2[-_ ]?3b/i, "llama3.2:3b"],
  [/smollm2[-_ ]?1\.?7b/i, "smollm2:1.7b"],
  [/smollm2[-_ ]?360m/i, "smollm2:360m"],
];

/** Best-effort Ollama tag for a native model id, so asks can match. The
 *  tester always lets the person override this before saving. */
export function guessTag(modelId) {
  const s = String(modelId ?? "");
  if (!s) return null;
  for (const [re, tag] of FAMILY_TAGS) if (re.test(s)) return tag;
  // Fall back to a filename stem: strip dirs, extension and quant markers.
  const stem = s.split(/[\\/]/).pop()
    .replace(/\.(gguf|litertlm|bin|onnx)$/i, "")
    .replace(/[-_.](q\d.*|iq\d.*|f16|f32|fp16|int[48])$/i, "")
    .toLowerCase();
  return stem || null;
}

/** The names under which a link should advertise itself to a picker. */
export function linkAdvertisedModels(link) {
  return [...new Set([link?.tag, link?.model, ...(link?.models || [])].filter(Boolean).map(String))];
}

/** A link that failed before its first token this recently is skipped (it is not asked again until the window passes). */
export const LINK_SKIP_MS = 30_000;

/** Which link answers a requested Ollama model name, or null. A link whose
 *  `lastFailAt` is inside the skip window is passed over, so a dead native
 *  host costs one bounded failure per window, not one per request. Pure. */
export function resolveLink(links, model, { now = Date.now(), skipMs = LINK_SKIP_MS } = {}) {
  const want = model == null ? null : normalizeTag(model);
  const any = model === "any" || model === "fleet";
  for (const l of links || []) {
    if (!l?.url) continue;
    if (l.lastFailAt && now - l.lastFailAt < skipMs) continue;
    if (any) return l;
    if (l.tag && normalizeTag(l.tag) === want) return l;
    if ((l.models || []).some((m) => normalizeTag(m) === want)) return l;
    if (l.model && normalizeTag(l.model) === want) return l;
  }
  return null;
}

async function getJson(url, { fetchImpl, timeoutMs, key }) {
  const r = await fetchImpl(url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

/** Probe a native app endpoint: try Ollama's /api/tags, then OpenAI's
 *  /v1/models. Returns { ok, url, kind, models } or { ok:false, error }. */
export async function probeEndpoint(rawUrl, { fetchImpl = fetch, timeoutMs = 4000, key = null } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, url: null, error: "not a valid address" };
  if (isMetadataHost(url)) return { ok: false, url, error: "that address is a cloud-metadata endpoint, not a model server" };
  let tags = null;
  let models = null;
  let err = null;
  try {
    tags = await getJson(url + "/api/tags", { fetchImpl, timeoutMs, key });
  } catch (e) {
    err = e;
  }
  if (!tags) {
    try {
      models = await getJson(url + "/v1/models", { fetchImpl, timeoutMs, key });
    } catch (e) {
      err = e;
    }
  }
  const { kind, models: names } = classifyProbe(tags, models);
  if (!kind) return { ok: false, url, error: err?.message || "no Ollama or OpenAI endpoint answered" };
  return { ok: true, url, kind, models: names };
}
