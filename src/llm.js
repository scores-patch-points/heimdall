import { CreateMLCEngine, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { ollamaTagOf, f32Variant } from "./models.js";

// `tag` is the Ollama name the computer's callers use for the same model
// (models.js) — a worker loaded with gemma-2-2b answers eoreader7's
// `gemma2:2b` jobs through the bridge.
export const MODEL_CHOICES = [
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B — matches the computer's default (gemma2:2b), ~1.9 GB", default: true },
  { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen 2.5 0.5B — fast, low-memory, ~0.9 GB" },
  { id: "Qwen3-1.7B-q4f16_1-MLC", label: "Qwen 3 1.7B — ~2 GB" },
  { id: "SmolLM2-360M-Instruct-q4f16_1-MLC", label: "SmolLM2 360M — tiny" },
  { id: "SmolLM2-1.7B-Instruct-q4f16_1-MLC", label: "SmolLM2 1.7B — ~1.8 GB" },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B — balanced" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B — desktop only" },
  { id: "Qwen3-4B-q4f16_1-MLC", label: "Qwen 3 4B — desktop only, ~3.4 GB" },
].map((m) => ({ ...m, tag: ollamaTagOf(m.id) }));

export const DEFAULT_MODEL = MODEL_CHOICES.find((m) => m.default).id;
/** The small model a device falls back to when the default will not load. */
export const FALLBACK_MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

/** Whether this GPU can run the f16 builds. Measured from the adapter, not
 *  assumed: a GPU without shader-f16 gets the f32 build of the same model. */
export async function gpuSupportsF16() {
  try {
    const adapter = await navigator.gpu?.requestAdapter?.();
    return !!adapter?.features?.has?.("shader-f16");
  } catch {
    return false;
  }
}

/** The build of `modelId` this device can run. */
export async function runnableVariant(modelId) {
  return (await gpuSupportsF16()) ? modelId : f32Variant(modelId);
}

/**
 * Owns the WebLLM engine on the worker device. Inference requests are
 * serialized so one model serves one job at a time.
 */
export class WorkerEngine {
  constructor(onProgress) {
    this.engine = null;
    this.modelId = null;
    this.queue = Promise.resolve();
    this.pending = 0; // jobs enqueued and unanswered — the backpressure signal other heimdalls read
    this.onProgress = onProgress || (() => {});
  }

  get loaded() {
    return !!this.engine;
  }

  /** The context window the loaded model runs at, from WebLLM's own config. */
  get contextWindow() {
    const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === this.modelId);
    return rec?.overrides?.context_window_size ?? null;
  }

  /** Download (first time) and start the model. Resolves the build this GPU
   *  can run; a second call while the first is downloading joins it. */
  load(modelId) {
    if (this.loading?.want === modelId) return this.loading.p;
    const p = this._load(modelId).finally(() => { if (this.loading?.p === p) this.loading = null; });
    this.loading = { want: modelId, p };
    return p;
  }

  async _load(wanted) {
    const modelId = await runnableVariant(wanted);
    if (this.engine && this.modelId === modelId) return;
    if (this.engine) {
      // switching models: free the old weights before loading the new ones
      const old = this.engine;
      this.engine = null;
      this.modelId = null;
      await old.unload?.().catch(() => {});
    }
    const known = new Set(MODEL_CHOICES.flatMap((m) => [m.id, f32Variant(m.id)]));
    const list = prebuiltAppConfig.model_list.filter((m) => known.has(m.model_id));
    this.engine = await CreateMLCEngine(modelId, {
      initProgressCallback: (p) => this.onProgress(p),
      appConfig: { ...prebuiltAppConfig, model_list: list },
    });
    this.modelId = modelId;
  }

  infer(messages, opts = {}, onToken) {
    const run = () => this._run(messages, opts, onToken);
    this.pending++;
    const task = this.queue.then(run);
    task.then(
      () => { this.pending = Math.max(0, this.pending - 1); },
      () => { this.pending = Math.max(0, this.pending - 1); },
    );
    this.queue = task.then(() => {}, () => {});
    return task;
  }

  async _run(messages, { stream = true, temperature = 0.7, max_tokens = 1024 }, onToken) {
    if (!this.engine) throw new Error("model not loaded");
    const opts = { messages, temperature, max_tokens, stream };
    if (stream) {
      const chunks = await this.engine.chat.completions.create(opts);
      let text = "";
      for await (const chunk of chunks) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          onToken?.(delta);
        }
      }
      return { text };
    }
    const reply = await this.engine.chat.completions.create(opts);
    return {
      text: reply.choices?.[0]?.message?.content ?? "",
      usage: reply.usage,
    };
  }
}

