// matrix.mjs: Matrix for ACCOUNTS, COLLABORATION, SYNC and ENCRYPTION. Never for storing records.
//
//   accounts       a Matrix user + device is the identity; OpenID tokens prove it to other devices
//   collaboration  a network is a room; the node that opens it is at power 100, every other node at 0,
//                  so only the opener can invite, kick or ban, and no other node can kick the opener
//   sync           /sync drives everything: membership, device lists, to-device messages
//   encryption     vodozemac via @matrix-org/matrix-sdk-crypto-wasm (the Rust crypto Element uses):
//                  records are Megolm-encrypted for the network's room but NEVER SENT to it; the ciphertext
//                  lives on devices. Room keys and signals travel as Olm-encrypted to-device messages,
//                  which the homeserver deletes once delivered.
//
// The client-server calls are plain fetch against the Matrix spec (v3); no SDK besides the crypto.
// Isomorphic: runs in Node 20+ and in a browser (fetch, WebCrypto, the wasm crypto). In a browser the
// crypto machine persists its Olm/Megolm state in IndexedDB (pass storeName + storePassphrase to login);
// in Node it is in memory and its room keys are exported into the device's sealed key store.
import * as M from '@matrix-org/matrix-sdk-crypto-wasm';

export const SIGNAL = 'org.heimdall.signal';        // to-device: "records available", never their content
export const KEYS = 'org.heimdall.room_keys';        // to-device: exported Megolm keys for history the owner chooses to share
export const RECORD = 'org.heimdall.record';         // the event type inside the Megolm ciphertext
export const CARRY = 'org.heimdall.carry';             // to-device: one carried payload, or the manifest of its shards in the media store
let inited = false;
async function init() { if (!inited) { await M.initAsync(); inited = true; } }

const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

export class MatrixError extends Error {
  constructor(status, body, where) { super(`${where}: ${status} ${body?.errcode ?? ''} ${body?.error ?? ''}`.trim()); Object.assign(this, { status, errcode: body?.errcode, where, body }); }
}

export class MatrixDevice {
  constructor(hs) { this.hs = hs.replace(/\/$/, ''); this.since = null; this.toDeviceInbox = []; this.membership = new Map(); }

