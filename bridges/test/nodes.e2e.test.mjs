// Two pharos nodes of the same person (phone, laptop) approach each other by union, authorized by
// Matrix cross-signing. Real homeserver; Penelope with the merge route (see test/env.mjs for where pharos
// and Penelope are found).
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
import { penelopeStore } from '../lib/stores.mjs';
import { Network } from '../lib/network.mjs';
import { startServer } from '../lib/server.mjs';
import { syncWithNode, sha256hex } from '../lib/nodesync.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = await target();
const HS = T.hs, up = T.up;

async function node(sandbox, name) {
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, name, 'log'), pendingFile: path.join(sandbox, name, 'pending.jsonl') });
  assert.equal(door.mode, 'module', door.why);
  return { door, store: penelopeStore({ door, log: 'care', by: 'heimdall' }) };
}

test('two devices of one person merge by union; only own cross-signed devices may; the content gap closes', { skip: needs || (!up && 'homeserver not up') }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-nodes-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const user = 'ana' + crypto.randomBytes(4).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
  await T.register(user, pw);
  const benUser = 'ben' + crypto.randomBytes(4).toString('hex');
  await T.register(benUser, pw);

  // the phone: first device, holds the cross-signing keys
  const phoneMx = await new MatrixDevice(HS).login(user, pw, 'ana phone');
  await phoneMx.bootstrapCrossSigning(pw);
  const phone = await node(sandbox, 'phone');
  const net = await Network.open({ mx: phoneMx, store: phone.store });
  const srv = await startServer({ network: net, store: phone.store, nodeName: 'phone' });
  t.after(() => srv.close());

  // the laptop: a second device of the same user, vouched for by the phone
  const laptopMx = await new MatrixDevice(HS).login(user, pw, 'ana laptop');
  await phoneMx.crossSignOwnDevice(laptopMx.deviceId);
  const laptop = await node(sandbox, 'laptop');
  await laptopMx.join(net.roomId);
  const onLaptop = new Network({ mx: laptopMx, store: laptop.store, roomId: net.roomId });

  // each node writes while apart
  assert.ok((await net.write({ note: 'phone: blood pressure 118/76' })).ok);
  await laptopMx.sync();
  assert.ok((await onLaptop.write({ note: 'laptop: uploaded lab result' })).ok);
  await phoneMx.sync(); await laptopMx.sync();

  // sync from the laptop
  const s1 = await syncWithNode({ mx: laptopMx, store: laptop.store, url: srv.url, here: 'laptop', there: 'phone' });
  assert.equal(s1.before.noDifferenceFound, false);
  assert.ok(s1.before.onlyACount > 0 && s1.before.onlyBCount > 0, JSON.stringify(s1.before));
  assert.equal(s1.after.contentGap, 0, JSON.stringify(s1));
  // what is left is only the record of the exchange itself (the phone's own `merged` entry for the push)
  assert.deepEqual(Object.keys({ ...s1.after.onlyAByKind, ...s1.after.onlyBByKind }).sort(), ['merged'], JSON.stringify(s1.after));
  assert.equal(s1.pulled.refused + s1.pushed.refused, 0);

  // both nodes now hold and can read both records
  await phoneMx.sync(); await laptopMx.sync();
  const read = async (s) => (await s.read()).filter((r) => r.ok).map((r) => r.plaintext.note).sort();
  const want = ['laptop: uploaded lab result', 'phone: blood pressure 118/76'];
  assert.deepEqual(await read(net), want);
  assert.deepEqual(await read(onLaptop), want);
  const merged = phone.door.all('care').filter((e) => e.kind === 'merged');
  assert.equal(merged.length, 2, 'one merged entry from each node (the laptop merged the pull, the phone merged the push)');
  assert.ok(phone.door.all('care').every((e) => e.by === 'penelope'), 'Penelope wrote every entry on both nodes');

  // a second sync with nothing new written: the content gap is already zero; only exchange records differ
  const s2 = await syncWithNode({ mx: laptopMx, store: laptop.store, url: srv.url, here: 'laptop', there: 'phone' });
  assert.equal(s2.before.contentGap, 0, JSON.stringify(s2.before));
  assert.ok(s2.before.exchangeRecordsApart > 0);
  assert.equal(s2.after.contentGap, 0);
  t.diagnostic(`exchange records apart after sync 1: ${s1.after.exchangeRecordsApart}, after sync 2: ${s2.after.exchangeRecordsApart}`);

  // refusals
  const signed = async (mx, method, p, body = '') => {
    const pl = { user: mx.userId, device: mx.deviceId, ts: Date.now(), nonce: crypto.randomUUID(), method, path: p, body: await sha256hex(body) };
    const { payload, sigs } = await mx.signPayload(pl);
    const b = (x) => Buffer.from(x).toString('base64url');
    return { 'x-heimdall-request': b(payload), 'x-heimdall-signature': b(sigs) };
  };
  const get = async (headers) => { const r = await fetch(srv.url + '/v1/node/entries', { headers }); return { status: r.status, ...(await r.json()) }; };

  const benMx = await new MatrixDevice(HS).login(benUser, pw, 'ben laptop');
  const d1 = await get(await signed(benMx, 'GET', '/v1/node/entries'));
  assert.deepEqual([d1.status, d1.reason], [403, 'not_own_user']);

  const rogue = await new MatrixDevice(HS).login(user, pw, 'a device nobody vouched for');
  const d2 = await get(await signed(rogue, 'GET', '/v1/node/entries'));
  assert.deepEqual([d2.status, d2.reason], [403, 'device_not_cross_signed']);

  const h = await signed(laptopMx, 'GET', '/v1/node/entries');
  assert.equal((await get(h)).ok, true);
  const d3 = await get(h);
  assert.deepEqual([d3.status, d3.reason], [401, 'replayed']);

  const h2 = await signed(laptopMx, 'POST', '/v1/node/merge', '{"from":"laptop","entries":[]}');
  const r4 = await fetch(srv.url + '/v1/node/merge', { method: 'POST', headers: { ...h2, 'content-type': 'application/json' }, body: '{"from":"laptop","entries":[{"forged":true}]}' });
  assert.deepEqual([r4.status, (await r4.json()).reason], [401, 'body_mismatch']);

  // a tampered entry inside a correctly signed push is refused by Penelope; the rest go in
  const good = phone.door.all('care').find((e) => e.kind === 'sealed-record');
  const forged = { ...good, addr: 'sealed:forged' };
  const body = JSON.stringify({ from: 'laptop', entries: [forged] });
  const h3 = await signed(laptopMx, 'POST', '/v1/node/merge', body);
  const r5 = await (await fetch(srv.url + '/v1/node/merge', { method: 'POST', headers: { ...h3, 'content-type': 'application/json' }, body })).json();
  assert.deepEqual([r5.ok, r5.added, r5.refused[0]?.reason], [true, 0, 'id_mismatch']);

  for (const m of [benMx, rogue, laptopMx, phoneMx]) await m.logout();
  t.diagnostic(`sandbox ${sandbox}; phone ${phone.door.all('care').length} entries, laptop ${laptop.door.all('care').length}`);
});
