// floor.js — which thing is on the floor (rung 4)? Pure helpers; the caller injects fetch.
//
// Measured 2026-10-05: 11434 is khora's channel proxy (it answers with an
// `x-heimdall-channel` header and keys its single queue per server), NOT Ollama.
// The real Ollama is on 11435. A bridge whose only floor is the channel has a
// floor that can queue, refuse (429/508) or hang; the operator must be told.

/** An OLLAMA_HOST-style value, made a base URL. Accepts ":11435", "11435",
 *  "0.0.0.0:11435", "host:port", "host", and full URLs. null when empty. */
export function normalizeOllamaHost(value, { defaultPort = 11434 } = {}) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, "");
  if (/^\d+$/.test(s)) s = `127.0.0.1:${s}`;
  else if (s.startsWith(":")) s = `127.0.0.1${s}`;
  const m = s.match(/^(\[[^\]]*\]|[^:/]+)(?::(\d+))?/);
  if (!m) return null;
  let host = m[1];
  const port = m[2] || String(defaultPort);
  if (host === "0.0.0.0" || host === "[::]" || host === "::") host = "127.0.0.1";
  return `http://${host}:${port}`;
}

const headerOf = (r, name) => { try { return r?.headers?.get?.(name) ?? null; } catch { return null; } };

/** Probe the floor candidates. `primary` is the configured upstream (default
 *  :11434), `direct` the real Ollama beside it (:11435). Returns
 *  { primaryUp, primaryIsChannel, directUp, upstreams (ordered, reachable only), warnings }. */
export async function probeFloor({ primary, direct = null, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const look = async (base) => {
    try {
      const r = await fetchImpl(base.replace(/\/+$/, "") + "/api/version", { signal: AbortSignal.timeout(timeoutMs) });
      return { up: true, channel: !!headerOf(r, "x-heimdall-channel") };
    } catch { return { up: false, channel: false }; }
  };
  const p = primary ? await look(primary) : { up: false, channel: false };
  const d = direct && direct !== primary ? await look(direct) : { up: false, channel: false };
  // Every CONFIGURED floor stays on the step-down list. The probe only informs the warnings below: a floor that was busy for one 2s
  // look at boot (measured 2026-10-05: the channel, mid-eval) must not lose its fallback for the life of the process. The request
  // decides — a refused or hung floor steps down in milliseconds, and the breaker remembers it.
  const upstreams = [];
  if (primary) upstreams.push(primary);
  if (direct && direct !== primary) upstreams.push(direct);
  const warnings = [];
  if (p.up && p.channel && !d.up) warnings.push(`the channel at ${primary} (x-heimdall-channel) is the only floor — it queues one request at a time and can refuse; no direct Ollama answered at ${direct ?? "(none configured)"}`);
  if (!p.up && !d.up) warnings.push(`no floor answered (${[primary, direct].filter(Boolean).join(", ")}) — pass-through will fail`);
  return { primaryUp: p.up, primaryIsChannel: p.channel, directUp: d.up, upstreams, warnings };
}