  async api(method, path, body, { auth = true } = {}) {
    const r = await fetch(this.hs + path, {
      method, headers: { 'content-type': 'application/json', ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!r.ok) throw new MatrixError(r.status, json, `${method} ${path.split('?')[0]}`);
    return { json, text };
  }

  // ---------- accounts ----------
  // Test homeserver only: register through Synapse's shared-secret admin API (HMAC, as its docs specify).
  static async registerWithSharedSecret(hs, secret, username, password) {
    const d = new MatrixDevice(hs);
    const { json: { nonce } } = await d.api('GET', '/_synapse/admin/v1/register', undefined, { auth: false });
    const k = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await globalThis.crypto.subtle.sign('HMAC', k, new TextEncoder().encode([nonce, username, password, 'notadmin'].join('\0')));
    const mac = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await d.api('POST', '/_synapse/admin/v1/register', { nonce, username, password, admin: false, mac }, { auth: false });
    return d;
  }
  // Any homeserver that offers registration tokens (Conduit, Synapse with tokens, Dendrite): the spec's
  // user-interactive flow with m.login.registration_token.
  static async registerWithToken(hs, token, username, password) {
    const d = new MatrixDevice(hs);
    const body = { username, password, inhibit_login: true };
    let session;
    try { await d.api('POST', '/_matrix/client/v3/register', body, { auth: false }); return d; }
    catch (e) { if (e.status !== 401) throw e; session = e.body?.session; }
    await d.api('POST', '/_matrix/client/v3/register', { ...body, auth: { type: 'm.login.registration_token', token, session } }, { auth: false });
    return d;
  }
  async login(user, password, deviceName, { storeName, storePassphrase } = {}) {
    const { json } = await this.api('POST', '/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password, initial_device_display_name: deviceName }, { auth: false });
    Object.assign(this, { token: json.access_token, userId: json.user_id, deviceId: json.device_id });
    await init();
    this.machine = await M.OlmMachine.initialize(new M.UserId(this.userId), new M.DeviceId(this.deviceId), storeName, storePassphrase);
    await this.flush();
    return this;
  }
  async logout() { try { await this.api('POST', '/_matrix/client/v3/logout', {}); } finally { this.machine?.close(); } }
  // Cross-signing: the account's master key signs its devices, so another node can tell this user's
  // phone from a device the homeserver slipped in. Bootstrapping needs user-interactive auth once.
  async bootstrapCrossSigning(password) {
    const req = await this.machine.bootstrapCrossSigning(true);
    const auth = { type: 'm.login.password', identifier: { type: 'm.id.user', user: this.userId }, password };
    await this.api('POST', '/_matrix/client/v3/keys/device_signing/upload', { ...JSON.parse(req.uploadSigningKeysRequest.body), auth });
    await this.send(req.uploadSignaturesRequest);
    await this.flush();
  }
  // OpenID token: lets another device check "this caller is @x on this homeserver" without a password.
  async openIdToken() { return (await this.api('POST', `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/openid/request_token`, {})).json; }
  async whoIsOpenId(tokenObj) {
    const { json } = await this.api('GET', `/_matrix/federation/v1/openid/userinfo?access_token=${encodeURIComponent(tokenObj.access_token)}`, undefined, { auth: false });
    return json.sub;
  }

  // ---------- the crypto machine's outgoing requests ----------
  async send(req) {
    const T = M.RequestType;
    let res;
    switch (req.type) {
      case T.KeysUpload: res = await this.api('POST', '/_matrix/client/v3/keys/upload', req.body); break;
      case T.KeysQuery: res = await this.api('POST', '/_matrix/client/v3/keys/query', req.body); break;
      case T.KeysClaim: res = await this.api('POST', '/_matrix/client/v3/keys/claim', req.body); break;
      case T.ToDevice: res = await this.api('PUT', `/_matrix/client/v3/sendToDevice/${encodeURIComponent(req.event_type)}/${encodeURIComponent(req.txn_id)}`, req.body); break;
      case T.SignatureUpload: res = await this.api('POST', '/_matrix/client/v3/keys/signatures/upload', req.body); break;
      case T.RoomMessage: throw new Error('refused: the surface never sends a room message (records stay on devices)');
      default: return; // KeysBackup: no server-side key backup by design (keys stay on devices)
    }
    if (req.id) await this.machine.markRequestAsSent(req.id, req.type, res.text);
  }
  async flush() { for (let i = 0; i < 10; i++) { const out = await this.machine.outgoingRequests(); if (!out.length) return; for (const r of out) await this.send(r); } }

  // ---------- sync ----------
  async sync(timeout = 0) {
    const q = new URLSearchParams({ timeout: String(timeout), ...(this.since ? { since: this.since } : {}) });
    const { json } = await this.api('GET', `/_matrix/client/v3/sync?${q}`);
    this.since = json.next_batch;
    const changed = (json.device_lists?.changed ?? []).map((u) => new M.UserId(u));
    const left = (json.device_lists?.left ?? []).map((u) => new M.UserId(u));
    const otk = new Map(Object.entries(json.device_one_time_keys_count ?? {}));
    const fb = json.device_unused_fallback_key_types ? new Set(json.device_unused_fallback_key_types) : undefined;
    const processed = await this.machine.receiveSyncChanges(JSON.stringify(json.to_device?.events ?? []), new M.DeviceLists(changed, left), otk, fb);
    for (const p of processed) {
      const raw = JSON.parse(p.rawEvent);
      if (raw.type === SIGNAL || raw.type === KEYS || raw.type === CARRY) this.toDeviceInbox.push({ ...raw, verified: p.encryptionInfo ? true : false, senderDevice: p.encryptionInfo?.senderDevice?.toString() ?? null });
    }
    for (const [roomId, r] of Object.entries(json.rooms?.join ?? {})) {
      for (const ev of [...(r.state?.events ?? []), ...(r.timeline?.events ?? [])]) if (ev.type === 'm.room.member') this.noteMember(roomId, ev);
    }
    for (const [roomId, r] of Object.entries(json.rooms?.invite ?? {})) this.membership.set(roomId, this.membership.get(roomId) ?? new Map());
    for (const roomId of Object.keys(json.rooms?.leave ?? {})) this.membership.delete(roomId);
    await this.flush();
    return json;
  }
  noteMember(roomId, ev) {
    const m = this.membership.get(roomId) ?? new Map();
    m.set(ev.state_key, ev.content.membership);
    this.membership.set(roomId, m);
  }
  async members(roomId) {   // authoritative read from the homeserver, not the local cache
    const { json } = await this.api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
    return Object.keys(json.joined);
  }

  // ---------- collaboration: a network is a room ----------
  async openNetworkRoom(name) {
    // Power is set by a state event right after creation, not by power_level_content_override: Conduit
    // (v0.10.15) refuses any override at creation with 403, while a plain create plus a power-levels event
    // is the spec's ordinary path and works on every homeserver tried.
    const { json } = await this.api('POST', '/_matrix/client/v3/createRoom', {
      name, preset: 'private_chat', visibility: 'private',
      initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
        { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
      ],
    });
    const pl = `/_matrix/client/v3/rooms/${encodeURIComponent(json.room_id)}/state/m.room.power_levels/`;
    const cur = (await this.api('GET', pl)).json;
    // Room version 12 and later: the creator holds power implicitly, above every level, cannot be removed,
    // and must NOT be listed in `users` (the server refuses it). Earlier versions: list the creator at 100.
    const create = (await this.api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(json.room_id)}/state/m.room.create/`)).json;
    const creatorImplicit = Number.parseInt(create.room_version, 10) >= 12;
    await this.api('PUT', pl, {
      ...cur,
      users: creatorImplicit ? {} : { [this.userId]: 100 }, users_default: 0,
      invite: 100, kick: 100, ban: 100, redact: 100, state_default: 100, events_default: 100,
      events: { ...(cur.events || {}), 'm.room.power_levels': 100, 'm.room.name': 100, 'm.room.encryption': 100, 'm.room.tombstone': 100, 'm.room.server_acl': 100, 'm.room.history_visibility': 100 },
    });
    const roomId = json.room_id;
    // encryption settings the machine needs to Megolm-encrypt "for" this room
    await this.machine.setRoomSettings(new M.RoomId(roomId), Object.assign(new M.RoomSettings(), { algorithm: M.EncryptionAlgorithm.MegolmV1AesSha2, onlyAllowTrustedDevices: false }));
    return roomId;
  }
  async invite(roomId, userId) { await this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: userId }); }
  async join(roomId) {
    await this.api('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {});
    await this.machine.setRoomSettings(new M.RoomId(roomId), Object.assign(new M.RoomSettings(), { algorithm: M.EncryptionAlgorithm.MegolmV1AesSha2, onlyAllowTrustedDevices: false }));
  }
  async kick(roomId, userId, reason) { await this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`, { user_id: userId, reason }); }
  async ban(roomId, userId, reason) { await this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/ban`, { user_id: userId, reason }); }
  async leave(roomId) { await this.api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {}); }

  // ---------- encryption ----------
  // Make sure every current member device has the current Megolm session (and only them).
  async shareKeys(roomId) {
    const ids = await this.members(roomId);
    const users = () => ids.map((u) => new M.UserId(u)); // wasm takes ownership: fresh objects per call
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    const claim = await this.machine.getMissingSessions(users());
    if (claim) await this.send(claim);
    const settings = new M.EncryptionSettings();
    settings.historyVisibility = M.HistoryVisibility.Joined;
    settings.sharingStrategy = M.CollectStrategy.allDevices();
    for (const r of await this.machine.shareRoomKey(new M.RoomId(roomId), users(), settings)) await this.send(r);
  }
  // Rotate: discard the outbound Megolm session so the next record starts a new one (after a kick).
  async rotate(roomId) { return this.machine.invalidateGroupSession(new M.RoomId(roomId)); }

  // Encrypt a record FOR the room without sending anything to the room. Returns the m.room.encrypted content.
  async encryptRecord(roomId, plaintext) {
    await this.shareKeys(roomId);
    return JSON.parse(await this.machine.encryptRoomEvent(new M.RoomId(roomId), RECORD, JSON.stringify(plaintext)));
  }
  // Decrypt one stored ciphertext. `sender` is the Matrix user who wrote it (kept beside the ciphertext).
  async decryptRecord(roomId, stored) {
    const ev = { type: 'm.room.encrypted', content: stored.content, sender: stored.sender, event_id: '$' + stored.ref, origin_server_ts: stored.ts, room_id: roomId };
    try {
      const d = await this.machine.decryptRoomEvent(JSON.stringify(ev), new M.RoomId(roomId), new M.DecryptionSettings(M.TrustRequirement.Untrusted));
      return { ok: true, plaintext: JSON.parse(d.event).content, sender: d.sender.toString(), senderDevice: d.senderDevice?.toString() ?? null };
    } catch (e) { return { ok: false, why: e?.description ?? e?.message ?? JSON.stringify({ code: e?.code, ...e }) }; }
  }

  // Olm-encrypted to-device message to every device of one user (ephemeral on the homeserver).
  // Never to this device itself. `onlyDevice` narrows to one device of that user.
  async toUser(userId, type, content, { onlyDevice = null } = {}) {
    const uid = () => new M.UserId(userId);
    await this.machine.updateTrackedUsers([uid()]);
    await this.refreshDevices(userId);                 // a device added since the last look must not be missed
    const claim = await this.machine.getMissingSessions([uid()]);
    if (claim) await this.send(claim);
    const devs = (await this.machine.getUserDevices(uid(), 5)).devices()
      .filter((d) => !(userId === this.userId && d.deviceId.toString() === this.deviceId) && (!onlyDevice || d.deviceId.toString() === onlyDevice));
    const messages = { [userId]: {} };
    for (const d of devs) messages[userId][d.deviceId.toString()] = JSON.parse(await d.encryptToDeviceEvent(type, content));
    if (!devs.length) throw new Error(`no devices known for ${userId}`);
    await this.api('PUT', `/_matrix/client/v3/sendToDevice/m.room.encrypted/${globalThis.crypto.randomUUID()}`, { messages });
    return devs.length;
  }
  // Share the keys for history the owner chooses (exported Megolm sessions of this room).
  async shareHistory(roomId, userId) {
    const exported = await this.machine.exportRoomKeys((s) => s.roomId.toString() === roomId);
    return this.toUser(userId, KEYS, { room_id: roomId, keys: exported });
  }
  async importHistory(msg) {
    return this.machine.importExportedRoomKeys(msg.content.keys, () => {});
  }
  // Keys at rest: export this device's room keys so the sealed keystore can hold them across restarts.
  async exportKeys(roomId) { return this.machine.exportRoomKeys((s) => !roomId || s.roomId.toString() === roomId); }
  async importKeys(exported) { return this.machine.importExportedRoomKeys(exported, () => {}); }
  // ---------- device-signed requests between a user's OWN devices ----------
  // A request (or response) is a canonical JSON payload signed by this device's Matrix ed25519 key.
  // The other side checks: same user, the device is cross-signed by the owner's self-signing key (so the
  // homeserver cannot slip one in), and the signature verifies against that device's published key.
  async signPayload(obj) {
    const payload = canonicalJson(obj);
    const sigs = await this.machine.sign(payload);
    return { payload, sigs: sigs.asJSON() };
  }
  async ownDeviceCheck(userId, deviceId, payload, sigsJson) {
    if (userId !== this.userId) return { ok: false, reason: 'not_own_user' };
    return this.deviceCheck(userId, deviceId, payload, sigsJson, { crossSigned: true });
  }
  // Any user's device: the signature must verify against the ed25519 key that user's homeserver publishes
  // for that device. With crossSigned, the device must also be signed by that user's own self-signing key.
  async deviceCheck(userId, deviceId, payload, sigsJson, { crossSigned = false } = {}) {
    await this.machine.updateTrackedUsers([new M.UserId(userId)]);
    await this.flush();
    let dev = await this.machine.getDevice(new M.UserId(userId), new M.DeviceId(deviceId), 5);
    for (let i = 0; i < 3 && (!dev || (crossSigned && !dev.isCrossSignedByOwner())); i++) {   // a device or signature this machine has not seen yet
      await this.refreshDevices(userId);
      dev = await this.machine.getDevice(new M.UserId(userId), new M.DeviceId(deviceId), 5);
    }
    if (!dev) return { ok: false, reason: 'unknown_device' };
    if (crossSigned && !dev.isCrossSignedByOwner()) return { ok: false, reason: 'device_not_cross_signed' };
    const key = dev.getKey(M.DeviceKeyAlgorithmName.Ed25519)?.toBase64();
    let sig; try { sig = JSON.parse(sigsJson)?.[userId]?.[`ed25519:${deviceId}`]; } catch { sig = null; }
    if (!key || !sig) return { ok: false, reason: 'no_signature' };
    const subtle = globalThis.crypto.subtle;
    const pk = await subtle.importKey('raw', unb64(key), { name: 'Ed25519' }, false, ['verify']);
    const good = await subtle.verify({ name: 'Ed25519' }, pk, unb64(sig), new TextEncoder().encode(payload));
    return good ? { ok: true, device: deviceId } : { ok: false, reason: 'bad_signature' };
  }
  // Mark a user's device list stale so the next flush re-queries it (an initial sync never reports changes).
  async refreshDevices(userId) {
    await this.machine.receiveSyncChanges('[]', new M.DeviceLists([new M.UserId(userId)], []), new Map(), undefined);
    await this.flush();
  }
  // Is this one of my own devices, vouched for by my self-signing key? (For messages that arrived Olm-encrypted,
  // where the library has already tied the message to that device's key.)
  async isOwnTrustedDevice(deviceId) {
    if (!deviceId || deviceId === this.deviceId) return false;
    let dev = await this.machine.getDevice(new M.UserId(this.userId), new M.DeviceId(deviceId), 5);
    for (let i = 0; i < 3 && (!dev || !dev.isCrossSignedByOwner()); i++) { await this.refreshDevices(this.userId); dev = await this.machine.getDevice(new M.UserId(this.userId), new M.DeviceId(deviceId), 5); }
    return !!dev && dev.isCrossSignedByOwner();
  }
  // The owner's device with the self-signing key vouches for another of the owner's devices.
  async crossSignOwnDevice(deviceId) {
    // a new device reaches this one through sync (device_lists.changed), then a keys/query
    let dev;
    for (let i = 0; i < 5 && !dev; i++) {
      await this.refreshDevices(this.userId);
      dev = await this.machine.getDevice(new M.UserId(this.userId), new M.DeviceId(deviceId), 5);
    }
    if (!dev) throw new Error(`device ${deviceId} not found`);
    await this.send(await dev.verify());
    await this.flush();
  }

  // ---------- the media store: ciphertext only, for a peer who is offline and a payload too large to queue ----------
  // Matrix's own encrypted-attachment scheme (AES-256-CTR, sha256 of the ciphertext), from the crypto library.
  sealAttachment(bytes) { const a = M.Attachment.encrypt(bytes); return { data: a.encryptedData, info: a.mediaEncryptionInfo }; }
  openAttachment(data, info) { return M.Attachment.decrypt(new M.EncryptedAttachment(data, info)); }
  async mediaLimit() {
    try { return (await this.api('GET', '/_matrix/client/v1/media/config')).json['m.upload.size'] ?? null; } catch { return null; }
  }
  async uploadMedia(bytes) {
    const r = await fetch(this.hs + '/_matrix/media/v3/upload', { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream' }, body: bytes });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new MatrixError(r.status, j, 'POST /_matrix/media/v3/upload');
    return j.content_uri;
  }
  async downloadMedia(mxc) {
    const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc);
    if (!m) throw new Error('not an mxc address');
    const r = await fetch(`${this.hs}/_matrix/client/v1/media/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new MatrixError(r.status, await r.json().catch(() => ({})), 'GET media/download');
    return new Uint8Array(await r.arrayBuffer());
  }

  takeInbox(type) { const got = this.toDeviceInbox.filter((m) => m.type === type); this.toDeviceInbox = this.toDeviceInbox.filter((m) => m.type !== type); return got; }
}
