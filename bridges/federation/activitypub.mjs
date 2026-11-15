// federation/activitypub.mjs: ActivityPub as one more codec between pharos and the outside.
//
// A node can be an ActivityPub actor. Activities that arrive in its inbox become marks (woven by Penelope,
// with the sender's verified HTTP Signature as the witness). Entries the node CHOOSES to publish go out
// as activities. Sealed records never leave: only kinds the node lists as public can be published.
//
// The verb-to-cell map is a declared codec choice (a proposal for the EOQL session), not a fact:
//   Create INS·Figure   Update DEF·Figure   Delete SEG·Figure (a cut; the Tombstone stays, nothing is erased)
//   Follow CON·Figure   Accept/Reject/Like/Flag EVA·Figure   Undo SEG·Figure (cuts the activity it names)
//   Announce SIG·Figure (a boost is attention pointed at a thing)   Block SEG·Pattern   Add CON·Pattern
//   Remove SEG·Pattern  Move REC·Pattern   anything else: NUL·Figure (held as received, not interpreted)
// Addresses are opaque (sha256 of the activity or object id); ids and actors stay in the body only.
// HTTP Signatures: draft-cavage rsa-sha256 over (request-target) host date digest, the form Mastodon,
// GoToSocial and most of the fediverse use.
import crypto from 'node:crypto';

export const VERBS = {
  Create: 'INS·Figure', Update: 'DEF·Figure', Delete: 'SEG·Figure', Follow: 'CON·Figure', Accept: 'EVA·Figure',
  Reject: 'EVA·Figure', Undo: 'SEG·Figure', Announce: 'SIG·Figure', Like: 'EVA·Figure', Block: 'SEG·Pattern',
  Add: 'CON·Pattern', Remove: 'SEG·Pattern', Move: 'REC·Pattern', Flag: 'EVA·Figure',
};
const kindOf = (type) => (VERBS[type] ? 'ap-' + type.toLowerCase() : 'ap-other');
const cellOf = (type) => VERBS[type] || 'NUL·Figure';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const addrOf = (id) => 'ap:' + sha(id).slice(0, 32);
const AS = 'https://www.w3.org/ns/activitystreams';
const AP_TYPES = 'application/activity+json';

