#!/usr/bin/env node
// Test harness: one node A with a Node device (Penelope + pharos) and a device server that also serves
// the browser node page at /app/web/index.html. Uses fresh accounts on the LOCAL test homeserver only.
//   node bin/demo.mjs [--port 8790]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MatrixDevice } from '../lib/matrix.mjs';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore } from '../lib/stores.mjs';
import { Network } from '../lib/network.mjs';
import { startServer } from '../lib/server.mjs';
import { PHAROS_LIB, needs } from '../test/env.mjs';
if (needs) throw new Error(needs);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HS = process.env.SURFACE_HS || 'http://127.0.0.1:8448';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(HS)) throw new Error('demo runs against a local test homeserver only');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8790;
const secret = fs.readFileSync(path.join(HERE, '../matrix/data/homeserver.yaml'), 'utf8').match(/registration_shared_secret: "(.*)"/)[1];

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-demo-'));
const lib = PHAROS_LIB;
fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib, sha256: crypto.createHash('sha256').update(fs.readFileSync(lib)).digest('hex') }));
const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, 'log'), pendingFile: path.join(sandbox, 'pending.jsonl') });
const user = 'anademo' + crypto.randomBytes(3).toString('hex'), pw = crypto.randomBytes(12).toString('hex');
await MatrixDevice.registerWithSharedSecret(HS, secret, user, pw);
const mx = await new MatrixDevice(HS).login(user, pw, 'ana home server');
const store = penelopeStore({ door, log: 'care', by: 'heimdall' });
const net = await Network.open({ mx, store });
const srv = await startServer({ network: net, store, port, testConfig: { hs: HS, user, pw, cryptoPass: crypto.randomBytes(12).toString('hex') } });
console.log(JSON.stringify({ url: srv.url + '/app/web/index.html', sandbox, door: door.mode }));
setInterval(async () => {
  try { await mx.sync(); const r = await net.read(); console.log(JSON.stringify({ at: new Date().toISOString(), pharosEntries: door.entries('care').length, records: r.map((x) => (x.ok ? x.plaintext.note : 'locked')) })); }
  catch (e) { console.log('tick error', e.message); }
}, 4000);
