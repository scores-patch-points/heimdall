// codecs/sqlite.mjs: SQLite (node:sqlite, built into Node 22+) as a node that exchanges with pharos.
//
// down: a `row` entry becomes an upserted row in its table; a `row-cut` entry deletes it. Each applied
//       entry id is kept in _pharos_held(id, addr), which is how this node answers ids().
// up:   triggers on each tracked table write every native INSERT/UPDATE/DELETE into _pharos_outbox while
//       _pharos_ctl.applying = 0, so changes the codec itself applies are never echoed back. up() turns
//       outbox rows into `row` / `row-cut` marks; ack() deletes the outbox row once Penelope wove it.
//       The outbox is a queue, never a store of record.
// Addresses: db:<name>/<table>/<primary key value(s)>. Values are the row as SQLite returns it.
// Loses (see CODECS.md 4.1): column types beyond JSON (BLOBs go as base64), constraints and indexes
// (they live in the linked repo's schema, not in entries), rowid-only tables without a declared key.
import { DatabaseSync } from 'node:sqlite';
import { markOf } from '../lib/codec.mjs';

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

export function open(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS _pharos_ctl(k TEXT PRIMARY KEY, v INTEGER); INSERT OR IGNORE INTO _pharos_ctl VALUES('applying',0);
    CREATE TABLE IF NOT EXISTS _pharos_held(id TEXT PRIMARY KEY, addr TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS _pharos_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, op TEXT, pk TEXT, row TEXT);`);
  return db;
}

export function keyCols(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (!pk.length) throw new Error(`sqlite codec: table ${table} has no primary key; it cannot be addressed`);
  return { cols: cols.map((c) => c.name), pk };
}
const addrOf = (name, table, pkVals) => `db:${name}/${table}/${pkVals.map((v) => encodeURIComponent(String(v))).join(',')}`;

// Install capture triggers on the tracked tables.
export function track(db, tables) {
  for (const t of tables) {
    const { cols, pk } = keyCols(db, t);
    const obj = (p) => `json_object(${cols.map((c) => `'${c.replace(/'/g, "''")}', ${p}.${q(c)}`).join(', ')})`;
    const pkj = (p) => `json_array(${pk.map((c) => `${p}.${q(c)}`).join(', ')})`;
    const when = `WHEN (SELECT v FROM _pharos_ctl WHERE k='applying') = 0`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${q('_px_ins_' + t)} AFTER INSERT ON ${q(t)} ${when} BEGIN INSERT INTO _pharos_outbox(tbl,op,pk,row) VALUES('${t}','put',${pkj('NEW')},${obj('NEW')}); END;
      CREATE TRIGGER IF NOT EXISTS ${q('_px_upd_' + t)} AFTER UPDATE ON ${q(t)} ${when} BEGIN INSERT INTO _pharos_outbox(tbl,op,pk,row) VALUES('${t}','put',${pkj('NEW')},${obj('NEW')}); END;
      CREATE TRIGGER IF NOT EXISTS ${q('_px_del_' + t)} AFTER DELETE ON ${q(t)} ${when} BEGIN INSERT INTO _pharos_outbox(tbl,op,pk,row) VALUES('${t}','cut',${pkj('OLD')},NULL); END;`);
  }
}

export function codec({ name, holds = 'public' }) {
  return {
    name: 'sqlite-rows@1', engine: 'sqlite', holds,
    async down(db, entries) {
      db.exec(`UPDATE _pharos_ctl SET v=1 WHERE k='applying'`);
      try {
        db.exec('BEGIN');
        const seen = db.prepare('SELECT 1 FROM _pharos_held WHERE id=?');
        const hold = db.prepare('INSERT OR IGNORE INTO _pharos_held(id, addr) VALUES(?,?)');
        for (const e of entries) {
          if (seen.get(e.id)) continue;
          const [, tbl] = e.addr.match(/^db:[^/]+\/([^/]+)\//) || [];
          if (!tbl) continue;
          if (e.kind === 'row') {
            const cols = Object.keys(e.body.row);
            db.prepare(`INSERT OR REPLACE INTO ${q(tbl)}(${cols.map(q).join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((c) => e.body.row[c]));
          } else if (e.kind === 'row-cut') {
            const { pk } = keyCols(db, tbl);
            db.prepare(`DELETE FROM ${q(tbl)} WHERE ${pk.map((c) => `${q(c)}=?`).join(' AND ')}`).run(...e.body.pk);
          } else continue;
          hold.run(e.id, e.addr);
        }
        db.exec('COMMIT');
      } catch (err) { db.exec('ROLLBACK'); throw err; }
      finally { db.exec(`UPDATE _pharos_ctl SET v=0 WHERE k='applying'`); }
    },
    async up(db, { prior = () => [] } = {}) {
      return db.prepare('SELECT seq, tbl, op, pk, row FROM _pharos_outbox ORDER BY seq').all().map((o) => {
        const pk = JSON.parse(o.pk), addr = addrOf(name, o.tbl, pk);
        const mark = o.op === 'put'
          ? markOf('row', addr, { table: o.tbl, row: JSON.parse(o.row) }, { of: prior(addr), witness: `sqlite trigger on ${o.tbl} (outbox seq ${o.seq}) in database ${name}` })
          : markOf('row-cut', addr, { table: o.tbl, pk }, { of: prior(addr), witness: `sqlite DELETE on ${o.tbl} (outbox seq ${o.seq}) in database ${name}` });
        return { mark, ack: (id) => { db.prepare('DELETE FROM _pharos_outbox WHERE seq=?').run(o.seq); if (id) db.prepare('INSERT OR IGNORE INTO _pharos_held(id, addr) VALUES(?,?)').run(id, addr); } };
      });
    },
    async ids(db) { return db.prepare('SELECT id FROM _pharos_held').all().map((r) => r.id); },
    // Read every row of the tracked tables as {addr, row} (for importing an existing database, and for comparing values).
    rows(db, tables) {
      const out = [];
      for (const t of tables) {
        const { pk } = keyCols(db, t);
        for (const r of db.prepare(`SELECT * FROM ${q(t)}`).all()) out.push({ table: t, addr: addrOf(name, t, pk.map((c) => r[c])), row: { ...r } });
      }
      return out;
    },
  };
}
