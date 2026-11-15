// stores.mjs: where a device keeps its records. One interface, five homes:
//
//   penelope  Node: every mark is handed to Penelope, who weaves it into this device's pharos log
//   remote    an on-device server (bin/device-server.mjs) over HTTP: a browser tab or another app on
//             the same device uses it, and the server hands marks to Penelope
//   opfs      browser Origin Private File System: an append-only marks.jsonl
//   idb       browser IndexedDB: an object store of marks
//   memory    tests
//
// What is stored is always a MARK (Penelope's WeaveMark@1 shape: kind, cell, addr, body, of, witness)
// whose body for a record is Megolm ciphertext. No home ever holds plaintext.
// Every home is a NODE. None is the truth and none is primary: each holds what it holds, and nodes
// approach one another by EXCHANGE (`exchange(a, b)`: each takes what it lacks from the other; union,
// nothing overwritten, nothing deleted). The browser homes (opfs, idb) do not weave pharos entries
// themselves, because pharos is implemented once (pharos SPEC rule 2) and its lib is Node-only today;
// they keep marks in the same shape and exchange them with a node that has a loom. A browser-only device
// is complete for reading and writing its own records. (An isomorphic pharos core is the real fix, and it
// is a change to pharos itself, not to this surface.)
//
// Interface (all async): append(mark) -> {ok, id?, kept?}; list({kind}) -> [{id, mark}]; drainTo(store); info()

const enc = (o) => JSON.stringify(o);
async function hashMark(mark) {
  const bytes = new TextEncoder().encode(canonical(mark));
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'm:' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const pick = (rows, kind) => (kind ? rows.filter((r) => r.mark.kind === kind) : rows);

// ---------- memory ----------
export function memoryStore() {
  const rows = new Map();
  return {
    home: 'memory',
    async append(mark) { const id = await hashMark(mark); rows.set(id, { id, mark }); return { ok: true, id, local: true }; },
    async list({ kind } = {}) { return pick([...rows.values()], kind); },
    async drainTo(target) { return drain(this, target); },
    async info() { return { home: 'memory', marks: rows.size }; },
  };
}

// ---------- penelope (Node) ----------
// `door` is lib/door.mjs openDoor(): door.mark() goes to Penelope; door.entries() reads pharos read-only.
export function penelopeStore({ door, log, by }) {
  return {
    home: 'penelope', log,
    // node-to-node: every stored entry, and a merge of another pharos node's entries (Penelope writes it)
    async all() { return door.all(log); },
    async merge({ from, entries, witness }) { return door.merge({ by, log, from, entries, witness: { how: witness } }); },
    async frontier() { return door.frontier(log); },
    async append(mark) {
      const r = await door.mark({ ...mark, by, log });
      return r.ok ? { ok: true, id: r.id } : { ok: false, ...r };
    },
    async list({ kind } = {}) {
      return door.entries(log, kind ? { kind } : {}).map((e) => ({ id: e.id, mark: { kind: e.kind, cell: e.cell, addr: e.addr, body: e.body, of: e.of, witness: e.basis?.witness } }))
        .filter((r) => !['frame', 'kind'].includes(r.mark.kind));
    },
    async drainTo() { return { moved: 0 }; },
    async info() { return { home: 'penelope', door: door.mode, why: door.why, pending: door.pending, log }; },
  };
}

// ---------- remote (on-device server) ----------
export function remoteStore({ url, pairingToken }) {
  const base = url.replace(/\/$/, '');
  const h = { 'content-type': 'application/json', authorization: `Bearer ${pairingToken}` };
  return {
    home: 'remote',
    async append(mark) { const r = await fetch(`${base}/v1/local/marks`, { method: 'POST', headers: h, body: enc(mark) }); return r.json(); },
    async list({ kind } = {}) { const r = await fetch(`${base}/v1/local/marks${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`, { headers: h }); return (await r.json()).rows; },
    async drainTo() { return { moved: 0 }; },
    async info() { const r = await fetch(`${base}/v1/local/info`, { headers: h }); return r.json(); },
  };
}

// ---------- OPFS (browser) ----------
export function opfsStore({ dir = 'heimdall', file = 'marks.jsonl' } = {}) {
  const handle = async () => {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir, { create: true });
    return d.getFileHandle(file, { create: true });
  };
  const readAll = async () => {
    const f = await (await handle()).getFile();
    return (await f.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  return {
    home: 'opfs',
    async append(mark) {
      const id = await hashMark(mark);
      if ((await readAll()).some((r) => r.id === id)) return { ok: true, id, local: true };
      const fh = await handle();
      const w = await fh.createWritable({ keepExistingData: true });
      const size = (await fh.getFile()).size;
      await w.seek(size); await w.write(enc({ id, mark, drained: false }) + '\n'); await w.close();
      return { ok: true, id, local: true };
    },
    async list({ kind } = {}) { return pick(await readAll(), kind); },
    async drainTo(target) { return drain(this, target); },
    async info() { const rows = await readAll(); return { home: 'opfs', marks: rows.length }; },
  };
}

// ---------- IndexedDB (browser) ----------
export function idbStore({ name = 'heimdall', store = 'marks' } = {}) {
  const db = () => new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const out = fn(t.objectStore(store)); t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error); }); };
  return {
    home: 'idb',
    async append(mark) { const id = await hashMark(mark); await tx('readwrite', (s) => s.put({ id, mark, drained: false })); return { ok: true, id, local: true }; },
    async list({ kind } = {}) { const all = await tx('readonly', (s) => s.getAll()); return pick(all, kind); },
    async drainTo(target) { return drain(this, target); },
    async info() { return { home: 'idb', marks: (await this.list()).length }; },
  };
}

// One-way: offer every mark `from` holds to `target`. Idempotent (identical content is the same mark).
async function drain(from, target) {
  let moved = 0, refused = [];
  const have = new Set(await Promise.all((await target.list()).map((r) => markKey(r.mark))));
  for (const r of await from.list()) {
    if (have.has(await markKey(r.mark))) continue;
    const got = await target.append(r.mark);
    if (got.ok) moved++; else refused.push({ id: r.id, reason: got.reason });
  }
  return { moved, refused };
}
// Two-way: both nodes end holding the union of what either held. Reports what moved each way and the gap
// left (marks one side refused). Running it again moves nothing unless a node changed in between.
export async function exchange(a, b) {
  const ab = await drain(a, b), ba = await drain(b, a);
  return { aToB: ab.moved, bToA: ba.moved, refused: [...ab.refused, ...ba.refused] };
}
// Identity of a mark across homes: its content without the home-specific witness wrapping.
const markKey = (m) => hashMark({ kind: m.kind, cell: m.cell, addr: m.addr, body: m.body, of: (m.of || []).filter((x) => !String(x).startsWith('m:')) });
