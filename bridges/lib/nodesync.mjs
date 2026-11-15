// nodesync.mjs: two pharos nodes of the SAME person (phone and laptop) approach each other by union.
//
// Who may merge: only another device of the same Matrix user, cross-signed by that user's self-signing
// key, proving itself by signing each request with its Matrix device key. A care-team member never
// merges; they read through /v1/records and the subject's device decides there.
// What merges: every entry of one node's log, verbatim (pharos merge via Penelope's merge route), in
// both directions. Nothing is resolved: a disagreement stays as both and the fold reports it.
// What is measured: the gap between the two nodes before and after, woven as gap-measured entries.
//   GET  /v1/node/entries   the server node's entries, with a response signed by its device
//   POST /v1/node/merge     the client node's entries, for the server node to merge
import { markOf } from './codec.mjs';
import { canonicalJson } from './matrix.mjs';

const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
export async function sha256hex(text) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const SKEW_MS = 120_000;

// ---------- client ----------
export async function signedHeaders(mx, method, path, bodyText) {
  const p = { user: mx.userId, device: mx.deviceId, ts: Date.now(), nonce: globalThis.crypto.randomUUID(), method, path, body: await sha256hex(bodyText) };
  const { payload, sigs } = await mx.signPayload(p);
  return { nonce: p.nonce, headers: { 'x-heimdall-request': b64u(payload), 'x-heimdall-signature': b64u(sigs) } };
}

// Entries that record an exchange itself. Every exchange writes some (Penelope's `merged`, the
// `gap-measured` entries), so two nodes that exchange never become identical: they converge on everything
// else and stay one exchange-record apart. The split is reported, never hidden. This set is a declared
// choice (part of this measure's ground), not a fact about the nodes.
export const EXCHANGE_RECORDS = new Set(['merged', 'gap-measured']);

export function gapBetween(aEntries, bEntries) {
  const a = new Map(aEntries.map((e) => [e.id, e])), b = new Map(bEntries.map((e) => [e.id, e]));
  const onlyA = [...a.values()].filter((e) => !b.has(e.id)), onlyB = [...b.values()].filter((e) => !a.has(e.id));
  const byKind = (es) => es.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {});
  const content = (es) => es.filter((e) => !EXCHANGE_RECORDS.has(e.kind)).length;
  return {
    held: { a: a.size, b: b.size, both: a.size - onlyA.length },
    onlyACount: onlyA.length, onlyBCount: onlyB.length, onlyAByKind: byKind(onlyA), onlyBByKind: byKind(onlyB),
    contentGap: content(onlyA) + content(onlyB), exchangeRecordsApart: onlyA.length + onlyB.length - content(onlyA) - content(onlyB),
    noDifferenceFound: !onlyA.length && !onlyB.length,
  };
}

// The gap to another of this person's nodes, without merging or writing anything (the watch's probe).
export async function peerGap({ mx, store, url }) {
  const base = url.replace(/\/$/, '');
  const { nonce, headers } = await signedHeaders(mx, 'GET', '/v1/node/entries', '');
  const r = await fetch(base + '/v1/node/entries', { headers });
  const j = await r.json();
  if (!j.ok) return { reachable: false, reason: j.reason };
  const proof = JSON.parse(j.proof.payload);
  if (proof.nonce !== nonce || proof.body !== await sha256hex(canonicalJson(j.entries))) return { reachable: false, reason: 'bad_response_proof' };
  const chk = await mx.ownDeviceCheck(proof.user, proof.device, j.proof.payload, j.proof.sigs);
  if (!chk.ok) return { reachable: false, reason: chk.reason };
  return { reachable: true, ...gapBetween(await store.all(), j.entries) };
}

