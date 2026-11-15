#!/usr/bin/env node
// Heimdall UI: sources -> the kept record -> destinations, drawn from a pharos log.
//   node ui/serve.mjs --pharos <path to pharos lib/pharos.mjs> --dir <log dir> [--port 7420]
// Heimdall is ignorant of siblings: the pharos lib is passed in by pointer, never found by path here.
// Nothing weaves unless started with --write; "Add source" previews a pull first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pull, PULLED } from '../connectors/http.mjs';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
// Read-only by default:  --pharos <lib/pharos.mjs> --dir <log dir>
// To write add --write [--writer heimdall]. Heimdall then weaves its OWN entries straight into its own file in
// that log (no repo reports to another; each writes what it did and reads the rest from the log). Verdicts
// (equivalence, DEF/EVA/REC judgements) are not Heimdall's to write: it only records what it pulled.
if (!args.pharos || !args.dir) { console.error('usage: node ui/serve.mjs --pharos <pharos/lib/pharos.mjs> --dir <log dir> [--write] [--writer heimdall] [--port 7420]'); process.exit(2); }
const P = await import(pathToFileURL(path.resolve(args.pharos)).href);
const dir = path.resolve(args.dir), port = Number(args.port || 7420);
const token = crypto.randomBytes(16).toString('hex');
const WRITER = String(args.writer || 'heimdall');
let wh = null; // the writing handle, opened only on the first write (open() may write the frame of a brand-new log)
const door = args.write ? { mode: 'direct', why: `weaves as writer "${WRITER}"` } : { mode: 'off', why: 'started without --write' };
const store = args.write ? { async append(mark) {
  try {
    wh ||= P.open(args.name || 'heimdall', { dir, writer: WRITER });
    if (!P.ground(wh).kinds.find((k) => k.name === mark.kind)) {
      if (!mark.declare?.why) return { ok: false, reason: 'undeclared_kind', detail: mark.kind };
      P.weave(wh, { cell: 'DEF·Figure', kind: 'kind', addr: `kind:${mark.kind}`, body: { name: mark.kind, cell: mark.cell, why: mark.declare.why, declared_by: WRITER } });
    }
    const e = P.weave(wh, { cell: mark.cell, kind: mark.kind, addr: mark.addr, body: mark.body, of: mark.of ?? [], basis: { witness: mark.witness } });
    return { ok: true, id: e.id };
  } catch (err) { return { ok: false, status: 422, reason: String(err.code || 'refused').toLowerCase(), detail: err.message }; }
} } : null;
fs.mkdirSync(dir, { recursive: true });
const h = P.open(args.name || 'heimdall', { dir, writer: 'heimdall-ui-reader', frame: false });

let cache = null;
const stamp = () => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => { const s = fs.statSync(path.join(dir, f)); return f + s.size + s.mtimeMs; }).join('|');
const snap = () => { const st = stamp(); if (cache?.st === st) return cache; cache = { st, f: P.fold(h), g: P.ground(h) }; return cache; };
const host = (u) => { try { return new URL(u).host; } catch { return String(u); } };
const sample = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '' : s.length > 60 ? s.slice(0, 60) + '…' : s; };

