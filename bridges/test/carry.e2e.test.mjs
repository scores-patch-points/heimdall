// Everything crosses over Matrix: no node is reachable by another, no device server is started.
// Real homeserver (see test/target.mjs), pharos and Penelope (see test/env.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { MatrixDevice } from '../lib/matrix.mjs';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore } from '../lib/stores.mjs';
import { Network } from '../lib/network.mjs';
import { Courier, MatrixLink } from '../lib/courier.mjs';
import { gapBetween } from '../lib/nodesync.mjs';
import * as T from '../lib/transport.mjs';
import { target } from './target.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const TG = await target();
const HS = TG.hs, up = TG.up;
const skip = needs || (!up && 'homeserver not up');

async function sandboxNode(sandbox, name) {
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, name, 'log'), pendingFile: path.join(sandbox, name, 'pending.jsonl') });
  assert.equal(door.mode, 'module', door.why);
  return { door, store: penelopeStore({ door, log: 'care', by: 'heimdall' }) };
}
function newSandbox() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-carry-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  return sandbox;
}
const rnd = (n) => crypto.randomBytes(n).toString('hex');

test("one person's two devices sync over Matrix alone: small data in to-device messages, bulk for an offline device through the media store", { skip }, async (t) => {
  const sandbox = newSandbox();
  const user = 'ana' + rnd(4), pw = rnd(12);
  await TG.register(user, pw);
  const phoneMx = await new MatrixDevice(HS).login(user, pw, 'ana phone');
  await phoneMx.bootstrapCrossSigning(pw);
  const laptopMx = await new MatrixDevice(HS).login(user, pw, 'ana laptop');
  await phoneMx.crossSignOwnDevice(laptopMx.deviceId);
  const phone = await sandboxNode(sandbox, 'phone'), laptop = await sandboxNode(sandbox, 'laptop');
  const net = await Network.open({ mx: phoneMx, store: phone.store });
  await laptopMx.join(net.roomId);
  const onLaptop = new Network({ mx: laptopMx, store: laptop.store, roomId: net.roomId });
  const SHARD = 16 * 1024;   // small shards so the test exercises several
  const cPhone = new Courier({ mx: phoneMx, store: phone.store, here: 'phone', shardBytes: SHARD });
  const cLaptop = new Courier({ mx: laptopMx, store: laptop.store, here: 'laptop', shardBytes: SHARD });
  const content = async () => gapBetween(await phone.store.all(), await laptop.store.all()).contentGap;

  // --- small, both online: to-device messages only ---
  await net.write({ note: 'written on the phone' });
  await laptopMx.sync();
  await onLaptop.write({ note: 'written on the laptop' });
  assert.ok((await content()) > 0);
  await cLaptop.offerToPeers();
  const p1 = await cPhone.pump();          // phone: gets the offer, sends what the laptop lacks + its ids
  const l1 = await cLaptop.pump();         // laptop: merges, sends what the phone lacks
  const p2 = await cPhone.pump();          // phone: merges
  assert.equal(p1.handled[0].topic, 'peer.offer'); assert.equal(l1.handled[0].topic, 'peer.entries'); assert.ok(p2.handled[0].merged > 0);
  assert.equal(await content(), 0, 'both nodes hold the same content');
  assert.ok([...cPhone.sent, ...cLaptop.sent].every((s) => s.rung === 'to-device'), 'small data never touched the media store');
  const sentLacking = cPhone.sent.find((s) => s.topic === 'peer.entries');
  assert.ok(sentLacking.bytes < JSON.stringify(await phone.store.all()).length, 'only what the other side lacked was sent, not the whole log');

  // --- bulk, the laptop is offline: media store ---
  await cLaptop.offerToPeers();            // the laptop asks, then goes offline (it simply does not sync)
  const marker = 'BULK-' + rnd(8);
  for (let i = 0; i < 40; i++) await net.write({ note: `${marker} record ${i}`, pad: rnd(1500) });
  const p3 = await cPhone.pump();          // the phone answers while the laptop is away
  const bulk = cPhone.sent.at(-1);
  assert.equal(bulk.rung, 'media'); assert.ok(bulk.shards > 1, `several shards (${bulk.shards})`);
  assert.ok(bulk.gzBytes > T.TO_DEVICE_BUDGET);
  assert.ok((await content()) >= 40, 'the laptop has none of it yet');

  // what the homeserver holds: ciphertext. Not gzip, no entry structure, no known text.
  const rawShard = Buffer.from(await phoneMx.downloadMedia(bulk.mxcs[0]));
  assert.ok(!(rawShard[0] === 0x1f && rawShard[1] === 0x8b), 'a stored shard is not a bare gzip stream');
  for (const word of ['sealed-record', 'INS·Figure', marker, phoneMx.userId]) assert.ok(!rawShard.includes(word), `a stored shard does not contain "${word}"`);

  // a stranger with an account on the same server can fetch a shard only if it learns the address, and cannot open it
  const strangerUser = 'eve' + rnd(4); await TG.register(strangerUser, pw);
  const eve = await new MatrixDevice(HS).login(strangerUser, pw, 'eve');
  await eve.sync();
  assert.equal((await T.receive(eve)).messages.length, 0, 'the manifest (addresses and keys) went to nobody else');

  // the laptop comes back
  const l2 = await cLaptop.pump();
  assert.equal(l2.handled[0].rung, 'media'); assert.equal(l2.handled[0].merged >= 40, true, JSON.stringify(l2));
  await cPhone.pump();
  assert.equal(await content(), 0);
  await laptopMx.sync();
  const read = (await onLaptop.read()).filter((r) => r.ok && String(r.plaintext.note).startsWith(marker));
  assert.equal(read.length, 40, 'the laptop decrypts every bulk record');
  assert.ok(phone.door.all('care').every((e) => e.by === 'penelope') && laptop.door.all('care').every((e) => e.by === 'penelope'));

  // a shard altered on the server is refused, not merged
  const sealed = phoneMx.sealAttachment(new TextEncoder().encode('x'.repeat(4000)));
  const bad = new Uint8Array(sealed.data); bad[10] ^= 1;
  assert.throws(() => laptopMx.openAttachment(bad, sealed.info));

  // not an own device: a different person's offer is refused
  const cEve = new Courier({ mx: eve, here: 'eve' });
  await T.send(eve, phoneMx.userId, 'peer.offer', { from: 'eve', ids: [] });
  const p4 = await cPhone.pump();
  assert.equal(p4.handled.find((h) => h.from === eve.userId).refused, 'not_own_user');
  for (const m of [eve, laptopMx, phoneMx]) await m.logout();
  t.diagnostic(`bulk: ${bulk.bytes} bytes -> ${bulk.gzBytes} gzipped -> ${bulk.shards} encrypted shards; phone ${phone.door.all('care').length} entries, laptop ${laptop.door.all('care').length}`);
});

