// End to end against a REAL homeserver (matrix/README: local Synapse in Docker on 127.0.0.1:8448).
// Skips when the homeserver is not up. Each run uses fresh accounts and a fresh sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MatrixDevice } from '../lib/matrix.mjs';
import { target } from './target.mjs';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore, memoryStore } from '../lib/stores.mjs';
import { Network, Link } from '../lib/network.mjs';
import { startServer } from '../lib/server.mjs';
import { KeyStore } from '../lib/keystore.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = await target();
const HS = T.hs, up = T.up;

async function account(name) {
  const tag = name + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
  await T.register(tag, pw);
  return { user: tag, pw };
}

test('node A opens a network over its data; node B reads and writes while in it; A removes B; B cannot remove A', { skip: needs || (!up && 'homeserver not up') }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, 'node A-phone/log'), pendingFile: path.join(sandbox, 'node A-phone/pending.jsonl') });
  assert.equal(door.mode, 'module', `Penelope must be the weaver: ${door.why}`);

  const aa = await account('ana'), ba = await account('ben');
  const ana = await new MatrixDevice(HS).login(aa.user, aa.pw, 'ana phone');
  const ben = await new MatrixDevice(HS).login(ba.user, ba.pw, 'ben laptop');
  const store = penelopeStore({ door, log: 'care', by: 'heimdall' });
  const net = await Network.open({ mx: ana, store });
  const srv = await startServer({ network: net, store });
  t.after(async () => { await srv.close(); });

  // 1. node A writes before node B is in the team
  const w0 = await net.write({ note: 'allergy: penicillin' });
  assert.ok(w0.ok, JSON.stringify(w0));

  // 2. invite, join, grant with history
  await net.invite(ben.userId); await ben.sync(); await ben.join(net.roomId); await ana.sync();
  const g = await net.grant(ben.userId, { history: true });
  assert.ok(g.ok, JSON.stringify(g));
  const link = new Link({ mx: ben, roomId: net.roomId, holderUrl: srv.url });

  // 3. node B reads, including the record from before they joined (history was granted)
  const r1 = await link.fetch();
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.deepEqual(r1.records.filter((x) => x.ok).map((x) => x.plaintext.note), ['allergy: penicillin']);

  // 4. node B writes into node A's record (submitted to node A's device, not to Matrix)
  await ana.sync();
  const s1 = await link.submit({ note: 'prescribed amoxicillin? NO: allergy. prescribed azithromycin' });
  assert.ok(s1.ok, JSON.stringify(s1));
  await ana.sync();
  const mine = await net.read();
  assert.equal(mine.filter((x) => x.ok).length, 2, JSON.stringify(mine));

  // 5. nothing was ever sent to the room: the room timeline holds only state (membership etc.)
  const msgs = (await ana.api('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(net.roomId)}/messages?dir=b&limit=100`)).json.chunk;
  assert.deepEqual(msgs.filter((e) => e.state_key === undefined), [], 'no non-state events in the care room');

  // 6. node B cannot remove node A
  await assert.rejects(ben.kick(net.roomId, ana.userId, 'try'), (e) => e.status === 403);
  await assert.rejects(ben.ban(net.roomId, ana.userId, 'try'), (e) => e.status === 403);

  // 7. node A removes node B
  const rm = await net.remove(ben.userId, 'ana left the network');
  assert.ok(rm.cut.ok && rm.ep.ok, JSON.stringify(rm));
  await net.write({ note: 'new provider notes' });

  // 8. after removal: no reads, no writes, no keys for the new record
  const r2 = await link.fetch();
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'not_a_member');
  const s2 = await link.submit({ note: 'late note' }).catch((e) => ({ ok: false, reason: e.message }));
  assert.equal(s2.ok, false);
  const all = await net.records();
  const last = all.find((x) => x.sender === ana.userId && x.ts === Math.max(...all.filter((y) => y.sender === ana.userId).map((y) => y.ts)));
  await ben.sync().catch(() => {});
  const leak = await ben.decryptRecord(net.roomId, last);
  assert.equal(leak.ok, false, 'a removed link must hold no key for records written after removal');

  // 9. the canonical log: Penelope wove every mark into pharos on node A's device
  const kinds = door.entries('care').map((e) => e.kind);
  for (const k of ['epoch', 'sealed-record', 'grant', 'revoke']) assert.ok(kinds.includes(k), `pharos has ${k}`);
  const bodies = JSON.stringify(door.entries('care', { kind: 'sealed-record' }).map((e) => e.body));
  assert.ok(!/penicillin|azithromycin|provider/.test(bodies), 'no plaintext in the log');
  assert.ok(door.entries('care').every((e) => e.by === 'penelope'), 'Penelope is the only writer');

  // 10. keys at rest (Node): export room keys into the sealed key store and read them back in a fresh machine
  const ks = new KeyStore(path.join(sandbox, 'node A-phone'), 'correct horse');
  ks.put('megolm', await ana.exportKeys(net.roomId));
  const ks2 = new KeyStore(path.join(sandbox, 'node A-phone'), 'correct horse');
  assert.ok(ks2.get('megolm').includes('session_key'));
  assert.throws(() => new KeyStore(path.join(sandbox, 'node A-phone'), 'wrong'), 'wrong passphrase cannot open the key store');
  assert.ok(!fs.readFileSync(ks.file, 'utf8').includes('session_key'));

  await ben.logout(); await ana.logout();
  t.diagnostic(`sandbox ${sandbox}; pharos entries ${door.entries('care').length}`);
});

