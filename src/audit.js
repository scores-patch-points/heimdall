// audit.js — the outbound ledger: exactly what left this machine, byte for byte.
//
// Heimdall is the one door every outside-model request passes through, so it is
// the place that can say, with no reliance on what a surface claims, WHAT WAS
// SENT: the exact request body, the host it went to, and a SHA-256 of both the
// wire bytes and the canonical message content. A surface that built a sealed
// request can then check, from its own copy, that the bytes that actually left
// are the bytes it meant to send — and a person can read them.
//
// What the ledger records for each outbound request:
//   · who asked      — the surface's audit id (x-fold-audit), the route, the caller
//   · where it went  — provider, host, path (no query string, no credentials)
//   · what was sent  — the exact body, its byte length, sha256(wire), sha256(content)
//   · its place in a world set — setId + slot, when the request is one of several
//     "possible worlds" sent together (x-fold-worlds: "<setId>:<slot>/<n>"). The
//     REAL index is never sent here and never known here: a ledger that knew it
//     would be a leak of its own.
//   · what came back — status, bytes, ms, or the error
// Credentials never enter an entry: header VALUES for authorization, x-api-key and
// the like are replaced by "[redacted]"; only the header NAMES are kept.
//
// Pure of the network and the clock: createLedger({ file, max, now }) is testable
// in node. The bridge feeds it; nothing here sends anything.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const sha256 = (s) => createHash("sha256").update(typeof s === "string" ? s : Buffer.from(s)).digest("hex");

/** The canonical text of a message list — the SAME formula the surface uses, so the two hashes can be compared. */
export function canonMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m) => `${String(m?.role ?? "")}\n${typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")}`).join("\n\u0000\n");
}
export const contentSha256 = (messages) => sha256(canonMessages(messages));

const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie|x-auth-token)$/i;

/** Header names kept, secret values redacted. */
export function redactHeaders(headers) {
  const out = {};
  const entries = headers && typeof headers.entries === "function" && !Array.isArray(headers) ? [...headers.entries()] : Object.entries(headers || {});
  for (const [k, v] of entries) out[String(k).toLowerCase()] = SECRET_HEADER.test(k) ? "[redacted]" : String(v).slice(0, 200);
  return out;
}

/** "<setId>:<slot>/<n>" → { setId, slot, n } or null. */
export function parseWorlds(h) {
  const m = String(h ?? "").match(/^([\w.-]{1,64}):(\d{1,3})\/(\d{1,3})$/);
  if (!m) return null;
  const slot = +m[2], n = +m[3];
  return slot >= 0 && slot < n && n >= 1 ? { setId: m[1], slot, n } : null;
}

/** The host and path of a URL — never the query string, never userinfo. */
export function whereOf(url) {
  try { const u = new URL(url); return { host: u.host, path: u.pathname, scheme: u.protocol.replace(":", "") }; }
  catch { return { host: null, path: null, scheme: null }; }
}

/** The text a request body carries, for the ledger: parsed messages when it is a chat body. */
export function bodyMessages(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    if (Array.isArray(j?.messages)) return j.messages;
    if (typeof j?.prompt === "string") return [{ role: "user", content: j.prompt }];
  } catch {}
  return null;
}

export function createLedger({ file = null, max = 500, now = () => new Date().toISOString(), maxBodyBytes = 262144 } = {}) {
  const entries = [];
  let seq = 0;

  const persist = (e) => {
    if (!file) return;
    try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(e) + "\n"); } catch { /* the ledger never blocks a request */ }
  };

  return {
    /** Open an entry BEFORE the request leaves; returns a handle to close it when the answer (or failure) is known. */
    open({ url, method = "POST", headers = {}, body = "", provider = null, model = null, privacy = null, auditId = null, worlds = null, route = null, caller = null, executor = null }) {
      const text = typeof body === "string" ? body : Buffer.from(body ?? "").toString("utf8");
      const msgs = bodyMessages(text);
      const e = {
        seq: ++seq, id: "out_" + seq.toString(36) + "_" + Math.random().toString(36).slice(2, 7),
        at: now(), auditId, route, caller, provider, executor, model, privacy,
        ...whereOf(url), method,
        request: {
          headerNames: Object.keys(redactHeaders(headers)), headers: redactHeaders(headers),
          bytes: Buffer.byteLength(text), sha256: sha256(text),
          contentSha256: msgs ? contentSha256(msgs) : null,
          messageCount: msgs ? msgs.length : null,
          body: Buffer.byteLength(text) <= maxBodyBytes ? text : text.slice(0, maxBodyBytes),
          truncated: Buffer.byteLength(text) > maxBodyBytes,
        },
        worlds: worlds ? { setId: worlds.setId, slot: worlds.slot, n: worlds.n } : null,
        response: null,
      };
      entries.push(e);
      if (entries.length > max) entries.splice(0, entries.length - max);
      const t0 = Date.now();
      return {
        entry: e,
        close({ status = null, bytes = null, error = null } = {}) {
          e.response = { status, bytes, ms: Date.now() - t0, error: error ? String(error).slice(0, 300) : null };
          persist(e);
          return e;
        },
        /** The exact token usage the provider reported — known only when the stream ends. Appended as an update line. */
        annotate({ usage = null } = {}) {
          if (!e.response) e.response = { status: null, bytes: null, ms: Date.now() - t0, error: null };
          e.response.usage = usage;
          if (file) { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify({ update: e.id, usage }) + "\n"); } catch {} }
          return e;
        },
      };
    },
    list({ since = 0, limit = 100 } = {}) {
      const out = entries.filter((e) => e.seq > since).slice(0, Math.max(1, Math.min(500, limit)));
      return { entries: out, next: out.length ? out[out.length - 1].seq : since, total: entries.length };
    },
    byAuditId(id) { return entries.filter((e) => e.auditId && e.auditId === id); },
    bySet(setId) { return entries.filter((e) => e.worlds?.setId === setId); },
    get size() { return entries.length; },
    /** Distinct outside hosts and the bytes sent to each — the one-line disclosure. */
    summary() {
      const hosts = new Map();
      for (const e of entries) { const h = hosts.get(e.host) || { host: e.host, requests: 0, bytes: 0 }; h.requests++; h.bytes += e.request.bytes; hosts.set(e.host, h); }
      return { requests: entries.length, hosts: [...hosts.values()] };
    },
  };
}
