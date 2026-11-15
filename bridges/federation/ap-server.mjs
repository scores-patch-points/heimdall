// federation/ap-server.mjs: serve one node's ActivityPub actor over HTTP. Deliberately separate from the
// device server: a node chooses whether to be an actor at all, and on which address.
import http from 'node:http';
import crypto from 'node:crypto';

export function startApServer({ actor, host = '127.0.0.1', port = 0 }) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const url = new URL(req.url, actor.base);
        const r = await actor.handle(req.method, url, req.headers, req.method === 'POST' ? body : null);
        if (!r) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
        res.writeHead(r.status, { 'content-type': r.type || 'application/json' }); res.end(JSON.stringify(r.json));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message).slice(0, 200) })); }
    });
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) })));
}

// A public note: the only kind an actor publishes by default. Its cell is INS·Figure.
export function noteMark(text) {
  return { kind: 'public-note', cell: 'INS·Figure', addr: 'note:' + crypto.createHash('sha256').update(text + Date.now()).digest('hex').slice(0, 32), body: { text }, of: [], witness: { how: 'written on this node to be published' }, declare: { why: 'a note this node chose to make public (it may be published over ActivityPub)' } };
}
