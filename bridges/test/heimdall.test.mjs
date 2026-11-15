// Heimdall's watch: DEF (declare bridges), EVA (probe, writing nothing), REC (cross once where something waits).
// Database bridge needs the network (public repo); skips offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore } from '../lib/stores.mjs';
import { spawnDatabase } from '../lib/spawn.mjs';
import { Heimdall, databaseBridge, signalBridge } from '../lib/heimdall.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const online = await fetch('https://api.github.com/zen', { headers: { 'user-agent': 'heimdall-test' } }).then((r) => r.ok, () => false);
const CHINOOK = { repo: 'lerocha/chinook-database', ref: '7f67772503d71ba90f19283c38e93923addb43fa', path: 'ChinookDatabase/DataSources/Chinook_Sqlite.sql' };

test('the watch: a quiet tick writes nothing; a waiting bridge is crossed once; a dead bridge is raised, never fixed silently', { skip: needs || (!online && 'offline') }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-watch-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, 'log'), pendingFile: path.join(sandbox, 'pending.jsonl') });
  const store = penelopeStore({ door, log: 'dbs', by: 'heimdall' });
  const db = await spawnDatabase({ name: 'chinook', dir: path.join(sandbox, 'db'), repo: CHINOOK, tables: ['Genre'], door, store, log: 'dbs' });
  t.after(() => db.db.close());

  const h = new Heimdall({ store, node: 'test-node' }).declare('db:chinook', databaseBridge(db));
  const n0 = door.all('dbs').length;
  const quiet = await h.tick();
  assert.equal(quiet.quiet, true);
  assert.equal(door.all('dbs').length, n0, 'a quiet tick weaves nothing');

  db.db.exec(`INSERT INTO Genre(GenreId, Name) VALUES (40, 'Written in the engine')`);
  const t1 = await h.tick();
  assert.equal(t1.report[0].state, 'crossed');
  assert.deepEqual([t1.report[0].before.up, t1.report[0].after.open], [1, false]);
  const watch = door.all('dbs').filter((e) => e.kind === 'watch');
  assert.equal(watch.length, 1); assert.equal(watch[0].cell, 'EVA·Pattern');
  assert.ok(door.all('dbs').some((e) => e.addr === 'db:chinook/Genre/40'), 'the engine write reached pharos');

  // a bridge that cannot close is a finding, crossed once, never looped
  let crossings = 0;
  h.declare('stuck', { kind: 'test', probe: async () => ({ open: true }), cross: async () => { crossings++; return {}; } });
  // a signaling server that does not answer is raised
  h.declare('signal:nowhere', signalBridge('http://127.0.0.1:9'));
  const t2 = await h.tick();
  const by = Object.fromEntries(t2.report.map((r) => [r.bridge, r.state]));
  assert.deepEqual(by, { 'db:chinook': 'quiet', stuck: 'still-open', 'signal:nowhere': 'raised' });
  assert.equal(crossings, 1);
  assert.throws(() => h.declare('bad name', { probe() {} }));
});
