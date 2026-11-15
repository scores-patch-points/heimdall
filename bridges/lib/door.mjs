// door.mjs: how the surface reaches the log. It WRITES only through Penelope (feedback: no direct pharos
// writer, no path around her). It READS with the pinned pharos lib opened read-only (frame:false, never weave).
// It knows each by a pointer, never by a sibling repo path in code:
//   PENELOPE_WEAVE_URL      her HTTP mouth (POST /v1/weave/mark)        -> HTTP door
//   PENELOPE_WEAVE_MODULE   her organ module + PENELOPE_WEAVE_SHA256    -> in-process door (tests, one device)
//   pharos pointer          { lib, sha256 } (the file the pharos door writes)
// When Penelope is down the mark is KEPT and COUNTED in <device>/pending.jsonl, never written elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function openDoor({ pointer, logRoot, pendingFile }) {
  const ptr = JSON.parse(fs.readFileSync(pointer, 'utf8'));
  const lib = path.resolve(path.dirname(pointer), ptr.lib);
  if (sha(lib) !== ptr.sha256) throw new Error(`pharos lib ${lib} does not match its pin`);
  const P = await import(pathToFileURL(lib).href);

  let mode = 'off', weaveMark = null, mergeEntries = null, why = 'no Penelope configured';
  if (process.env.PENELOPE_WEAVE_URL) {
    mode = 'http'; why = 'open';
    const base = process.env.PENELOPE_WEAVE_URL.replace(/\/$/, '');
    const post = (route) => async (m) => {
      try { const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) }); return await r.json(); }
      catch (e) { return { ok: false, status: 503, reason: 'penelope_unreachable', detail: String(e.message) }; }
    };
    weaveMark = post('/v1/weave/mark');
    mergeEntries = post('/v1/weave/merge');
  } else if (process.env.PENELOPE_WEAVE_MODULE) {
    const mod = process.env.PENELOPE_WEAVE_MODULE;
    if (process.env.PENELOPE_WEAVE_SHA256 && sha(mod) !== process.env.PENELOPE_WEAVE_SHA256) throw new Error('Penelope module does not match its pin');
    // One loom per door: Penelope keeps her loom in module state, so each door gets its own instance.
    const pen = await import(pathToFileURL(mod).href + '?door=' + encodeURIComponent(logRoot));
    const st = await pen.openLoom({ pointer, dir: logRoot });
    if (!st.on) why = st.why; else {
      mode = 'module'; why = 'open'; weaveMark = async (m) => pen.weaveMark(m);
      if (typeof pen.mergeEntries === 'function') mergeEntries = async (r) => pen.mergeEntries(r);
    }
  }

  const readers = new Map();
  const reader = (log) => {
    if (!readers.has(log)) readers.set(log, P.open(log, { dir: path.join(logRoot, log), writer: 'reader', frame: false }));
    return readers.get(log);
  };
  let pending = 0;

  return {
    mode, why, P,
    async mark(m) {
      if (!weaveMark) return keep(m, { ok: false, status: 503, reason: 'loom_off', detail: why });
      const r = await weaveMark(m);
      if (!r.ok && r.status === 503) return keep(m, r);
      return r;
    },
    entries(log, filter = {}) {
      if (!fs.existsSync(path.join(logRoot, log))) return [];
      return P.fold(reader(log), filter).entries;
    },
    // Another node's entries, joined by union. Only Penelope writes them; without her merge route, refuse.
    async merge(req) {
      if (!mergeEntries) return { ok: false, status: 501, reason: 'penelope_has_no_merge', detail: why };
      return mergeEntries(req);
    },
    // Every entry as stored (declarations and retractions included), for the other side of a merge.
    all(log) { return fs.existsSync(path.join(logRoot, log)) ? P.entries(reader(log)) : []; },
    frontier(log) { return fs.existsSync(path.join(logRoot, log)) ? P.status(reader(log)).frontier : []; },
    get pending() { return pending; },
  };

  function keep(m, r) {
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.appendFileSync(pendingFile, JSON.stringify({ at: new Date().toISOString(), refused: r.reason, mark: m }) + '\n', { mode: 0o600 });
    pending += 1;
    return { ...r, kept: true };
  }
}
