// keystore.mjs (Node): the device's key store, kept apart from the log on purpose (DECISIONS-2026-11-14 #5).
//   <dir>/keys/keystore.sealed.json   mode 0600, AES-256-GCM under a key from the passphrase (scrypt)
// In Node the Matrix crypto machine keeps its Olm/Megolm state in memory, so this store is where its
// room keys rest between runs (exportKeys/importKeys). In a browser the machine keeps that state in
// IndexedDB under its own passphrase and this file is not used.
// Destroying a secret here is crypto-shredding for whatever only it could open; copies already
// decrypted elsewhere are not reached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const AAD = Buffer.from('heimdall keystore v1');

export class KeyStore {
  constructor(dir, passphrase) { this.file = path.join(path.resolve(dir), 'keys', 'keystore.sealed.json'); this.pass = passphrase; this.s = {}; if (fs.existsSync(this.file)) this.load(); }
  load() {
    const o = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const key = crypto.scryptSync(this.pass, Buffer.from(o.salt, 'base64'), 32, KDF);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(o.iv, 'base64'));
    d.setAAD(AAD); d.setAuthTag(Buffer.from(o.tag, 'base64'));
    this.s = JSON.parse(Buffer.concat([d.update(Buffer.from(o.ct, 'base64')), d.final()]).toString('utf8'));
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(this.pass, salt, 32, KDF), iv);
    c.setAAD(AAD);
    const ct = Buffer.concat([c.update(JSON.stringify(this.s)), c.final()]);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  get(k) { return this.s[k] ?? null; }
  put(k, v) { this.s[k] = v; this.save(); }
  shred(k) { const had = k in this.s; delete this.s[k]; this.save(); return had; }
}
