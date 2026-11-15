// connectors/http.mjs: pull anything with a URL into the substrate as a `pulled` mark (INS·Figure).
// The mark carries WHERE and WHAT BYTES (url, status, content type, sha256, etag, last-modified) in its
// witness and body, so the pull can be re-checked; the fetch time is witness, never the entry's own time.
// JSON stays JSON; anything else goes in as base64 up to `maxBytes` (larger bodies belong in the block
// store, which this v0 does not wire). `seal` (optional) turns the body into ciphertext before it is marked,
// for anything about a subject.
import crypto from 'node:crypto';

export const PULLED = { kind: 'pulled', cell: 'INS·Figure', why: 'bytes pulled from an outside source, with where they came from and their sha256' };

export async function pull(url, { headers = {}, maxBytes = 2_000_000, seal = null, label } = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'heimdall-connector', ...headers } });
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`http: ${bytes.length} bytes is over ${maxBytes}; use the block store`);
  const type = r.headers.get('content-type') || '';
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let value;
  if (/json/.test(type)) { try { value = JSON.parse(bytes.toString('utf8')); } catch { value = { base64: bytes.toString('base64') }; } }
  else value = /^text\//.test(type) ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') };
  const src = { url, status: r.status, type, sha256, etag: r.headers.get('etag'), lastModified: r.headers.get('last-modified'), fetchedAt: new Date().toISOString() };
  const body = { source: { url, sha256, status: r.status, type }, value: seal ? await seal(value) : value, sealed: !!seal };
  return {
    kind: PULLED.kind, cell: PULLED.cell, addr: label ? `pulled:${label}` : `pulled:${sha256.slice(0, 32)}`, body, of: [],
    witness: { how: `GET ${url} -> ${r.status}, ${bytes.length} bytes, sha256 ${sha256}`, ...src }, declare: { why: PULLED.why },
  };
}