// ---------- HTTP Signatures (draft-cavage-http-signatures, rsa-sha256) ----------
export function signRequest({ method, url, body, keyId, privateKeyPem }) {
  const u = new URL(url);
  const date = new Date().toUTCString();
  const digest = body != null ? 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64') : null;
  const names = ['(request-target)', 'host', 'date', ...(digest ? ['digest'] : [])];
  const values = { '(request-target)': `${method.toLowerCase()} ${u.pathname}${u.search}`, host: u.host, date, digest };
  const signingString = names.map((n) => `${n}: ${values[n]}`).join('\n');
  const signature = crypto.sign('sha256', Buffer.from(signingString), privateKeyPem).toString('base64');
  return { date, ...(digest ? { digest } : {}), signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"` };
}

export function parseSignature(h) {
  const out = {};
  for (const m of String(h || '').matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

// Verify an incoming request. `fetchKey(keyId)` returns { pem, owner } (owner = the actor id the key belongs to).
export async function verifyRequest({ method, path, headers, body, fetchKey, maxSkewMs = 12 * 60 * 60 * 1000 }) {
  const sig = parseSignature(headers.signature);
  if (!sig.keyId || !sig.signature || !sig.headers) return { ok: false, reason: 'no_signature' };
  const names = sig.headers.split(' ');
  if (!names.includes('(request-target)') || !names.includes('date')) return { ok: false, reason: 'signature_too_narrow' };
  if (body != null && !names.includes('digest')) return { ok: false, reason: 'body_not_signed' };
  if (body != null) {
    const want = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
    if (headers.digest !== want) return { ok: false, reason: 'digest_mismatch' };
  }
  const when = Date.parse(headers.date);
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > maxSkewMs) return { ok: false, reason: 'stale_date' };
  const signingString = names.map((n) => (n === '(request-target)' ? `(request-target): ${method.toLowerCase()} ${path}` : `${n}: ${headers[n]}`)).join('\n');
  let key; try { key = await fetchKey(sig.keyId); } catch (e) { return { ok: false, reason: 'key_unreachable', detail: e.message }; }
  if (!key?.pem) return { ok: false, reason: 'no_key' };
  const good = crypto.verify('sha256', Buffer.from(signingString), key.pem, Buffer.from(sig.signature, 'base64'));
  return good ? { ok: true, keyId: sig.keyId, owner: key.owner } : { ok: false, reason: 'bad_signature' };
}

// ---------- the codec: activity <-> mark ----------
// `prior(addr)` returns the entry ids already at an address (so Undo/Delete/Update can name what they cut or supersede).
export function activityToMark(activity, { witness, prior = () => [] }) {
  const type = activity.type;
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const ofIds = objectId ? prior(addrOf(objectId)) : [];
  const addr = type === 'Create' || type === 'Update' || type === 'Delete' ? addrOf(objectId || activity.id) : addrOf(activity.id);
  return {
    kind: kindOf(type), cell: cellOf(type), addr,
    body: { activity }, of: type === 'Create' ? [] : ofIds,
    witness: { how: witness }, declare: { why: `ActivityPub ${VERBS[type] ? type : 'activity of a type this codec does not interpret'}, received in an inbox` },
  };
}

// An entry this node chose to publish becomes a Create{Note}. Only plain-text public content.
export function entryToActivity(entry, { actorId, base }) {
  const objId = `${base}/ap/objects/${entry.id}`;
  return {
    '@context': AS, id: `${base}/ap/activities/${entry.id}`, type: 'Create', actor: actorId,
    published: entry.at, to: [`${AS}#Public`], cc: [`${actorId}/followers`],
    object: { id: objId, type: 'Note', attributedTo: actorId, content: escapeHtml(String(entry.body?.text ?? '')), published: entry.at, to: [`${AS}#Public`], cc: [`${actorId}/followers`] },
  };
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- the actor ----------
// keys: { publicKeyPem, privateKeyPem } kept in the node's key store; publicKinds: entry kinds this node publishes.
export function newActorKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export class Actor {
  // base: this actor's public origin (e.g. http://ana.ap); name: local handle; store: a stores.mjs store
  // fetchImpl: fetch used for outgoing requests (tests map hostnames); acceptFollows: 'auto' | 'manual'
  constructor({ base, name, keys, store, publicKinds = ['public-note'], fetchImpl = fetch, acceptFollows = 'manual', log = () => {} }) {
    Object.assign(this, { base: base.replace(/\/$/, ''), name, keys, store, publicKinds, fetch: fetchImpl, acceptFollows, log });
    this.id = `${this.base}/ap/actor`;
    this.keyId = `${this.id}#main-key`;
    this.domain = new URL(this.base).host;
    this.keyCache = new Map();
  }

  document() {
    return {
      '@context': [AS, 'https://w3id.org/security/v1'], id: this.id, type: 'Person', preferredUsername: this.name,
      inbox: `${this.base}/ap/inbox`, outbox: `${this.base}/ap/outbox`, followers: `${this.id}/followers`, following: `${this.id}/following`,
      endpoints: { sharedInbox: `${this.base}/ap/inbox` }, manuallyApprovesFollowers: this.acceptFollows !== 'auto', discoverable: false,
      publicKey: { id: this.keyId, owner: this.id, publicKeyPem: this.keys.publicKeyPem },
    };
  }
  webfinger(resource) {
    if (resource !== `acct:${this.name}@${this.domain}`) return null;
    return { subject: resource, links: [{ rel: 'self', type: AP_TYPES, href: this.id }] };
  }

  async getJson(url) {
    const headers = { accept: AP_TYPES, ...signRequest({ method: 'GET', url, body: null, keyId: this.keyId, privateKeyPem: this.keys.privateKeyPem }) };
    const r = await this.fetch(url, { headers });
    if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
    return r.json();
  }
  async keyFor(keyId) {
    if (this.keyCache.has(keyId)) return this.keyCache.get(keyId);
    const doc = await this.getJson(keyId.split('#')[0]);
    const pk = doc.publicKey && (Array.isArray(doc.publicKey) ? doc.publicKey.find((k) => k.id === keyId) : doc.publicKey);
    const key = pk ? { pem: pk.publicKeyPem, owner: pk.owner || doc.id, inbox: doc.inbox } : null;
    this.keyCache.set(keyId, key);
    return key;
  }
  async post(inbox, activity) {
    const body = JSON.stringify(activity);
    const headers = { 'content-type': AP_TYPES, accept: AP_TYPES, ...signRequest({ method: 'POST', url: inbox, body, keyId: this.keyId, privateKeyPem: this.keys.privateKeyPem }) };
    const r = await this.fetch(inbox, { method: 'POST', headers, body });
    return { status: r.status, text: (await r.text()).slice(0, 200) };
  }

  async entries(kind) { return (await this.store.list(kind ? { kind } : {})).map((r) => ({ id: r.id, ...r.mark })); }
  async followers() {
    const all = await this.entries();
    const cut = new Set(all.filter((e) => e.kind === 'ap-undo' || e.kind === 'ap-reject').map((e) => e.body.activity?.object?.id || e.body.activity?.object));
    return [...new Set(all.filter((e) => e.kind === 'ap-follow' && !cut.has(e.body.activity.id) && e.body.accepted).map((e) => e.body.activity.actor))];
  }

  // Inbox: verify, check the signer is the activity's actor, weave, then act (auto-accept a follow if set).
  async receive({ method, path, headers, body }) {
    const v = await verifyRequest({ method, path, headers, body, fetchKey: (k) => this.keyFor(k) });
    if (!v.ok) return { status: 401, ok: false, reason: v.reason };
    let activity; try { activity = JSON.parse(body); } catch { return { status: 400, ok: false, reason: 'not_json' }; }
    const actor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actor || v.owner !== actor) return { status: 401, ok: false, reason: 'signer_is_not_actor' };
    const existing = await this.store.list();
    const prior = (addr) => existing.filter((r) => r.mark.addr === addr).map((r) => r.id).filter((id) => !id.startsWith('m:'));
    const witness = `HTTP Signature by ${v.keyId} verified (rsa-sha256, digest checked) for ${activity.type} ${activity.id}`;
    const mark = activityToMark(activity, { witness, prior });
    if (activity.type === 'Follow' && activity.object === this.id && this.acceptFollows === 'auto') mark.body.accepted = true;
    const w = await this.store.append(mark);
    if (!w.ok) return { status: 500, ok: false, reason: w.reason };
    this.log('inbox', activity.type, actor);
    if (mark.body.accepted) {
      const accept = { '@context': AS, id: `${this.base}/ap/activities/accept-${sha(activity.id).slice(0, 16)}`, type: 'Accept', actor: this.id, object: activity };
      const key = await this.keyFor(v.keyId);
      const inbox = key.inbox || (await this.getJson(actor)).inbox;
      setTimeout(() => this.post(inbox, accept).then((r) => this.log('accept-sent', r.status), (e) => this.log('accept-failed', e.message)), 50);
    }
    return { status: 202, ok: true, id: w.id };
  }

  // Publish one entry the node chose (its kind must be in publicKinds) to every accepted follower.
  async publish(entryId) {
    const e = (await this.entries()).find((x) => x.id === entryId);
    if (!e) return { ok: false, reason: 'no_such_entry' };
    if (!this.publicKinds.includes(e.kind)) return { ok: false, reason: 'kind_not_public', detail: `${e.kind} is not in this actor's publicKinds` };
    const activity = entryToActivity({ id: e.id, at: e.at || new Date().toISOString(), body: e.body }, { actorId: this.id, base: this.base });
    const sent = [];
    for (const f of await this.followers()) {
      const inbox = (await this.getJson(f)).inbox;
      sent.push({ to: f, ...(await this.post(inbox, activity)) });
    }
    this.published = [...(this.published || []), activity];
    return { ok: true, activity, sent };
  }
  outbox() { return { '@context': AS, id: `${this.base}/ap/outbox`, type: 'OrderedCollection', totalItems: (this.published || []).length, orderedItems: [...(this.published || [])].reverse() }; }

  // Follow another actor (by actor id or acct:user@domain).
  async follow(target) {
    let actorId = target;
    if (target.startsWith('acct:') || /^[^@/]+@[^@/]+$/.test(target)) {
      const acct = target.replace(/^acct:/, ''), domain = acct.split('@')[1];
      const wf = await (await this.fetch(`http://${domain}/.well-known/webfinger?resource=acct:${acct}`)).json();
      actorId = wf.links.find((l) => l.rel === 'self').href;
    }
    const doc = await this.getJson(actorId);
    const activity = { '@context': AS, id: `${this.base}/ap/activities/follow-${sha(actorId + Date.now()).slice(0, 16)}`, type: 'Follow', actor: this.id, object: actorId };
    const r = await this.post(doc.inbox, activity);
    return { ...r, actorId, activity };
  }

  // HTTP handler: (req, url, bodyText) -> { status, json } | null when not an ActivityPub route.
  async handle(method, url, headers, bodyText) {
    const p = url.pathname;
    if (p === '/.well-known/webfinger') { const w = this.webfinger(url.searchParams.get('resource')); return w ? { status: 200, json: w, type: 'application/jrd+json' } : { status: 404, json: {} }; }
    if (p === '/ap/actor' && method === 'GET') return { status: 200, json: this.document(), type: AP_TYPES };
    if (p === '/ap/outbox' && method === 'GET') return { status: 200, json: this.outbox(), type: AP_TYPES };
    if (p === '/ap/actor/followers' && method === 'GET') { const f = await this.followers(); return { status: 200, json: { '@context': AS, id: `${this.id}/followers`, type: 'OrderedCollection', totalItems: f.length }, type: AP_TYPES }; }
    if (p === '/ap/inbox' && method === 'POST') { const r = await this.receive({ method, path: p + url.search, headers, body: bodyText }); return { status: r.status, json: r }; }
    if (p.startsWith('/ap/objects/') || p.startsWith('/ap/activities/')) {
      const a = (this.published || []).find((x) => x.id === `${this.base}${p}` || x.object?.id === `${this.base}${p}`);
      return a ? { status: 200, json: p.startsWith('/ap/objects/') ? { '@context': AS, ...a.object } : a, type: AP_TYPES } : { status: 404, json: {} };
    }
    return null;
  }
}
