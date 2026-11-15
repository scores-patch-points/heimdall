// Builds a THROWAWAY demo log so the UI has something to show: node ui/demo-log.mjs <pharos lib> <empty dir>
// Not Penelope, not real data. Real writes go through lib/door.mjs.
import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [lib, dir] = process.argv.slice(2); if (!lib || !dir) { console.error('usage: demo-log.mjs <pharos lib> <dir>'); process.exit(2); }
const P = await import(pathToFileURL(path.resolve(lib)).href);
const h = P.open('heimdall-demo', { dir: path.resolve(dir), writer: 'demo' });
const kind = (name, cell) => P.weave(h, { cell: 'DEF·Figure', kind: 'kind', addr: `kind:${name}`, body: { name, cell } });
kind('database', 'DEF·Pattern'); kind('row', 'INS·Figure'); kind('row-cut', 'SEG·Figure'); kind('pulled', 'INS·Figure'); kind('gap-measured', 'EVA·Pattern');
const pulled = (url, i, value) => P.weave(h, { cell: 'INS·Figure', kind: 'pulled', addr: `pulled:${url.split('/').pop()}-${i}`, body: { source: { url, status: 200, type: 'application/json', sha256: 'x' + i }, value, sealed: false } });
for (let i = 0; i < 5; i++) pulled('https://api.github.com/repos/lerocha/chinook-database', i, { name: 'chinook-database', stargazers_count: 400 + i });
for (let i = 0; i < 3; i++) pulled('https://example.org/customers.json', i, [{ id: i, name: 'A', city: 'London' }]);
const db = (name, tables, witness) => {
  const d = P.weave(h, { cell: 'DEF·Pattern', kind: 'database', addr: `database:${name}`, body: { name, engine: 'sqlite', codec: 'sqlite-rows@1', holds: 'public', tables } });
  return d;
};
const wh = db('warehouse', ['Artist', 'Genre']), sh = db('sheet', ['Artist']);
for (let i = 1; i <= 12; i++) P.weave(h, { cell: 'INS·Figure', kind: 'row', addr: `db:warehouse/Artist/${i}`, of: [wh.id], body: { table: 'Artist', row: { ArtistId: i, Name: 'Artist ' + i, country: 'UK' } }, basis: { witness: { how: 'row present in repo' } } });
for (let i = 1; i <= 5; i++) P.weave(h, { cell: 'INS·Figure', kind: 'row', addr: `db:warehouse/Genre/${i}`, of: [wh.id], body: { table: 'Genre', row: { GenreId: i, Name: 'Genre ' + i } } });
P.weave(h, { cell: 'INS·Figure', kind: 'row', addr: 'db:warehouse/Artist/13', of: [wh.id], body: { table: 'Artist', row: { ArtistId: 13, Name: 'Edited natively' } }, basis: { witness: { how: 'sqlite trigger on Artist' } } });
for (let i = 1; i <= 8; i++) P.weave(h, { cell: 'INS·Figure', kind: 'row', addr: `db:sheet/Artist/${i}`, of: [sh.id], body: { table: 'Artist', row: { ArtistId: i, Name: 'Artist ' + i } } });
const gap = (name, d, a, b, diff) => P.weave(h, { cell: 'EVA·Pattern', kind: 'gap-measured', addr: `gap:${name}`, of: [d.id], body: { held: { a: 18, b: 18 - a, both: 18 - a }, onlyACount: a, onlyBCount: b, values: { checked: 18, differCount: diff }, noDifferenceFound: !a && !b && !diff } });
gap('warehouse', wh, 0, 1, 0); gap('sheet', sh, 10, 0, 0);
console.log('demo log written to', dir);