export function gpuLabel() {
  const nav = navigator;
  if (!("gpu" in nav)) return "no WebGPU";
  try {
    const adapter = nav.gpu.requestAdapter ? "adapter" : "no adapter";
    return adapter;
  } catch {
    return "no WebGPU";
  }
}

export function webgpuAvailable() {
  return "gpu" in navigator;
}
/**
 * The computer's own Ollama, lent to the fleet through the local bridge
 * (bin/heimdall.mjs up). Same surface as WorkerEngine, so the router treats
 * it as one more giver: a phone that borrows gets the computer's GPU.
 * Only exists on a page the bridge serves (same origin, no CORS).
 */
export class OllamaEngine {
  constructor() {
    this.modelId = null;
    this.pending = 0;
    this.engine = null;
  }

  get loaded() {
    return !!this.modelId;
  }

  get contextWindow() {
    return null;
  }

  async load(tag) {
    const r = await fetch("bridge/upstream/tags");
    if (!r.ok) throw new Error(`the computer's Ollama did not answer (${r.status})`);
    const names = ((await r.json()).models ?? []).map((m) => m.name);
    if (!names.includes(tag)) throw new Error(`${tag} is not installed in the computer's Ollama (has: ${names.join(", ") || "nothing"})`);
    this.modelId = tag;
    this.engine = "ollama";
  }

  async infer(messages, { temperature = 0.7, max_tokens = 1024 } = {}, onToken) {
    this.pending++;
    try {
      const r = await fetch("bridge/upstream/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.modelId, messages, stream: true, options: { temperature, num_predict: max_tokens } }),
      });
      if (!r.ok || !r.body) throw new Error(`ollama ${r.status}: ${await r.text().catch(() => "")}`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          const d = j.message?.content;
          if (d) {
            text += d;
            onToken?.(d);
          }
        }
      }
      return { text };
    } finally {
      this.pending = Math.max(0, this.pending - 1);
    }
  }
}

/**
 * The CPU path: a small model through transformers.js on WebAssembly, for a
 * browser that exposes no usable GPU (Brave on Android, a blocklisted GPU).
 * Slower than WebLLM, but it runs anywhere. Same surface as WorkerEngine.
 */
export const WASM_MODEL = { id: "Qwen2.5-0.5B-Instruct-onnx-q4", repo: "onnx-community/Qwen2.5-0.5B-Instruct" };

export class WasmEngine {
  constructor(onProgress) {
    this.onProgress = onProgress || (() => {});
    this.worker = null;
    this.modelId = null;
    this.pending = 0;
    this.queue = Promise.resolve();
    this.cpu = true;
    this.waiting = new Map(); // id -> { resolve, reject, onToken }
    this.seq = 0;
  }

  get loaded() {
    return !!this.modelId;
  }

  get contextWindow() {
    return null;
  }

  _ensureWorker() {
    if (this.worker) return;
    // Its own thread: a generation blocks only the worker, never the page.
    this.worker = new Worker(new URL("./llm-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data.type === "progress") return this.onProgress({ progress: data.progress });
      const w = this.waiting.get(data.id);
      if (!w) return;
      if (data.type === "token") return w.onToken?.(data.t);
      this.waiting.delete(data.id);
      if (data.type === "error") w.reject(new Error(data.message));
      else w.resolve(data);
    };
    this.worker.onerror = (e) => {
      for (const w of this.waiting.values()) w.reject(new Error(e.message || "model worker crashed"));
      this.waiting.clear();
    };
  }

  _call(type, payload, onToken) {
    this._ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onToken });
      this.worker.postMessage({ id, type, payload });
    });
  }

  async load() {
    if (this.modelId) return;
    await this._call("load", { repo: WASM_MODEL.repo });
    this.modelId = WASM_MODEL.id;
    this.onProgress({ progress: 1 });
  }

  infer(messages, opts = {}, onToken) {
    this.pending++;
    const run = async () => {
      const r = await this._call("infer", { messages, temperature: opts.temperature ?? 0.7, max_tokens: opts.max_tokens ?? 512 }, onToken);
      return { text: r.text };
    };
    const task = this.queue.then(run);
    const done = () => { this.pending = Math.max(0, this.pending - 1); };
    task.then(done, done);
    this.queue = task.then(() => {}, () => {});
    return task;
  }
}
