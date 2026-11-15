#!/usr/bin/env node
// heimdall signal: install your own signaling server, so your nodes depend on nobody else's.
//   node bin/signal.mjs install <synapse|conduit> --dir <folder> --name <server name> --port <port> [--owner <user>] [--federation] [--apply]
//   node bin/signal.mjs verify  --dir <folder>
//   node bin/signal.mjs status  --dir <folder>
//   node bin/signal.mjs undo    --dir <folder> [--purge]
//   node bin/signal.mjs engines
// Without --apply, install only prints the plan. Exit codes: 0 ok, 1 failed, 2 usage or refused plan.
import { plan, apply, verify, status, undo } from '../signal/install.mjs';
import { ENGINES } from '../signal/engines.mjs';

const a = process.argv.slice(2);
const flag = (k) => a.includes(k);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const out = (o, code = 0) => { console.log(JSON.stringify(o, null, 2)); process.exit(code); };
const [cmd, engine] = a;
try {
  if (cmd === 'engines') out(Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, v.image])));
  if (cmd === 'install') {
    const o = { engine, dir: opt('--dir'), name: opt('--name'), port: Number(opt('--port')), owner: opt('--owner') || 'owner', federation: flag('--federation') };
    const p = plan(o);
    if (!p.ok) out(p, 2);
    if (!flag('--apply')) out({ plan: p.steps, note: 'nothing changed; add --apply to do it' });
    const r = await apply(o); out(r, r.ok ? 0 : 1);
  }
  if (cmd === 'verify') { const r = await verify({ dir: opt('--dir') }); out(r, r.ok ? 0 : 1); }
  if (cmd === 'status') out(await status({ dir: opt('--dir') }));
  if (cmd === 'undo') out(await undo({ dir: opt('--dir'), purge: flag('--purge') }));
  out({ usage: 'install <engine> --dir D --name N --port P [--apply] | verify --dir D | status --dir D | undo --dir D [--purge] | engines' }, 2);
} catch (e) { out({ ok: false, error: e.message }, 1); }
