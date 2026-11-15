// courier.mjs: what nodes say to each other over the transport. No node has to be reachable by another:
// every message goes through Matrix (lib/transport.mjs), online or not.
//
// Between a person's OWN devices (the pharos log is a grow-only set, so union by id is the whole CRDT):
//   peer.offer    "here are the ids I hold"
//   peer.entries  "here is what you lack" (+ my ids, once, so you can send what I lack)
//   Accepted only from the same user's device that the owner cross-signed. Entries are merged by Penelope.
//   Only what the other side lacks is sent, never the whole log.
//
// Between DIFFERENT people's nodes in a network (the holder decides, at the moment it handles the message):
//   net.want      "send me this network's records"      -> net.records | net.refused
//   net.submit    "here is a record I encrypted"        -> net.ack
//   Membership is asked of the homeserver when the holder handles the message, so a removed node is
//   refused even for a request it sent while still a member and the holder was offline.
//
// pump() is one turn: sync, open what arrived, answer it. A node that is offline simply pumps later.
import * as T from './transport.mjs';

export class Courier {
  // store: this node's store (needs all() and merge() for peer topics). networks: Network objects this node holds.
  constructor({ mx, store = null, here = 'node', networks = [], shardBytes = null }) {
    Object.assign(this, { mx, store, here, shardBytes });
    this.networks = new Map(networks.map((n) => [n.roomId, n]));
    this.inbox = [];          // answers addressed to this node: net.records, net.refused, net.ack
    this.sent = [];           // every send, with its rung and any media addresses (so they can be recorded and purged)
  }
  hold(network) { this.networks.set(network.roomId, network); return this; }

  async say(userId, topic, payload, opts = {}) {
    const r = await T.send(this.mx, userId, topic, payload, { shardBytes: this.shardBytes, ...opts });
    this.sent.push({ to: userId, topic, rung: r.rung, bytes: r.bytes, gzBytes: r.gzBytes, shards: r.shards, mxcs: r.mxcs });
    return r;
  }

  // ---- own devices ----
  async offerToPeers() { return this.say(this.mx.userId, 'peer.offer', { from: this.here, ids: (await this.store.all()).map((e) => e.id) }); }

  // ---- other people's networks ----
  want(holderUserId, roomId) { return this.say(holderUserId, 'net.want', { room: roomId }); }
  submit(holderUserId, rec) { return this.say(holderUserId, 'net.submit', { rec }); }
  take(topic) { const got = this.inbox.filter((m) => m.topic === topic); this.inbox = this.inbox.filter((m) => m.topic !== topic); return got; }

  async pump(timeout = 0) {
    await this.mx.sync(timeout);
    const { messages, dropped } = await T.receive(this.mx);
    const handled = [];
    for (const m of messages) {
      const row = { topic: m.topic, from: m.sender, rung: m.rung };
      try { Object.assign(row, await this.handle(m)); } catch (e) { row.error = String(e?.message ?? e).slice(0, 160); }
      handled.push(row);
    }
    return { handled, dropped };
  }

  async handle(m) {
    const p = m.payload;
    if (m.topic === 'peer.offer' || m.topic === 'peer.entries') {
      if (m.sender !== this.mx.userId) return { refused: 'not_own_user' };
      if (!(await this.mx.isOwnTrustedDevice(m.senderDevice))) return { refused: 'device_not_cross_signed' };
      if (!this.store?.merge) return { refused: 'no_pharos_store_here' };
      let merged = null;
      if (m.topic === 'peer.entries' && p.entries.length) {
        merged = await this.store.merge({ from: p.from, entries: p.entries, witness: `carried over Matrix (${m.rung}) from own device ${m.senderDevice}, cross-signed by the owner; Olm-encrypted in transit` });
        if (!merged.ok) return { refused: merged.reason };
      }
      if (p.ids) {                                   // the other side told us what it holds: send what it lacks
        const theirs = new Set(p.ids), mine = await this.store.all();
        const lacking = mine.filter((e) => !theirs.has(e.id));
        const reply = { from: this.here, entries: lacking, ...(m.topic === 'peer.offer' ? { ids: mine.map((e) => e.id) } : {}) };
        if (lacking.length || reply.ids) { const r = await this.say(this.mx.userId, 'peer.entries', reply, { onlyDevice: m.senderDevice }); return { merged: merged?.added ?? 0, sent: lacking.length, replyRung: r.rung, replyShards: r.shards }; }
      }
      return { merged: merged?.added ?? 0, sent: 0 };
    }
    if (m.topic === 'net.want') {
      const net = this.networks.get(p.room);
      if (!net) { await this.say(m.sender, 'net.refused', { room: p.room, reason: 'no_such_network_here' }, { onlyDevice: m.senderDevice }); return { refused: 'no_such_network_here' }; }
      const r = await net.serve(m.sender);
      if (!r.ok) { await this.say(m.sender, 'net.refused', { room: p.room, reason: r.reason }, { onlyDevice: m.senderDevice }); return { refused: r.reason }; }
      const s = await this.say(m.sender, 'net.records', { room: p.room, records: r.records }, { onlyDevice: m.senderDevice });
      return { served: r.records.length, replyRung: s.rung, replyShards: s.shards };
    }
    if (m.topic === 'net.submit') {
      const net = this.networks.get(p.rec?.room);
      const r = net ? await net.accept(m.sender, p.rec) : { ok: false, reason: 'no_such_network_here' };
      await this.say(m.sender, 'net.ack', { ref: p.rec?.ref, ok: !!r.ok, reason: r.reason ?? null }, { onlyDevice: m.senderDevice });
      return r.ok ? { accepted: p.rec.ref } : { refused: r.reason };
    }
    if (['net.records', 'net.refused', 'net.ack'].includes(m.topic)) { this.inbox.push({ topic: m.topic, from: m.sender, ...p }); return { kept: true }; }
    return { refused: 'unknown_topic' };
  }
}

// A node's side of someone else's network, over Matrix only (no address of the holder's device is needed).
export class MatrixLink {
  constructor({ mx, courier, roomId, holder }) { Object.assign(this, { mx, courier, roomId, holder }); }
  ask() { return this.courier.want(this.holder, this.roomId); }
  // After the holder has answered and this node has pumped: decrypt what came.
  async read() {
    const refused = this.courier.take('net.refused').filter((m) => m.room === this.roomId);
    if (refused.length) return { ok: false, reason: refused.at(-1).reason };
    const got = this.courier.take('net.records').filter((m) => m.room === this.roomId).at(-1);
    if (!got) return { ok: false, reason: 'no_answer_yet' };
    for (const k of this.mx.takeInbox('org.heimdall.room_keys')) if (k.content?.room_id === this.roomId) await this.mx.importHistory(k);
    const out = [];
    for (const rec of got.records) out.push({ ref: rec.ref, sender: rec.sender, ...(await this.mx.decryptRecord(this.roomId, rec)) });
    return { ok: true, records: out };
  }
  async write(plaintext) {
    const content = await this.mx.encryptRecord(this.roomId, plaintext);
    const rec = { room: this.roomId, sender: this.mx.userId, ts: Date.now(), ref: content.ciphertext.slice(0, 32).replace(/[^A-Za-z0-9]/g, ''), content };
    await this.courier.submit(this.holder, rec);
    return rec.ref;
  }
}
