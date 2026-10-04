// llm-worker.js — the CPU model off the main thread. transformers.js on wasm
// runs a whole generation synchronously; on the page's own thread that froze
// pings, the relay's token flushes and Matrix sync for the entire answer, and
// the host dropped the phone mid-job. Here it blocks only this worker.
import { pipeline, TextStreamer } from "@huggingface/transformers";

let gen = null;

self.onmessage = async ({ data }) => {
  const { id, type, payload } = data;
  try {
    if (type === "load") {
      const files = new Map();
      gen = await pipeline("text-generation", payload.repo, {
        dtype: "q4",
        device: "wasm",
        progress_callback: (p) => {
          if (p.status !== "progress" || !p.total) return;
          files.set(p.file, [p.loaded, p.total]);
          let got = 0;
          let all = 0;
          for (const [l, t] of files.values()) { got += l; all += t; }
          self.postMessage({ type: "progress", progress: all ? got / all : 0 });
        },
      });
      self.postMessage({ type: "loaded", id });
    } else if (type === "infer") {
      let text = "";
      const streamer = new TextStreamer(gen.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (t) => {
          if (!t) return;
          text += t;
          self.postMessage({ type: "token", id, t });
        },
      });
      const { messages, temperature = 0.7, max_tokens = 512 } = payload;
      await gen(messages, { max_new_tokens: max_tokens, temperature, do_sample: temperature > 0, streamer });
      self.postMessage({ type: "result", id, text });
    }
  } catch (e) {
    self.postMessage({ type: "error", id, message: String(e?.message || e) });
  }
};