// Pull the other node's entries, merge them here; push ours, the other node merges them. Measure before and after.
export async function syncWithNode({ mx, store, url, here, there }) {
  const base = url.replace(/\/$/, '');
  const pull = async () => {
    const { nonce, headers } = await signedHeaders(mx, 'GET', '/v1/node/entries', '');
    const r = await fetch(base + '/v1/node/entries', { headers });
    const j = await r.json();
    if (!j.ok) throw Object.assign(new Error(`pull refused: ${j.reason}`), { reason: j.reason, status: r.status });
    const proof = JSON.parse(j.proof.payload);
    if (proof.nonce !== nonce) throw new Error('response is not for this request');
    if (proof.body !== await sha256hex(canonicalJson(j.entries))) throw new Error('response body does not match its signature');
    const chk = await mx.ownDeviceCheck(proof.user, proof.device, j.proof.payload, j.proof.sigs);
    if (!chk.ok) throw new Error(`response not from an own cross-signed device: ${chk.reason}`);
    return { entries: j.entries, device: proof.device };
  };
  const t0 = await pull();
  const before = gapBetween(await store.all(), t0.entries);
  const gapMark = (label, gap) => markOf('gap-measured', `gap:node:${there}`, { between: [here, there], when: label, ...gap }, { witness: `entry ids of this node against ${there} (device ${t0.device}), signed response verified` });
  await store.append(gapMark('before', before));

  const pulled = await store.merge({ from: there, entries: t0.entries, witness: `pulled from own device ${t0.device} of ${mx.userId}; device cross-signed by the owner and response signature verified` });
  if (!pulled.ok) throw new Error(`merge here refused: ${pulled.reason} ${pulled.detail ?? ''}`);

  const body = canonicalJson({ from: here, entries: await store.all() });
  const { headers } = await signedHeaders(mx, 'POST', '/v1/node/merge', body);
  const pr = await fetch(base + '/v1/node/merge', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
  const pushed = await pr.json();
  if (!pushed.ok) throw Object.assign(new Error(`push refused: ${pushed.reason}`), { reason: pushed.reason });

  const t1 = await pull();
  const after = gapBetween(await store.all(), t1.entries);
  await store.append(gapMark('after', after));
  return { before, after, pulled: { added: pulled.added, refused: pulled.refused.length }, pushed: { added: pushed.added, refused: pushed.refused?.length ?? 0 } };
}

// ---------- server ----------
// Check a device-signed request. own: only another device of this same user, cross-signed by the owner.
// Otherwise: any user's device whose published key verifies the signature (membership is checked by the caller).
export function signedRequestChecker(mx, { own }) {
  const seen = new Map();   // nonce -> ts, so a request cannot be replayed within the skew window
  return async function check(req, method, path, bodyText) {
    let payload, sigs;
    try { payload = unb64u(req.headers['x-heimdall-request'] || ''); sigs = unb64u(req.headers['x-heimdall-signature'] || ''); } catch { return { ok: false, status: 401, reason: 'no_device_signature' }; }
    let p; try { p = JSON.parse(payload); } catch { return { ok: false, status: 401, reason: 'no_device_signature' }; }
    if (p.method !== method || p.path !== path) return { ok: false, status: 401, reason: 'wrong_route' };
    if (Math.abs(Date.now() - p.ts) > SKEW_MS) return { ok: false, status: 401, reason: 'stale' };
    for (const [n, t] of seen) if (Date.now() - t > SKEW_MS) seen.delete(n);
    if (seen.has(p.nonce)) return { ok: false, status: 401, reason: 'replayed' };
    if (p.body !== await sha256hex(bodyText)) return { ok: false, status: 401, reason: 'body_mismatch' };
    if (own && p.user !== mx.userId) return { ok: false, status: 403, reason: 'not_own_user' };
    if (p.user === mx.userId && p.device === mx.deviceId) return { ok: false, status: 400, reason: 'same_device' };
    const c = own ? await mx.ownDeviceCheck(p.user, p.device, payload, sigs) : await mx.deviceCheck(p.user, p.device, payload, sigs);
    if (!c.ok) return { ok: false, status: 403, reason: c.reason };
    seen.set(p.nonce, Date.now());
    return { ok: true, p };
  };
}

export function nodeHandler({ mx, store, here }) {
  const check = signedRequestChecker(mx, { own: true });
  return {
    async entries(req) {
      const c = await check(req, 'GET', '/v1/node/entries', '');
      if (!c.ok) return c;
      const entries = await store.all();
      const proof = await mx.signPayload({ user: mx.userId, device: mx.deviceId, nonce: c.p.nonce, body: await sha256hex(canonicalJson(entries)) });
      return { ok: true, node: here, entries, proof };
    },
    async merge(req, bodyText) {
      const c = await check(req, 'POST', '/v1/node/merge', bodyText);
      if (!c.ok) return c;
      const { from, entries } = JSON.parse(bodyText);
      if (typeof from !== 'string' || !/^[A-Za-z0-9._-]+$/.test(from)) return { ok: false, status: 400, reason: 'no_from' };
      const r = await store.merge({ from, entries, witness: `pushed by own device ${c.p.device} of ${mx.userId}; device cross-signed by the owner and request signature verified` });
      return { ...r, status: r.ok ? 200 : r.status };
    },
  };
}
