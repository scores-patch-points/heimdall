// server.mjs: the on-device server of a node (phone, laptop, home box) that holds a network.
//   /v1/records   GET   another node's device asks for this network's ciphertext.  Auth: Matrix device signature.
//   /v1/submit    POST  another node's device hands in a record it Megolm-encrypted. Auth: Matrix device signature.
//   /v1/local/*         this node's own browser tab or apps on this device.   Auth: pairing token.
//   /app/*              static files for the browser surface (lib/, the wasm crypto package)
// Membership is asked of the homeserver at every request, so a kick takes effect on the next request.
// A request is signed with the asking device's Matrix ed25519 key and checked against the key that user's
// homeserver publishes (keys/query), with a timestamp, a nonce and the body's hash. No OpenID, so no
// dependence on a homeserver's federation API; works the same on any homeserver.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nodeHandler, signedRequestChecker } from './nodesync.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' };
const STATIC = [['/app/lib/', path.join(ROOT, 'lib')], ['/app/web/', path.join(ROOT, 'web')], ['/app/node_modules/', path.join(ROOT, 'node_modules')]];

export function startServer({ network, store, pairingToken = crypto.randomBytes(24).toString('base64url'), host = '127.0.0.1', port = 0, log = () => {}, testConfig = null, nodeName = null, extra = null }) {
  const signed = signedRequestChecker(network.mx, { own: false });
  const node = store.merge && nodeName ? nodeHandler({ mx: network.mx, store, here: nodeName }) : null;
  const json = (res, status, o) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-heimdall-request, x-heimdall-signature' }); res.end(JSON.stringify(o)); };
  const raw = (req) => new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 64e6) no(new Error('too large')); }); req.on('end', () => ok(b)); });
  const body = async (req) => { const b = await raw(req); return b ? JSON.parse(b) : {}; };
  const paired = (req) => { const a = req.headers.authorization || ''; return a.length === pairingToken.length + 7 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from('Bearer ' + pairingToken)); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      for (const [prefix, dir] of STATIC) if (url.pathname.startsWith(prefix)) {
        const p = path.resolve(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
        if (!p.startsWith(dir + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return json(res, 404, { ok: false });
        res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
        return fs.createReadStream(p).pipe(res);
      }
      if (url.pathname === '/v1/records' && req.method === 'GET') {
        const c = await signed(req, 'GET', '/v1/records', '');
        if (!c.ok) return json(res, c.status, c);
        const r = await network.serve(c.p.user); log('serve', c.p.user, r.ok);
        return json(res, r.ok ? 200 : r.status, r);
      }
      if (url.pathname === '/v1/submit' && req.method === 'POST') {
        const text = await raw(req);
        const c = await signed(req, 'POST', '/v1/submit', text);
        if (!c.ok) return json(res, c.status, c);
        const r = await network.accept(c.p.user, JSON.parse(text)); log('submit', c.p.user, r.ok, r.reason);
        return json(res, r.ok ? 200 : r.status || 422, r);
      }
      // Test harness only (bin/demo.mjs): hands a same-machine test page its pairing token and a test
      // account. Never on unless testConfig is passed, and only on a loopback host.
      if (url.pathname === '/v1/test-config' && testConfig && host === '127.0.0.1') return json(res, 200, { pairingToken, ...testConfig, room: network.roomId });
      // Extra loopback-only read routes for a harness (bin/showcase.mjs). Off unless passed.
      if (extra && host === '127.0.0.1' && url.pathname.startsWith('/v1/show/')) { const r = await extra(url); if (r) return json(res, 200, r); }
      if (url.pathname.startsWith('/v1/node/')) {
        if (!node) return json(res, 404, { ok: false, reason: 'no_node_sync_here' });
        if (url.pathname === '/v1/node/entries' && req.method === 'GET') { const r = await node.entries(req); log('node-entries', r.ok, r.reason); return json(res, r.ok ? 200 : r.status, r); }
        if (url.pathname === '/v1/node/merge' && req.method === 'POST') { const r = await node.merge(req, await raw(req)); log('node-merge', r.ok, r.reason); return json(res, r.ok ? 200 : r.status || 422, r); }
      }
      if (url.pathname.startsWith('/v1/local/')) {
        if (!paired(req)) return json(res, 401, { ok: false, reason: 'not_paired' });
        if (url.pathname === '/v1/local/marks' && req.method === 'POST') return json(res, 200, await store.append(await body(req)));
        if (url.pathname === '/v1/local/marks' && req.method === 'GET') return json(res, 200, { ok: true, rows: await store.list({ kind: url.searchParams.get('kind') || undefined }) });
        if (url.pathname === '/v1/local/info') return json(res, 200, { ok: true, ...(await store.info()), room: network.roomId });
      }
      return json(res, 404, { ok: false, reason: 'no_route' });
    } catch (e) { return json(res, 500, { ok: false, reason: 'error', detail: String(e.message).slice(0, 200) }); }
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}`, pairingToken, close: () => new Promise((r) => server.close(r)) })));
}
