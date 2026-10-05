// websearch.js — keyless web search and page reading from THIS machine.
//
// Why this exists. The Fold's page used to search the web through a Cloudflare relay that reads
// DuckDuckGo and Brave *through Google Translate's page proxy*; the relay's own notes say it succeeds
// about 58% of the time ("expect gaps"), and when it fails the chat falls back to Wikipedia and reads
// the wrong pages (measured 2026-10-05: "a good recipe for banana bread" read "Peanut butter, banana and
// bacon sandwich"). Heimdall already runs on the person's own computer, whose address search engines
// do not treat as a datacentre bot. Measured from this machine (n = 6 queries, one address): Brave
// answered 6/6 with a results page, DuckDuckGo's HTML endpoint 2/6 (a bot check on the rest).
//
// What leaves, and to whom: the QUERY goes to the engine's own site from this machine's address —
// there is no third party in the middle (no relay, no translate proxy). A page read fetches that page
// from this machine's address. Nothing else is sent; no cookies, no identity.
//
// Politeness (it is the person's own address): a minimum gap between requests to one engine, a short
// result cache, and a cool-down after an engine shows a bot check — a retry storm is exactly what got
// the relay throttled.
//
// SAFETY of the page reader: it fetches only http(s) URLs whose host resolves to a PUBLIC address
// (loopback, private, link-local, CGNAT, multicast and unique-local ranges are refused, re-checked on
// every redirect), caps the body, time-boxes the request, and the bridge only answers it for the Fold's
// own page origins. It is a reader for the web, not a window onto this machine's network.

import dns from "node:dns/promises";
import net from "node:net";

export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const LIMITS = Object.freeze({
  minGapMs: 1200,        // between requests to ONE engine
  cacheMs: 90_000,       // identical query reuse
  coolDownMs: 60_000,    // after a bot check / 429
  pageBytes: 600_000,    // body cap for a page read
  pageTimeoutMs: 10_000,
  searchTimeoutMs: 12_000,
  maxRedirects: 4,
});

// ── text helpers ────────────────────────────────────────────────────────────

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
export const textOf = (html) => decodeEntities(String(html ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
export function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }

// ── parsers (direct pages, not the translate-proxied ones) ──────────────────

/** Brave's results page, fetched directly: each organic result is a `data-type="web"` block whose
 *  first `l1` link carries the real URL. */
export function parseBrave(html) {
  const out = [], seen = new Set();
  for (const block of String(html).split('data-type="web"').slice(1)) {
    const a = block.match(/<a href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bl1\b/);
    if (!a) continue;
    const url = decodeEntities(a[1]);
    if (seen.has(url) || /^https?:\/\/(?:[\w-]+\.)*(?:brave\.com)\//i.test(url)) continue;
    seen.add(url);
    const title = block.match(/class="title[^"]*"[^>]*\btitle="([^"]*)"/);
    const site = block.match(/class="[^"]*desktop-small-semibold[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    const snippet = block.match(/class="content [^"]*"[^>]*>([\s\S]*?)<\/div>/) || block.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    out.push({
      title: title ? decodeEntities(title[1]).trim() : hostOf(url),
      url,
      snippet: snippet ? textOf(snippet[1]) : "",
      source: (site && textOf(site[1])) || hostOf(url),
    });
  }
  return out;
}
export const braveHasResults = (html) => String(html).includes('data-type="web"');

function ddgTarget(href) {
  const m = decodeEntities(href).match(/uddg(?:%3D|=)([\s\S]+?)(?:%26rut%3D|&rut=|$)/i);
  if (!m) return /^https?:\/\//i.test(decodeEntities(href)) ? decodeEntities(href) : null;
  let t = m[1];
  const rounds = /^https?:/i.test(t) ? 2 : 1;
  for (let i = 0; i < rounds; i++) { try { t = decodeURIComponent(t); } catch { break; } }
  return /^https?:\/\//i.test(t) ? t : null;
}
const DDG_AD = /^https?:\/\/(?:[\w-]+\.)*duckduckgo\.com\/y\.js|^https?:\/\/(?:www\.)?bing\.com\/aclick/i;
/** DuckDuckGo's HTML endpoint. Sponsored results are recognised by class and by target. */
export function parseDdg(html) {
  const out = [];
  for (const block of String(html).split('<div class="result results_links').slice(1)) {
    if (/^[^>]*\bresult--ad\b/.test(block)) continue;
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = ddgTarget(a[1]);
    if (!url || DDG_AD.test(url)) continue;
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ title: textOf(a[2]), url, snippet: sn ? textOf(sn[1]) : "", source: hostOf(url) });
  }
  return out;
}
export const ddgBotCheck = (html) => /anomaly|bots use DuckDuckGo too|captcha/i.test(String(html));
export const ddgSaysNoResults = (html) => /class="no-results"|>\s*No results\.?\s*</i.test(String(html));