function canvas() {
  const { f, g } = snap(); const E = f.entries;
  const kinds = new Map(); for (const e of E) { const k = kinds.get(e.kind) || { name: e.kind, cell: e.cell, n: 0 }; k.n++; kinds.set(e.kind, k); }
  // sources: every `pulled` mark grouped by where it came from
  const src = new Map();
  for (const e of E.filter((x) => x.kind === 'pulled')) {
    const so = e.body?.source || {}, u = so.url || `${so.system || 'intake'}:${so.workflow || e.addr}`, k = so.system ? `${so.system}: ${so.workflowName || so.workflow}` : host(u);
    const s = src.get(k) || { name: k, kind: 'pulled', n: 0, last: '', urls: new Set(), bytes: 0 };
    s.n++; s.urls.add(u); if (e.at > s.last) s.last = e.at; src.set(k, s);
  }
  // destinations: each declared database node, and what the latest gap measure said about it
  const dests = E.filter((x) => x.kind === 'database').map((d) => {
    const name = d.body.name, mine = E.filter((x) => x.addr.startsWith(`db:${name}/`));
    const gaps = E.filter((x) => x.kind === 'gap-measured' && x.addr === `gap:${name}`).sort((a, b) => (a.at < b.at ? -1 : 1));
    const gap = gaps.at(-1)?.body || null;
    const up = mine.filter((x) => /trigger|DELETE/.test(x.basis?.witness?.how || x.basis?.witness || '')).length;
    return { id: d.id, name, engine: d.body.engine, codec: d.body.codec, holds: d.body.holds, tables: d.body.tables, repo: d.body.repo,
      rows: mine.filter((x) => x.kind === 'row').length, cuts: mine.filter((x) => x.kind === 'row-cut').length, writesBack: up > 0,
      gap: gap && { held: gap.held, onlyA: gap.onlyACount, onlyB: gap.onlyBCount, differ: gap.values?.differCount, ok: gap.noDifferenceFound, measures: gaps.length, at: gaps.at(-1).at } };
  });
  return { intake: { on: !!INTAKE_TOKEN, url: `http://127.0.0.1:${port}/api/intake` }, door, dir, frame: P.frame(h), entries: E.length, conflicts: f.conflicts.length, kinds: [...kinds.values()].sort((a, b) => b.n - a.n),
    sources: [...src.values()].map((s) => ({ ...s, urls: [...s.urls].slice(0, 5) })), dests,
    columns: columnsByTable(E) };
}
// columns a destination table is known to have, from the rows it holds
function columnsByTable(E) {
  const out = {}; for (const e of E) if (e.kind === 'row' && e.body?.row) { const k = e.addr.split('/').slice(0, 2).join('/'); (out[k] ||= new Set()); Object.keys(e.body.row).forEach((c) => out[k].add(c)); }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

// Preview a pull: fetch it, show the fields, and say where each would land. Weaves nothing.
async function preview(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs');
  const m = await pull(url, { maxBytes: 1_000_000 });
  const v = m.body.value; const rec = Array.isArray(v) ? v[0] : (v && typeof v === 'object' ? v : null);
  const cols = canvas().columns, known = new Map(); for (const [t, cs] of Object.entries(cols)) for (const c of cs) (known.get(c.toLowerCase()) || known.set(c.toLowerCase(), []).get(c.toLowerCase())).push(t);
  const fields = rec && !rec.text && !rec.base64 ? Object.entries(rec).map(([k, x]) => ({ field: k, sample: sample(x), homes: known.get(k.toLowerCase()) || [] })) : [];
  return { url, status: m.body.source.status, type: m.body.source.type, sha256: m.body.source.sha256, addr: m.addr, kind: m.kind, cell: m.cell,
    shape: Array.isArray(v) ? `list of ${v.length}` : rec ? 'one record' : 'text or bytes', fields, how: m.witness.how, wouldWeave: 1 };
}

// ---- intake: any workflow tool (n8n, Node-RED, Activepieces, curl) posts items here. Contract in ui/INTAKE.md.
const INTAKE_TOKEN = process.env.HEIMDALL_INTAKE_TOKEN || '';
const SECRETISH = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[-_]?secret|secret[-_]?key|private[-_]?key|token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|bearer|x-api-key)$/i;
const secretPath = (v, p = '$', depth = 0) => { if (depth > 8 || v == null || typeof v !== 'object') return null; for (const [k, x] of Object.entries(v)) { if (SECRETISH.test(k)) return `${p}.${k}`; const r = secretPath(x, `${p}.${k}`, depth + 1); if (r) return r; } return null; };
const readBody = (req, max = 2_000_000) => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', (b) => { n += b.length; if (n > max) { no(new Error('body over 2 MB')); req.destroy(); } else c.push(b); }); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });
const tokenOk = (given) => INTAKE_TOKEN && given && given.length === INTAKE_TOKEN.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(INTAKE_TOKEN));
async function intake(req) {
  const raw = await readBody(req); let b; try { b = JSON.parse(raw.toString('utf8')); } catch { return [400, { error: 'body must be JSON' }]; }
  const so = b.source || {}; const tool = String(so.system || '').slice(0, 40), wf = String(so.workflow || '').slice(0, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(tool) || !wf) return [400, { error: 'source.system (a plain token) and source.workflow are required' }];
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 500) return [400, { error: 'items must be a list of 1 to 500' }];
  const out = []; const bodySha = crypto.createHash('sha256').update(raw).digest('hex');
  for (const [i, it] of b.items.entries()) {
    if (it == null || typeof it !== 'object' || !('value' in it)) return [400, { error: `items[${i}] needs a "value" (and a stable "key")`, accepted: 0 }];
    const bad = secretPath(it.value) || secretPath(so); if (bad) return [422, { error: `refused: something that looks like a credential at ${bad}. Strip it in the workflow; secrets stay in the tool.`, accepted: 0 }];
  }
  for (const it of b.items) {
    const key = String(it.key ?? crypto.createHash('sha256').update(JSON.stringify(it.value)).digest('hex')), kh = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
    const valSha = crypto.createHash('sha256').update(JSON.stringify(it.value)).digest('hex');
    const clean = (x) => JSON.parse(JSON.stringify(x)); // pharos refuses undefined
    const mark = { kind: PULLED.kind, cell: PULLED.cell, addr: `pulled:${tool}/${wf}/${kh}`, of: [], // the key is hashed: it may be personal
      body: { source: { system: tool, workflow: wf, workflowName: so.workflowName, workflowVersion: so.workflowVersion, execution: so.execution, sha256: valSha, status: 200, type: 'application/json' }, value: it.value, sealed: false },
      witness: { how: `${tool} workflow ${wf}${so.execution ? ' execution ' + so.execution : ''} posted this item; request body sha256 ${bodySha}; item sha256 ${valSha}` }, declare: { why: PULLED.why } };
    const r = await store.append({ ...mark, body: clean(mark.body) }); out.push(r.ok ? { ok: true, id: r.id } : { ok: false, reason: r.reason, kept: !!r.kept });
  }
  const ok = out.filter((x) => x.ok).length;
  return [ok === out.length ? 200 : 502, { accepted: ok, refused: out.length - ok, results: out, requestSha256: bodySha }];
}

