// ActivityPub between two of our own actors over real HTTP: webfinger, follow, auto-accept, publish,
// HTTP Signatures verified, activities woven through Penelope, a forged or unsigned post refused,
// a sealed record refused for publishing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Actor, newActorKeys, signRequest } from '../federation/activitypub.mjs';
import { startApServer, noteMark } from '../federation/ap-server.mjs';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore } from '../lib/stores.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function node(sandbox, name) {
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, name, 'log'), pendingFile: path.join(sandbox, name, 'pending.jsonl') });
  assert.equal(door.mode, 'module', door.why);
  const store = penelopeStore({ door, log: 'ap', by: 'heimdall' });
  const placeholder = await startApServer({ actor: { handle: async () => null, base: 'http://127.0.0.1' } });
  const port = placeholder.port; await placeholder.close();
  const actor = new Actor({ base: `http://127.0.0.1:${port}`, name, keys: newActorKeys(), store, acceptFollows: 'auto' });
  const srv = await startApServer({ actor, port });
  return { door, store, actor, srv };
}

test('two pharos actors federate over ActivityPub; every activity is a verified, woven mark', { skip: needs }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-ap-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const ana = await node(sandbox, 'ana'), ben = await node(sandbox, 'ben');
  t.after(async () => { await ana.srv.close(); await ben.srv.close(); });

  // ben follows ana by acct; ana auto-accepts; ben's inbox gets the Accept
  const f = await ben.actor.follow(`acct:ana@${ana.actor.domain}`);
  assert.equal(f.status, 202, f.text);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await ana.actor.followers(), [ben.actor.id]);
  const accepts = ben.door.all('ap').filter((e) => e.kind === 'ap-accept');
  assert.equal(accepts.length, 1); assert.equal(accepts[0].cell, 'EVA·Figure');

  // ana writes a public note and publishes it; ben receives a Create
  const w = await ana.store.append(noteMark('hello from a pharos node'));
  const pub = await ana.actor.publish(w.id);
  assert.ok(pub.ok, JSON.stringify(pub)); assert.equal(pub.sent[0].status, 202, pub.sent[0].text);
  const creates = ben.door.all('ap').filter((e) => e.kind === 'ap-create');
  assert.equal(creates[0].body.activity.object.content, 'hello from a pharos node');
  assert.equal(creates[0].cell, 'INS·Figure');
  assert.match(creates[0].basis.witness.how, /HTTP Signature by .* verified/);
  assert.ok(ben.door.all('ap').every((e) => e.by === 'penelope'));

  // a sealed record (or any kind not listed public) is refused for publishing
  const sealed = await ana.store.append({ kind: 'sealed-record', cell: 'INS·Figure', addr: 'sealed:x', body: { content: 'ciphertext' }, of: [], witness: { how: 'test' }, declare: { why: 'test' } });
  assert.equal((await ana.actor.publish(sealed.id)).reason, 'kind_not_public');

  // unsigned, tampered, and signer-is-not-actor posts are refused
  const inbox = `${ana.actor.base}/ap/inbox`;
  const act = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${ben.actor.base}/ap/activities/x1`, type: 'Like', actor: ben.actor.id, object: 'http://example.invalid/n' };
  const body = JSON.stringify(act);
  const unsigned = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body });
  assert.equal((await unsigned.json()).reason, 'no_signature');
  const h = signRequest({ method: 'POST', url: inbox, body, keyId: ben.actor.keyId, privateKeyPem: ben.actor.keys.privateKeyPem });
  const tampered = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json', ...h }, body: body.replace('Like', 'Flag') });
  assert.equal((await tampered.json()).reason, 'digest_mismatch');
  const forgedActor = JSON.stringify({ ...act, id: act.id + 'b', actor: ana.actor.id });
  const h2 = signRequest({ method: 'POST', url: inbox, body: forgedActor, keyId: ben.actor.keyId, privateKeyPem: ben.actor.keys.privateKeyPem });
  const forged = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json', ...h2 }, body: forgedActor });
  assert.equal((await forged.json()).reason, 'signer_is_not_actor');
  const good = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/activity+json', ...h }, body });
  assert.equal(good.status, 202);
  assert.equal(ana.door.all('ap').filter((e) => e.kind === 'ap-like')[0].cell, 'EVA·Figure');

  // Undo of the follow cuts it: ben is no longer a follower
  const undo = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${ben.actor.base}/ap/activities/undo1`, type: 'Undo', actor: ben.actor.id, object: f.activity };
  const doc = await ben.actor.getJson(ana.actor.id);
  assert.equal((await ben.actor.post(doc.inbox, undo)).status, 202);
  assert.deepEqual(await ana.actor.followers(), []);
});