test("another person's node reads and writes a network over Matrix alone; after removal even a request sent earlier is refused", { skip }, async () => {
  const sandbox = newSandbox();
  const pw = rnd(12), a = 'ana' + rnd(4), b = 'ben' + rnd(4);
  await TG.register(a, pw); await TG.register(b, pw);
  const ana = await new MatrixDevice(HS).login(a, pw, 'ana phone');
  const ben = await new MatrixDevice(HS).login(b, pw, 'ben laptop');
  const anaNode = await sandboxNode(sandbox, 'ana');
  const net = await Network.open({ mx: ana, store: anaNode.store });
  const cAna = new Courier({ mx: ana, store: anaNode.store, here: 'ana', networks: [net] });
  const cBen = new Courier({ mx: ben, here: 'ben' });
  await net.write({ note: 'allergy: penicillin' });
  await net.invite(ben.userId); await ben.sync(); await ben.join(net.roomId); await ana.sync();
  await net.grant(ben.userId, { history: true });
  const link = new MatrixLink({ mx: ben, courier: cBen, roomId: net.roomId, holder: ana.userId });

  await link.ask(); await cAna.pump(); await cBen.pump();
  const r1 = await link.read();
  assert.deepEqual(r1.records.filter((x) => x.ok).map((x) => x.plaintext.note), ['allergy: penicillin']);

  await ana.sync();
  const ref = await link.write({ note: 'prescribed azithromycin' });
  const h = await cAna.pump();
  assert.equal(h.handled[0].accepted, ref, JSON.stringify(h));
  await cBen.pump();
  assert.equal(cBen.take('net.ack')[0].ok, true);
  assert.equal((await net.read()).filter((x) => x.ok).length, 2);

  // ben asks while ana is offline; ana removes ben before she next handles messages
  await link.ask();
  await net.remove(ben.userId, 'ana closed the network to ben');
  const h2 = await cAna.pump();
  assert.equal(h2.handled[0].refused, 'not_a_member');
  await cBen.pump().catch(() => {});
  assert.deepEqual(await link.read(), { ok: false, reason: 'not_a_member' });
  const late = await link.write({ note: 'late' }).then(() => cAna.pump(), (e) => ({ error: e.message }));
  assert.ok(late.error || late.handled.every((x) => x.refused), JSON.stringify(late));
  assert.equal((await net.records()).length, 2, 'nothing from the removed node was woven');
  await ben.logout(); await ana.logout();
});
