// signal/install.mjs: install a signaling server for yourself. Same shape as pharos's doors:
//   plan    (default) says what would happen; changes nothing
//   apply   pulls the pinned image, writes config under --dir, starts one container, makes the owner's account
//   verify  exit 0 only if the server answers and the owner can log in
//   status  not-installed | stopped | running, from the instance record
//   undo    stops and removes the container this install created; keeps --dir (your server's data and keys)
//           unless --purge, which deletes the data too and cannot be undone
// Everything it creates is recorded in <dir>/instance.json. It binds 127.0.0.1 only; exposing a server to
// the internet (a domain, TLS, a reverse proxy) is a separate, deliberate step it does not take for you.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ENGINES } from './engines.mjs';
import { MatrixDevice } from '../lib/matrix.mjs';

const TOKEN = /^[A-Za-z0-9._-]+$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/;

export function dockerRunner() {
  const sock = [process.env.DOCKER_HOST, `unix://${os.homedir()}/.colima/default/docker.sock`, 'unix:///var/run/docker.sock']
    .find((h) => h && (!h.startsWith('unix://') || fs.existsSync(h.slice(7))));
  // public images only, so an empty client config avoids depending on whatever credential helper is configured
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-dockercfg-'));
  fs.writeFileSync(path.join(cfg, 'config.json'), '{}');
  const env = { ...process.env, DOCKER_CONFIG: cfg, ...(sock ? { DOCKER_HOST: sock } : {}) };
  return (args, { allowFail = false } = {}) => new Promise((ok, no) => {
    const p = spawn('docker', args, { env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 || allowFail ? ok({ code, out: out.trim(), err: err.trim() }) : no(new Error(`docker ${args[0]}: ${err.trim() || out.trim()}`))));
  });
}

const rec = (dir) => path.join(dir, 'instance.json');
const readRec = (dir) => (fs.existsSync(rec(dir)) ? JSON.parse(fs.readFileSync(rec(dir), 'utf8')) : null);
const writeRec = (dir, r) => fs.writeFileSync(rec(dir), JSON.stringify(r, null, 2), { mode: 0o600 });

export function plan({ engine, dir, name, port, owner = 'owner', federation = false, network = null }) {
  const E = ENGINES[engine];
  const problems = [];
  if (!E) problems.push(`unknown engine ${engine}; known: ${Object.keys(ENGINES).join(', ')}`);
  if (!dir) problems.push('--dir is required (a folder you own; it will hold your server\'s data and keys)');
  if (!name || !HOSTNAME.test(name)) problems.push('--name must be a server name like chat.example.org or ana.test');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) problems.push('--port must be 1024-65535');
  if (!TOKEN.test(owner)) problems.push('--owner must be a plain user name');
  if (dir && readRec(path.resolve(dir))) problems.push(`${dir} already has an instance (status, verify or undo it)`);
  const container = `heimdall-signal-${engine}-${crypto.createHash('sha256').update(path.resolve(dir || '.')).digest('hex').slice(0, 8)}`;
  return {
    ok: !problems.length, problems,
    steps: E ? [
      `pull ${E.image} (pinned)`,
      `write config and data under ${path.resolve(dir || '.')}/data`,
      `start container ${container} on 127.0.0.1:${port}${network ? ` (docker network ${network})` : ''}`,
      `create the first account @${owner}:${name}; its password is written to ${path.resolve(dir || '.')}/owner-account.json (mode 0600)`,
      federation ? 'federation ON: other servers can reach this one only once you give it a reachable name and TLS' : 'federation OFF: only accounts on this server can form networks here',
    ] : [],
    container, engine, image: E?.image,
  };
}