const json = (res, c, v) => { res.writeHead(c, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if ((req.headers.host || '').split(':')[0] !== '127.0.0.1') return json(res, 403, { error: 'loopback only' });
    if (req.method === 'POST' && u.pathname === '/api/intake') { // non-browser clients: shared token instead of same-origin
      if (!INTAKE_TOKEN) return json(res, 403, { error: 'intake is off: start with HEIMDALL_INTAKE_TOKEN set' });
      if (!tokenOk(req.headers['x-heimdall-token'])) return json(res, 401, { error: 'bad token' });
      if (door.mode === 'off') return json(res, 409, { error: `writing is off: ${door.why}` });
      const [code, body] = await intake(req); return json(res, code, body);
    }
    if (req.method === 'POST' && u.pathname === '/api/pull') { // Start reading: pull once, weave one entry.
      if (door.mode === 'off') return json(res, 409, { error: `writing is off: ${door.why}` });
      if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['x-heimdall-token'] !== token) return json(res, 403, { error: 'same-origin and token required' });
      const url = u.searchParams.get('url') || ''; if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: 'only http(s) URLs' });
      const r = await store.append(await pull(url, { maxBytes: 1_000_000 }));
      return json(res, r.ok ? 200 : (r.status || 502), r.ok ? { ok: true, id: r.id } : { ok: false, reason: r.reason, detail: r.detail, kept: !!r.kept });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('__TOKEN__', token)); }
    if (u.pathname === '/api/canvas') return json(res, 200, canvas());
    if (u.pathname === '/api/preview') { // a GET that makes this process fetch a URL: same-origin page only
      if (req.headers['sec-fetch-site'] !== 'same-origin') return json(res, 403, { error: 'same-origin only' });
      return json(res, 200, await preview(u.searchParams.get('url') || ''));
    }
    json(res, 404, { error: 'no route' });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(port, '127.0.0.1', () => console.log(`heimdall ui: http://127.0.0.1:${port}  (reading ${dir}, ${door.mode === 'direct' ? 'writing as ' + WRITER : 'read-only'})`));
