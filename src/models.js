// models.js — one model, two names (2026-09-21).
//
// A phone runs WebLLM weights (`gemma-2-2b-it-q4f16_1-MLC`); the computer's
// callers (eoreader7, the fold, anything that speaks Ollama) ask for Ollama
// tags (`gemma2:2b`). Same model family, same size, same instruct tune —
// different quantization and runtime. This table is the only place the two
// names meet, so the bridge can offer a phone as one more Ollama host
// without anyone guessing.
//
// Pure and node-importable: the bridge server, the page, and the tests all
// read it.

/** WebLLM id → Ollama tag. Both quantizations of a model map to one tag; the
 *  device picks the variant it can run (shader-f16 or not). */
export const OLLAMA_TAG = Object.freeze({
  "gemma-2-2b-it-q4f16_1-MLC": "gemma2:2b",
  "gemma-2-2b-it-q4f32_1-MLC": "gemma2:2b",
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC": "qwen2.5:0.5b",
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC": "qwen2.5:0.5b",
  "Qwen2.5-0.5B-Instruct-onnx-q4": "qwen2.5:0.5b", // the CPU (WebAssembly) build — no GPU needed
  "Qwen3-1.7B-q4f16_1-MLC": "qwen3:1.7b",
  "Qwen3-1.7B-q4f32_1-MLC": "qwen3:1.7b",
  "Qwen3-4B-q4f16_1-MLC": "qwen3:4b",
  "Qwen3-4B-q4f32_1-MLC": "qwen3:4b",
  "SmolLM2-360M-Instruct-q4f16_1-MLC": "smollm2:360m",
  "SmolLM2-360M-Instruct-q4f32_1-MLC": "smollm2:360m",
  "SmolLM2-1.7B-Instruct-q4f16_1-MLC": "smollm2:1.7b",
  "SmolLM2-1.7B-Instruct-q4f32_1-MLC": "smollm2:1.7b",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": "llama3.2:1b",
  "Llama-3.2-1B-Instruct-q4f32_1-MLC": "llama3.2:1b",
  "Llama-3.2-3B-Instruct-q4f16_1-MLC": "llama3.2:3b",
  "Llama-3.2-3B-Instruct-q4f32_1-MLC": "llama3.2:3b",
});

/** Ollama's own default tags: `llama3.2` / `llama3.2:latest` are the 3B. */
const TAG_DEFAULTS = Object.freeze({ "llama3.2": "llama3.2:3b", "gemma2": "gemma2:9b", "qwen3": "qwen3:8b", "smollm2": "smollm2:1.7b", "qwen2.5": "qwen2.5:7b" });

/** Normalize an Ollama tag the way Ollama resolves it. */
export function normalizeTag(name) {
  if (typeof name !== "string" || !name.trim()) return null;
  let n = name.trim().toLowerCase();
  if (n.endsWith(":latest")) n = n.slice(0, -":latest".length);
  if (!n.includes(":")) n = TAG_DEFAULTS[n] ?? `${n}:latest`;
  return n;
}

/** The Ollama tag a WebLLM id answers to, or null. */
export function ollamaTagOf(webllmId) {
  return OLLAMA_TAG[webllmId] ?? null;
}

/** True when a loaded WebLLM model answers a request naming `name` — the
 *  exact WebLLM id, or the Ollama tag it maps to. Never a near miss. */
export function answers(webllmId, name) {
  if (!webllmId || !name) return false;
  if (webllmId === name) return true;
  const tag = ollamaTagOf(webllmId);
  return tag != null && tag === normalizeTag(name);
}

/** The WebLLM id of the same model in the other quantization (f16 ⟷ f32). */
export function f32Variant(webllmId) {
  return typeof webllmId === "string" ? webllmId.replace("q4f16_1", "q4f32_1") : webllmId;
}