export async function apply(opts) {
  const p = plan(opts);
  if (!p.ok) return { ok: false, reason: 'plan_refused', problems: p.problems };
  const E = ENGINES[opts.engine], dir = path.resolve(opts.dir), docker = opts.docker || dockerRunner();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });
  const r = { v: 1, engine: opts.engine, image: E.image, name: opts.name, port: opts.port, container: p.container, owner: opts.owner || 'owner', federation: !!opts.federation, network: opts.network || null, created: new Date().toISOString(), steps: [] };
  writeRec(dir, r);
  await docker(['pull', E.image]); r.steps.push('pulled');
  const conf = await E.configure({ docker, dir, name: opts.name, federation: !!opts.federation, ...(opts.extraConfig || {}) });
  r.registration = conf.registration; r.steps.push('configured'); writeRec(dir, r);
  await docker(['rm', '-f', p.container], { allowFail: true });
  await docker(['run', '-d', '--name', p.container, ...(opts.network ? ['--network', opts.network, '--network-alias', opts.name.split(':')[0]] : []),
    '-p', `127.0.0.1:${opts.port}:${E.internalPort}`, ...E.runArgs({ dir, name: opts.name, federation: !!opts.federation, registration: conf.registration }), E.image]);
  r.steps.push('started'); writeRec(dir, r);
  const hs = `http://127.0.0.1:${opts.port}`;
  if (!(await waitUp(hs))) return { ok: false, reason: 'server_did_not_answer', hs };
  const password = crypto.randomBytes(18).toString('base64url');
  await registerAccount(r, hs, r.owner, password);
  fs.writeFileSync(path.join(dir, 'owner-account.json'), JSON.stringify({ hs, user: r.owner, userId: `@${r.owner}:${opts.name}`, password }, null, 2), { mode: 0o600 });
  r.steps.push('owner-account'); writeRec(dir, r);
  return { ok: true, hs, userId: `@${r.owner}:${opts.name}`, dir, container: p.container };
}

export async function waitUp(hs, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await fetch(hs + '/_matrix/client/versions').then((x) => x.ok, () => false)) return true;
    await new Promise((s) => setTimeout(s, 1000));
  }
  return false;
}

// Make an account on an installed server, by whichever registration that engine uses.
export async function registerAccount(r, hs, user, password) {
  if (r.registration.kind === 'synapse-shared-secret') return MatrixDevice.registerWithSharedSecret(hs, r.registration.secret, user, password);
  if (r.registration.kind === 'registration-token') return MatrixDevice.registerWithToken(hs, r.registration.token, user, password);
  throw new Error(`no registration for ${r.registration.kind}`);
}

export async function verify({ dir }) {
  dir = path.resolve(dir);
  const r = readRec(dir);
  if (!r) return { ok: false, reason: 'not_installed' };
  const acct = JSON.parse(fs.readFileSync(path.join(dir, 'owner-account.json'), 'utf8'));
  if (!(await waitUp(acct.hs, 5))) return { ok: false, reason: 'not_answering', hs: acct.hs };
  try { const d = await new MatrixDevice(acct.hs).login(acct.user, acct.password, 'heimdall verify'); const who = d.userId; await d.logout(); return { ok: true, hs: acct.hs, owner: who, engine: r.engine }; }
  catch (e) { return { ok: false, reason: 'owner_cannot_log_in', detail: e.message }; }
}

export async function status({ dir, docker = dockerRunner() }) {
  const r = readRec(path.resolve(dir));
  if (!r) return { state: 'not-installed' };
  const ps = await docker(['inspect', '-f', '{{.State.Running}}', r.container], { allowFail: true });
  return { state: ps.code !== 0 ? 'container-missing' : ps.out === 'true' ? 'running' : 'stopped', engine: r.engine, name: r.name, port: r.port, container: r.container };
}

export async function undo({ dir, purge = false, docker = dockerRunner() }) {
  dir = path.resolve(dir);
  const r = readRec(dir);
  if (!r) return { ok: true, note: 'nothing installed here' };
  await docker(['rm', '-f', r.container], { allowFail: true });
  if (purge) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: true, removed: [r.container, dir] }; }
  fs.renameSync(rec(dir), rec(dir) + `.undone-${Date.now()}`);
  return { ok: true, removed: [r.container], kept: dir };
}
