// spawn.mjs: spin up a database node that is linked to a public repo and exchanges with pharos.
//
//   1. resolve the repo ref to a full commit and fetch the schema file at that commit (sha256 recorded)
//   2. build the database from that file
//   3. weave a `database` entry (DEF·Pattern): engine, codec, holds, the repo link, the tracked tables
//   4. bring its existing rows across as `row` entries (of = the database entry)
//   5. install change capture, so native writes in the engine flow back as marks
//   6. measure the gap between the log's view and a fresh node rebuilt from the log alone,
//      and weave it (`gap-measured`, EVA·Pattern). Revisable: every exchange can measure again.
// Then `exchange()` runs both directions: engine changes up through Penelope, new log entries down.
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommit, fetchFile } from '../connectors/github.mjs';
import { markOf, measureGap } from './codec.mjs';
import * as SQL from '../codecs/sqlite.mjs';

const ENGINES = { sqlite: SQL };   // more engines plug in here with the same four calls (CODECS.md section 4)

export async function spawnDatabase({ name, engine = 'sqlite', dir, repo, tables, door, store, log, holds = 'public' }) {
  const E = ENGINES[engine];
  if (!E) throw new Error(`no codec for engine ${engine} yet (CODECS.md lists what each needs)`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('database name must be a plain token');

  const commit = await resolveCommit(repo.repo, repo.ref);
  const { bytes, link } = await fetchFile({ repo: repo.repo, commit, path: repo.path, sha256: repo.sha256 });

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.sqlite`);
  if (fs.existsSync(file)) throw new Error(`${file} exists; a spawned node starts empty (open the existing one instead)`);
  const db = E.open(file);
  let sql = bytes.toString('utf8'); if (sql.charCodeAt(0) === 0xfeff) sql = sql.slice(1);
  db.exec(sql);
  const C = E.codec({ name, holds });

  const dec = await store.append(markOf('database', `database:${name}`, { name, engine, codec: C.name, holds, repo: link, tables },
    { witness: `built from ${link.repo}@${link.commit}:${link.path} (sha256 ${link.sha256})` }));
  if (!dec.ok) throw new Error(`Penelope refused the database declaration: ${dec.reason} ${dec.detail ?? ''}`);

  let imported = 0;
  for (const r of C.rows(db, tables)) {
    const got = await store.append(markOf('row', r.addr, { table: r.table, row: r.row }, { of: [dec.id], witness: `row present in ${link.repo}@${link.commit.slice(0, 12)}:${link.path}` }));
    if (!got.ok) throw new Error(`Penelope refused a row: ${got.reason} ${got.detail ?? ''}`);
    db.prepare('INSERT OR IGNORE INTO _pharos_held(id, addr) VALUES(?,?)').run(got.id, r.addr);
    imported++;
  }
  E.track(db, tables);
  const node = { name, engine, file, db, codec: C, tables, decId: dec.id, link, door, store, log };
  node.gap = await measure(node);
  return { ...node, imported };
}

const entriesFor = (node) => node.door.entries(node.log).filter((e) => (e.kind === 'row' || e.kind === 'row-cut') && e.addr.startsWith(`db:${node.name}/`));

// Gap between this log's view of the database and a fresh node rebuilt from the log alone; values are
// compared against the live engine. Woven as gap-measured; nothing is declared true.
export async function measure(node) {
  const tmp = node.file + `.fresh-${Date.now()}`;
  const fresh = SQL.open(tmp);
  for (const t of node.tables) fresh.exec(node.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t).sql);
  const entriesA = entriesFor(node);
  const live = new Map(node.codec.rows(node.db, node.tables).map((r) => [r.addr, JSON.stringify(r.row)]));
  const outboxSeq = node.db.prepare('SELECT COALESCE(MAX(seq),0) AS s, COUNT(*) AS n FROM _pharos_outbox').get();
  try {
    const gap = await measureGap({
      codec: node.codec, nodeB: fresh, entriesA,
      frontierA: { log: node.log, heads: node.door.frontier(node.log) },
      frontierB: { engine: node.engine, file: path.basename(node.file), outboxSeq: outboxSeq.s, outboxPending: outboxSeq.n },
      compare: async (B) => {
        const rebuilt = new Map(node.codec.rows(B, node.tables).map((r) => [r.addr, JSON.stringify(r.row)]));
        const differ = [];
        for (const k of new Set([...live.keys(), ...rebuilt.keys()])) if (live.get(k) !== rebuilt.get(k)) differ.push({ addr: k, live: live.get(k) ?? null, fromLog: rebuilt.get(k) ?? null });
        return { checked: Math.max(live.size, rebuilt.size), differ };
      },
    });
    const w = await node.store.append(markOf('gap-measured', `gap:${node.name}`, { codec: node.codec.name, ...gap },
      { of: [node.decId], witness: `fresh sqlite node rebuilt from ${entriesA.length} log entries, compared with the live engine` }));
    return { ...gap, id: w.id };
  } finally { fresh.close(); for (const f of [tmp, tmp + '-wal', tmp + '-shm']) fs.rmSync(f, { force: true }); }
}

// What is waiting to cross, each way, without writing anything: native changes not yet woven (up) and
// log entries this engine does not hold (down). This is the watch's probe; `measure` is the full, woven one.
export async function pendingOf(node) {
  const up = node.db.prepare('SELECT COUNT(*) AS n FROM _pharos_outbox').get().n;
  const held = new Set(await node.codec.ids(node.db));
  const down = entriesFor(node).filter((e) => !held.has(e.id)).length;
  return { up, down, open: up + down > 0 };
}

// Both directions. Up: native engine changes -> marks -> Penelope (acked only when woven).
// Down: log entries this engine does not hold yet -> applied.
export async function exchange(node) {
  const latest = new Map();
  for (const e of entriesFor(node)) latest.set(e.addr, e.id);
  const ups = await node.codec.up(node.db, { prior: (addr) => (latest.has(addr) ? [latest.get(addr)] : []) });
  let up = 0, refused = [];
  for (const u of ups) {
    const r = await node.store.append(u.mark);
    if (r.ok) { u.ack(r.id); latest.set(u.mark.addr, r.id); up++; } else refused.push(r.reason);
  }
  const held = new Set(await node.codec.ids(node.db));
  const missing = entriesFor(node).filter((e) => !held.has(e.id));
  await node.codec.down(node.db, missing);
  return { up, down: missing.length, refused };
}
