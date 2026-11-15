// A database node spun up from a PUBLIC repo at a pinned commit, exchanging with pharos through Penelope.
// Needs the network (GitHub) and Penelope's organ module. Skips without network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDoor } from '../lib/door.mjs';
import { penelopeStore } from '../lib/stores.mjs';
import { spawnDatabase, exchange, measure } from '../lib/spawn.mjs';
import { markOf } from '../lib/codec.mjs';
import { pull } from '../connectors/http.mjs';
import { PHAROS_LIB, needs } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const online = await fetch('https://api.github.com/zen', { headers: { 'user-agent': 'heimdall-test' } }).then((r) => r.ok, () => false);

// Pinned: Chinook sample database, a public MIT-licensed repo. Commit and file hash are the link.
const CHINOOK = { repo: 'lerocha/chinook-database', ref: '7f67772503d71ba90f19283c38e93923addb43fa', path: 'ChinookDatabase/DataSources/Chinook_Sqlite.sql' };

async function setup() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-db-'));
  fs.writeFileSync(path.join(sandbox, 'pharos.json'), JSON.stringify({ lib: PHAROS_LIB, sha256: crypto.createHash('sha256').update(fs.readFileSync(PHAROS_LIB)).digest('hex') }));
  const door = await openDoor({ pointer: path.join(sandbox, 'pharos.json'), logRoot: path.join(sandbox, 'log'), pendingFile: path.join(sandbox, 'pending.jsonl') });
  assert.equal(door.mode, 'module', door.why);
  return { sandbox, door, store: penelopeStore({ door, log: 'dbs', by: 'heimdall' }) };
}

test('spawn a SQLite node from a pinned public repo; native writes flow up; log entries flow down; the gap is measured, not judged', { skip: needs || (!online && 'offline') }, async (t) => {
  const { sandbox, door, store } = await setup();
  const node = await spawnDatabase({ name: 'chinook', dir: path.join(sandbox, 'db'), repo: CHINOOK, tables: ['Genre', 'MediaType', 'Artist'], door, store, log: 'dbs' });
  t.after(() => node.db.close());
  assert.equal(node.imported, 25 + 5 + 275);
  assert.match(node.link.sha256, /^[0-9a-f]{64}$/);
  assert.equal(node.gap.noDifferenceFound, true, JSON.stringify(node.gap).slice(0, 400));

  const decl = door.entries('dbs', { kind: 'database' })[0];
  assert.equal(decl.body.repo.commit, CHINOOK.ref);
  assert.equal(decl.cell, 'DEF·Pattern');

  // native writes in the engine, by any app, with plain SQL
  node.db.exec(`INSERT INTO Genre(GenreId, Name) VALUES (26, 'Field recordings');
                UPDATE Artist SET Name = 'AC/DC (remastered)' WHERE ArtistId = 1;
                INSERT INTO MediaType(MediaTypeId, Name) VALUES (6, 'Wax cylinder');
                DELETE FROM MediaType WHERE MediaTypeId = 6;`);   // MediaType 1-5 are referenced by tracks (foreign keys hold)
  const x1 = await exchange(node);
  assert.deepEqual([x1.up, x1.refused.length], [4, 0], JSON.stringify(x1));
  const ac = door.entries('dbs', { kind: 'row' }).filter((e) => e.addr === 'db:chinook/Artist/1');
  assert.equal(ac.length, 2, 'the update is a new entry at the same address');
  assert.deepEqual(ac[1].of, [ac[0].id], 'and it names the entry it supersedes');
  assert.equal(door.entries('dbs', { kind: 'row-cut' }).length, 1);

  // an entry arriving from another node (woven here through Penelope, not through this engine)
  const other = await store.append(markOf('row', 'db:chinook/Genre/27', { table: 'Genre', row: { GenreId: 27, Name: 'Arrived from another node' } }, { of: [node.decId], witness: 'test: written by another node' }));
  assert.ok(other.ok);
  const x2 = await exchange(node);
  assert.equal(x2.up, 0); assert.ok(x2.down >= 1);
  assert.equal(node.db.prepare('SELECT Name FROM Genre WHERE GenreId=27').get().Name, 'Arrived from another node');

  const again = await exchange(node);
  assert.deepEqual([again.up, again.down], [0, 0], 'a second exchange moves nothing');

  const g2 = await measure(node);
  assert.equal(g2.noDifferenceFound, true, JSON.stringify(g2).slice(0, 400));
  assert.equal(door.entries('dbs', { kind: 'gap-measured' }).length, 2, 'every measurement is its own revisable entry');

  // the gap is real when there is one: a write the exchange has not carried yet shows as a value difference
  node.db.exec(`INSERT INTO Genre(GenreId, Name) VALUES (28, 'Not exchanged yet')`);
  const g3 = await measure(node);
  assert.equal(g3.noDifferenceFound, false);
  assert.equal(g3.values.differCount, 1);
  assert.equal(g3.frontierB.outboxPending, 1);
  t.diagnostic(`sandbox ${sandbox}; entries ${door.entries('dbs').length}`);
});

test('a connector pulls from an outside API into the log with its source and sha256', { skip: needs || (!online && 'offline') }, async () => {
  const { door, store } = await setup();
  const m = await pull(`https://api.github.com/repos/${CHINOOK.repo}/commits/${CHINOOK.ref}`, { label: 'chinook-commit' });
  const r = await store.append(m);
  assert.ok(r.ok, JSON.stringify(r));
  const e = door.entries('dbs', { kind: 'pulled' })[0];
  assert.equal(e.body.value.sha, CHINOOK.ref);
  assert.match(e.basis.witness.sha256, /^[0-9a-f]{64}$/);
  assert.equal(e.by, 'penelope');
});
