// Which signaling server the end-to-end tests run against.
//   SURFACE_SIGNAL_DIR=<an instance folder made by bin/signal.mjs install>   any installed engine
//   otherwise: the local test Synapse in matrix/ (127.0.0.1:8448)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatrixDevice } from '../lib/matrix.mjs';
import { registerAccount } from '../signal/install.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function target() {
  const dir = process.env.SURFACE_SIGNAL_DIR;
  if (dir) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    const hs = `http://127.0.0.1:${r.port}`;
    const up = await fetch(hs + '/_matrix/client/versions').then((x) => x.ok, () => false);
    return { hs, up, engine: r.engine, register: (u, p) => registerAccount(r, hs, u, p) };
  }
  const hs = process.env.SURFACE_HS || 'http://127.0.0.1:8448';
  const up = await fetch(hs + '/_matrix/client/versions').then((x) => x.ok, () => false);
  const secret = up ? fs.readFileSync(path.join(HERE, '../matrix/data/homeserver.yaml'), 'utf8').match(/registration_shared_secret: "(.*)"/)[1] : null;
  return { hs, up, engine: 'synapse', register: (u, p) => MatrixDevice.registerWithSharedSecret(hs, secret, u, p) };
}