// ── engines ─────────────────────────────────────────────────────────────────

const ENGINES = {
  brave: {
    name: "Brave Search",
    url: (q) => "https://search.brave.com/search?" + new URLSearchParams({ q, source: "web" }),
    parse: (html) => (braveHasResults(html) ? parseBrave(html) : /No results found/i.test(html) ? [] : null),
  },
  ddg: {
    name: "DuckDuckGo",
    url: (q) => "https://html.duckduckgo.com/html/?" + new URLSearchParams({ q }),
    parse: (html) => { if (ddgBotCheck(html)) return null; const r = parseDdg(html); return r.length || ddgSaysNoResults(html) ? r : null; },
  },
};

/** Per-process politeness state: when each engine was last asked and when its cool-down ends. */
export function makeSearcher({ fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limits = LIMITS } = {}) {
  const last = new Map(), cool = new Map(), cache = new Map(), chain = new Map();
  const stats = { queries: 0, cacheHits: 0, byEngine: { brave: { ok: 0, failed: 0 }, ddg: { ok: 0, failed: 0 } } };

  async function askOnce(id, q) {
    const eng = ENGINES[id];
    // serialise per engine and keep the minimum gap, so a burst of turns cannot hammer one engine
    const prev = chain.get(id) || Promise.resolve();
    const run = prev.then(async () => {
      const wait = (last.get(id) ?? -Infinity) + limits.minGapMs - now();
      if (wait > 0) await sleep(wait);
      last.set(id, now());
      let res;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), limits.searchTimeoutMs);
        try { res = await fetchImpl(eng.url(q), { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml" }, signal: ctl.signal, redirect: "follow" }); }
        finally { clearTimeout(timer); }
      } catch (e) { return { why: eng.name + (e && e.name === "AbortError" ? " timed out" : " could not be reached") }; }
      if (res.status === 429 || res.status >= 500) { cool.set(id, now() + limits.coolDownMs); return { why: eng.name + " answered " + res.status }; }
      if (!res.ok) return { why: eng.name + " answered " + res.status };
      const html = await res.text();
      const results = eng.parse(html);
      if (results) return { results };
      if (ddgBotCheck(html)) cool.set(id, now() + limits.coolDownMs);
      return { why: ddgBotCheck(html) ? eng.name + " showed its bot check" : eng.name + " did not return a results page" };
    });
    chain.set(id, run.catch(() => {}));
    return run;
  }

  /** Brave first (it answered every query in the 2026-10-05 measurement), DuckDuckGo as the fallback.
   *  Returns { engine, results, tried } or { error, tried } — `tried` names every engine and why it
   *  failed, so a gap is a typed fact, not a silence. */
  async function search(q, { engines = ["brave", "ddg"] } = {}) {
    const query = String(q ?? "").trim();
    if (!query) return { error: "empty query", tried: [] };
    const hit = cache.get(query.toLowerCase());
    if (hit && now() - hit.at < limits.cacheMs) { stats.cacheHits++; return { ...hit.value, cached: true }; }
    stats.queries++;
    const tried = [];
    for (const id of engines) {
      if (!ENGINES[id]) continue;
      if ((cool.get(id) || 0) > now()) { tried.push({ engine: ENGINES[id].name, why: "cooling down after a refusal" }); continue; }
      const got = await askOnce(id, query);
      if (got.results) {
        stats.byEngine[id].ok++;
        const value = { engine: ENGINES[id].name, results: got.results, tried };
        if (got.results.length) cache.set(query.toLowerCase(), { at: now(), value });
        return value;
      }
      stats.byEngine[id].failed++;
      tried.push({ engine: ENGINES[id].name, why: got.why });
    }
    return { error: "no engine answered", tried };
  }
  return { search, stats, _state: { last, cool, cache } };
}

