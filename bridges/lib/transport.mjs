// transport.mjs: how a payload crosses from one node to another over Matrix. Nothing is stored in a room.
//
//   rung 1  to-device   the payload, gzipped, inside ONE Olm-encrypted to-device message. If the other
//                       device is online it arrives at once; if not, the homeserver queues it and deletes
//                       it on delivery. For payloads under TO_DEVICE_BUDGET.
//   rung 2  media       for anything larger: gzip, cut into shards, encrypt each shard with Matrix's own
//                       encrypted-attachment scheme, upload the ciphertext to the media store, and send the
//                       manifest (addresses and keys) as a to-device message. The other device fetches the
//                       shards whenever it is next online, checks each hash, decrypts, joins, gunzips.
//
// Order: gzip FIRST (ciphertext does not compress), then shard, then encrypt each shard, so every shard is
// verifiable and retriable on its own. Sharding is for the server's upload limit; it adds no secrecy.
//
// What the homeserver holds under rung 2: ciphertext shards, until its operator purges them. The Matrix
// client API has no delete for media, so on a server you do not run the shards outlive the exchange. It
// also sees sizes, timing and who sent to whom. The keys are only ever inside Olm to-device messages.
// Every upload is returned to the caller (`mxcs`) so it can be recorded and purged where that is possible.
//
// Isomorphic: CompressionStream and WebCrypto exist in Node 20+ and in browsers.
import { CARRY } from './matrix.mjs';

// A Matrix event may be 65,536 bytes. Olm encryption and base64 roughly double a payload, and the manifest
// needs room, so a gzipped payload goes on rung 1 only up to this many bytes.
export const TO_DEVICE_BUDGET = 24 * 1024;
// Default shard size when the server states no smaller limit. Small enough to retry cheaply on a phone.
export const DEFAULT_SHARD_BYTES = 4 * 1024 * 1024;

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pipe(u8, stream) {
  const out = new Response(new Blob([u8]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const gzip = (u8) => pipe(u8, new CompressionStream('gzip'));
export const gunzip = (u8) => pipe(u8, new DecompressionStream('gzip'));
async function sha256hex(u8) { const d = await globalThis.crypto.subtle.digest('SHA-256', u8); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

// Send `payload` (any JSON value) under `topic` to every other device of `userId` (or one device).
export async function send(mx, userId, topic, payload, { onlyDevice = null, shardBytes = null, budget = TO_DEVICE_BUDGET } = {}) {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  const gz = await gzip(raw);
  const id = globalThis.crypto.randomUUID();
  if (gz.length <= budget) {
    const devices = await mx.toUser(userId, CARRY, { id, topic, rung: 'to-device', gz: b64(gz) }, { onlyDevice });
    return { id, rung: 'to-device', bytes: raw.length, gzBytes: gz.length, shards: 0, mxcs: [], devices };
  }
  const limit = await mx.mediaLimit();
  const size = Math.max(1024, Math.min(shardBytes || DEFAULT_SHARD_BYTES, limit ? limit - 1024 : Infinity));
  const shards = [];
  for (let at = 0; at < gz.length; at += size) {
    const sealed = mx.sealAttachment(gz.subarray(at, Math.min(at + size, gz.length)));
    shards.push({ mxc: await mx.uploadMedia(sealed.data), info: sealed.info, bytes: sealed.data.length });
  }
  const manifest = { id, topic, rung: 'media', gzBytes: gz.length, gzSha256: await sha256hex(gz), shards };
  const devices = await mx.toUser(userId, CARRY, manifest, { onlyDevice });
  return { id, rung: 'media', bytes: raw.length, gzBytes: gz.length, shards: shards.length, mxcs: shards.map((s) => s.mxc), devices };
}

// Open one carried message (as it sits in the to-device inbox). Throws on any shard that fails its hash.
export async function open(mx, content) {
  let gz;
  if (content.rung === 'to-device') gz = unb64(content.gz);
  else if (content.rung === 'media') {
    const parts = [];
    for (const s of content.shards) parts.push(mx.openAttachment(await mx.downloadMedia(s.mxc), s.info));
    gz = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of parts) { gz.set(p, at); at += p.length; }
    if (gz.length !== content.gzBytes || (await sha256hex(gz)) !== content.gzSha256) throw new Error('carried payload does not match its manifest');
  } else throw new Error(`unknown rung ${content.rung}`);
  return JSON.parse(new TextDecoder().decode(await gunzip(gz)));
}

// Everything carried to this device since the last look. Call after mx.sync(). Only Olm-encrypted messages
// are accepted; a plaintext to-device message claiming to be a carry is dropped and counted.
export async function receive(mx) {
  const out = [], dropped = [];
  for (const m of mx.takeInbox(CARRY)) {
    if (!m.verified) { dropped.push({ sender: m.sender, reason: 'not_encrypted' }); continue; }
    try { out.push({ id: m.content.id, topic: m.content.topic, rung: m.content.rung, sender: m.sender, senderDevice: m.senderDevice, payload: await open(mx, m.content) }); }
    catch (e) { dropped.push({ sender: m.sender, id: m.content?.id, reason: String(e?.message ?? e).slice(0, 120) }); }
  }
  return { messages: out, dropped };
}