test('a browser-style store (memory stands in for OPFS/IDB) drains its marks to Penelope through the device server', { skip: needs || (!up && 'homeserver not up') }, async (t) => {
  const { remoteStore } = await import('../lib/stores.mjs');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, 'log'), pendingFile: path.join(sandbox, 'pending.jsonl') });
  const aa = await account('ana');
  const ana = await new MatrixDevice(HS).login(aa.user, aa.pw, 'ana laptop');
  const store = penelopeStore({ door, log: 'care', by: 'heimdall' });
  const net = await Network.open({ mx: ana, store });
  const srv = await startServer({ network: net, store });
  t.after(() => srv.close());

  const tab = memoryStore();                        // the tab writes while offline
  const tabNet = new Network({ mx: ana, store: tab, roomId: net.roomId });
  await tabNet.write({ note: 'written in the browser while offline' });
  const remote = remoteStore({ url: srv.url, pairingToken: srv.pairingToken });
  const d = await tab.drainTo(remote);
  assert.equal(d.moved, 1, JSON.stringify(d));
  assert.equal((await net.read()).filter((x) => x.ok).length, 1);
  const bad = await fetch(srv.url + '/v1/local/marks', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(bad.status, 401);
  await ana.logout();
});

test('power belongs to whoever opened a network, not to a kind of node: the same two nodes, reversed', { skip: needs || (!up && 'homeserver not up') }, async () => {
  const aa = await account('ana'), ba = await account('ben');
  const ana = await new MatrixDevice(HS).login(aa.user, aa.pw, 'ana phone');
  const ben = await new MatrixDevice(HS).login(ba.user, ba.pw, 'ben laptop');
  const store = memoryStore();
  // ben opens a network over ben's own data and invites ana: here ben holds the power
  const bens = await Network.open({ mx: ben, store });
  await bens.invite(ana.userId); await ana.sync(); await ana.join(bens.roomId);
  await assert.rejects(ana.kick(bens.roomId, ben.userId, 'try'), (e) => e.status === 403, 'ana cannot remove ben from ben\'s network');
  // ana opens a network over ana's data and invites ben: here ana holds the power
  const anas = await Network.open({ mx: ana, store: memoryStore() });
  await anas.invite(ben.userId); await ben.sync(); await ben.join(anas.roomId);
  await assert.rejects(ben.kick(anas.roomId, ana.userId, 'try'), (e) => e.status === 403, 'ben cannot remove ana from ana\'s network');
  // each removes the other from the network it opened
  await bens.remove(ana.userId, 'ben closes ana out of ben\'s network');
  await anas.remove(ben.userId, 'ana closes ben out of ana\'s network');
  assert.deepEqual(await ben.members(bens.roomId), [ben.userId]);
  assert.deepEqual(await ana.members(anas.roomId), [ana.userId]);
  await ana.logout(); await ben.logout();
});
