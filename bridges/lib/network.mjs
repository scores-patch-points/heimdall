// network.mjs: nodes form networks. No roles.
// Isomorphic (Node or browser). Needs a MatrixDevice (lib/matrix.mjs) and a store (lib/stores.mjs).
//
// A NODE is a log on a device, belonging to a Matrix user. Any node can OPEN a network over data it holds
// (a Matrix room), and can invite other nodes in. Whoever opens a network holds its power (Matrix power
// level 100; everyone else 0, and every act on the room needs 100). Nothing else differs between nodes:
// the same node can hold power in a network it opened and none in a network it joined.
//
// What follows, for any network, enforced where:
//   the opener can remove any node       Matrix power levels; then the Megolm session is rotated, so new
//                                        records get keys the removed node never receives
//   no other node can remove the opener  the homeserver refuses the kick (403); the opener's data is on
//                                        the opener's devices, which another node cannot reach
//   a removed node can no longer read    the opener's device serves records only to current members
//     or write                           (checked against the homeserver at each request) and refuses
//                                        submissions from non-members
// What it cannot do: take back what a node already decrypted or copied while it was in the network.
// Rotation protects the future, not the past. CODECS.md section 6 says this in full.
import { RECORD, canonicalJson } from './matrix.mjs';
import { signedHeaders } from './nodesync.mjs';

export const KINDS = {
  'sealed-record': { cell: 'INS·Figure', why: 'a record held in this network; the body is Megolm ciphertext made on the device of the node that wrote it' },
  grant: { cell: 'CON·Figure', why: 'a node is connected to this network and given its current room keys' },
  revoke: { cell: 'SEG·Figure', why: 'a node is cut from this network; later sessions are never shared with it' },
  epoch: { cell: 'REC·Pattern', why: 'the key frame is restructured: the outbound Megolm session was discarded and a new one starts' },
};
const markOf = (kind, addr, body, { of = [], witness }) => ({ kind, cell: KINDS[kind].cell, addr, body, of, witness: { how: witness }, declare: { why: KINDS[kind].why } });
const shortHash = async (s) => {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
};

// A network this node holds (it opened it, so its devices keep the records).
export class Network {
  constructor({ mx, store, roomId }) { Object.assign(this, { mx, store, roomId }); }

  static async open({ mx, store, name = 'network' }) {
    const roomId = await mx.openNetworkRoom(name);
    const n = new Network({ mx, store, roomId });
    await store.append(markOf('epoch', `room:${await shortHash(roomId)}`, { room: roomId, cause: 'opened' }, { witness: `network room opened on ${mx.deviceId}` }));
    return n;
  }

  async write(plaintext) {
    const content = await this.mx.encryptRecord(this.roomId, plaintext);
    const rec = { room: this.roomId, sender: this.mx.userId, ts: Date.now(), ref: await shortHash(content.ciphertext), content };
    const r = await this.store.append(markOf('sealed-record', `sealed:${rec.ref}`, rec, { witness: `Megolm-encrypted on device ${this.mx.deviceId}` }));
    return { ...r, ref: rec.ref };
  }

  async records() { return (await this.store.list({ kind: 'sealed-record' })).map((r) => ({ id: r.id, ...r.mark.body })); }
  async read() { const out = []; for (const r of await this.records()) out.push({ ref: r.ref, sender: r.sender, ...(await this.mx.decryptRecord(r.room, r)) }); return out; }

  async invite(userId) { await this.mx.invite(this.roomId, userId); }
  // After the node joined: share the current session, and (only if the holder says so) the history.
  async grant(userId, { history = false } = {}) {
    const members = await this.mx.members(this.roomId);
    if (!members.includes(userId)) return { ok: false, reason: 'not_joined', detail: `${userId} has not joined the network` };
    await this.mx.shareKeys(this.roomId);
    if (history) await this.mx.shareHistory(this.roomId, userId);
    return this.store.append(markOf('grant', `member:${await shortHash(userId)}`, { member: userId, history }, { witness: `room keys shared by device ${this.mx.deviceId}` }));
  }