// ── page reader ─────────────────────────────────────────────────────────────

/** Is this address one we must never fetch on a stranger's behalf? */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return isPrivateAddress(x.slice(7));
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true; // not an address we can reason about → refuse
}

/** Validate a URL for a page read: http(s) only, no credentials, host resolves only to public addresses. */
export async function assertPublicUrl(raw, { lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error("not a URL"), { code: "bad-url" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("only http(s) pages are read"), { code: "bad-scheme" });
  if (u.username || u.password) throw Object.assign(new Error("URLs with credentials are refused"), { code: "credentials" });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(?:local|localhost|internal|lan|home|corp)$/i.test(host)) throw Object.assign(new Error("local hosts are refused"), { code: "local-host" });
  if (net.isIP(host)) { if (isPrivateAddress(host)) throw Object.assign(new Error("private addresses are refused"), { code: "private-address" }); return u; }
  let addrs;
  try { addrs = await lookup(host); } catch { throw Object.assign(new Error("host did not resolve"), { code: "no-dns" }); }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw Object.assign(new Error("host resolves to a private address"), { code: "private-address" });
  return u;
}

/** Fetch one page as text/HTML from this machine: public hosts only (re-checked per redirect), capped, time-boxed.
 *  Returns { ok, status, url, finalUrl, contentType, text, truncated } or { ok:false, error, code }. */
export async function fetchPage(raw, { fetchImpl = fetch, lookup, limits = LIMITS } = {}) {
  let url = raw;
  try {
    for (let hop = 0; hop <= limits.maxRedirects; hop++) {
      const u = await assertPublicUrl(url, lookup ? { lookup } : {});
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), limits.pageTimeoutMs);
      let res;
      try { res = await fetchImpl(u.href, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.5" }, signal: ctl.signal, redirect: "manual" }); }
      finally { clearTimeout(timer); }
      if (res.status >= 300 && res.status < 400 && res.headers?.get?.("location")) { url = new URL(res.headers.get("location"), u).href; continue; }
      const contentType = (res.headers?.get?.("content-type") || "").toLowerCase();
      if (!res.ok) return { ok: false, status: res.status, error: "HTTP " + res.status, code: "http" };
      if (contentType && !/(text\/|xhtml|json|xml)/.test(contentType)) return { ok: false, status: res.status, error: "not a text page (" + contentType + ")", code: "not-text" };
      let text = "", truncated = false;
      if (res.body?.getReader) {
        const reader = res.body.getReader(); const dec = new TextDecoder(); let len = 0;
        for (;;) { const { value, done } = await reader.read(); if (done) break; const part = dec.decode(value, { stream: true }); text += part; len += value.length; if (len > limits.pageBytes) { truncated = true; try { await reader.cancel(); } catch {} break; } }
      } else { text = await res.text(); if (text.length > limits.pageBytes) { text = text.slice(0, limits.pageBytes); truncated = true; } }
      return { ok: true, status: res.status, url: raw, finalUrl: u.href, contentType, text, truncated };
    }
    return { ok: false, error: "too many redirects", code: "redirects" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), code: e?.code || (e?.name === "AbortError" ? "timeout" : "error") };
  }
}