  async remove(userId, why = 'removed by the node that holds the network') {
    await this.mx.kick(this.roomId, userId, why);
    await this.mx.rotate(this.roomId);
    const addr = `member:${await shortHash(userId)}`;
    const grants = (await this.store.list({ kind: 'grant' })).filter((r) => r.mark.body.member === userId).map((r) => r.id);
    const cut = await this.store.append(markOf('revoke', addr, { member: userId, why }, { of: grants.filter((id) => !id.startsWith('m:')), witness: `kicked on the homeserver; Megolm session discarded on ${this.mx.deviceId}` }));
    const ep = await this.store.append(markOf('epoch', `room:${await shortHash(this.roomId)}`, { room: this.roomId, cause: 'revoke' }, { of: cut.id && !cut.id.startsWith('m:') ? [cut.id] : [], witness: 'next record starts a new Megolm session' }));
    return { cut, ep };
  }

  // ---- what the on-device server calls on behalf of another node ----
  async isMember(userId) { return userId === this.mx.userId || (await this.mx.members(this.roomId)).includes(userId); }
  async serve(userId) {
    if (!(await this.isMember(userId))) return { ok: false, status: 403, reason: 'not_a_member' };
    return { ok: true, room: this.roomId, records: await this.records() };
  }
  async accept(userId, rec) {
    if (!(await this.isMember(userId))) return { ok: false, status: 403, reason: 'not_a_member' };
    if (rec.sender !== userId || rec.room !== this.roomId) return { ok: false, status: 400, reason: 'sender_or_room_mismatch' };
    // proves it is real Megolm from that node's device. Its room key travels by Matrix to-device,
    // so it may arrive just after the ciphertext: sync and retry a few times.
    let d = await this.mx.decryptRecord(this.roomId, rec);
    for (let i = 0; i < 4 && !d.ok; i++) { await this.mx.sync(i ? 2000 : 0); d = await this.mx.decryptRecord(this.roomId, rec); }
    if (!d.ok) return { ok: false, status: 422, reason: 'cannot_decrypt', detail: d.why };
    if (d.sender !== userId) return { ok: false, status: 400, reason: 'sender_mismatch' };
    const r = await this.store.append(markOf('sealed-record', `sealed:${rec.ref}`, rec, { witness: `submitted by ${userId} device ${d.senderDevice}; decrypted and sender checked by Megolm on ${this.mx.deviceId}` }));
    return { ok: r.ok, id: r.id };
  }
}

// A node's link into a network another node holds. Keeps nothing at rest by default; reads by asking the
// holder's device, which decides.
export class Link {
  constructor({ mx, roomId, holderUrl }) { Object.assign(this, { mx, roomId, holderUrl: holderUrl?.replace(/\/$/, '') }); }
  // Every request is signed with this device's Matrix key; the holder checks it against the key this
  // user's homeserver publishes, then checks membership in the network.
  async fetch() {
    const { headers } = await signedHeaders(this.mx, 'GET', '/v1/records', '');
    const r = await fetch(`${this.holderUrl}/v1/records`, { headers });
    const j = await r.json();
    if (!j.ok) return j;
    await this.mx.sync();
    for (const m of this.mx.takeInbox('org.heimdall.room_keys')) if (m.content?.room_id === this.roomId) await this.mx.importHistory(m);
    const out = [];
    for (const rec of j.records) out.push({ ref: rec.ref, sender: rec.sender, ...(await this.mx.decryptRecord(this.roomId, rec)) });
    return { ok: true, records: out };
  }
  async submit(plaintext) {
    const content = await this.mx.encryptRecord(this.roomId, plaintext);
    const rec = { room: this.roomId, sender: this.mx.userId, ts: Date.now(), ref: content.ciphertext.slice(0, 32).replace(/[^A-Za-z0-9]/g, ''), content, type: RECORD };
    const body = canonicalJson(rec);
    const { headers } = await signedHeaders(this.mx, 'POST', '/v1/submit', body);
    const r = await fetch(`${this.holderUrl}/v1/submit`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
    return r.json();
  }
}
