import { createClient } from "matrix-js-sdk";
import { registerAuto, randomUsername, sha256Hex, getAccountData, setAccountData, shortCode, hostOf, aliasTaken } from "./matrix.js";
import { revokeEntry, withRevoked, withoutRevoked } from "./liveness.js";

export const CODE_TYPE = "org.heimdall.codes";
export const KEYS_TYPE = "org.heimdall.keys";
export const REVOKED_TYPE = "org.heimdall.revoked";
export const INVITE_TTL = 7 * 24 * 3600 * 1000;
export const DEFAULT_HS = "https://hyphae.social";

export function makeSecretCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(1))[0];
  return String(100000 + (bytes % 900000));
}

export function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x");
}

/* ----------------------------------------------------- device keypair crypto
   Every device has an ECDSA keypair. The 6-digit pairing code is NOT random:
   it is a short fingerprint of the device's PUBLIC KEY, and accepting requires
   a signature by the matching PRIVATE KEY. So the code is a commitment — a
   fake worker cannot present a recorded code without a keypair whose public
   key fingerprints to it and whose private key they hold. */

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function generateDeviceKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { pubB64: bufToB64(spki), privJwk: jwk, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export async function importPublicKeyB64(pubB64) {
  return crypto.subtle.importKey("spki", b64ToBuf(pubB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function importPrivateKeyJwk(jwk) {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function signText(privateKey, text) {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(text),
  );
  return bufToB64(sig);
}

export async function verifyText(publicKey, text, sigB64) {
  try {
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      b64ToBuf(sigB64),
      new TextEncoder().encode(text),
    );
  } catch {
    return false;
  }
}

/** The 6-digit pairing code = a short fingerprint of the device's public key. */
export async function codeFromPublicKey(pubB64) {
  const h = await sha256Hex(pubB64);
  return String(100000 + (parseInt(h.slice(0, 6), 16) % 900000));
}

/** The exact string a worker signs, binding key → code → room → identity. */
export function pairingPayload(roomId, userId, deviceId, codeHash) {
  return `heimdall|${roomId}|${userId}|${deviceId}|${codeHash}`;
}

export function buildInviteUrl({ site, roomId, baseUrl, host, name, exp }) {
  // The invite lands on the app page (public/app.html) so a phone is offered a
  // native install first; that page keeps these params for "continue in
  // browser", which is the WebGPU worker path. Works the same on mac/win/linux.
  const base = String(site).replace(/\?.*$/, "").replace(/\/+$/, "");
  const root = /app\.html$/.test(base) ? base : `${base}/app.html`;
  return `${root}?room=${encodeURIComponent(roomId)}&hs=${encodeURIComponent(baseUrl)}&host=${encodeURIComponent(host)}&name=${encodeURIComponent(name)}&exp=${exp}`;
}

/** The short invite link: the room's alias code, nothing else. `?r=<code>`
 *  is the whole URL (and the 404 page lets `/<code>` be typed instead); the
 *  homeserver is only named when it is not the default. */
export function buildShortUrl({ site, code, baseUrl, defaultHs = DEFAULT_HS }) {
  let url = `${String(site).replace(/\?.*$/, "")}?r=${encodeURIComponent(code)}`;
  const host = hostOf(baseUrl);
  if (host && host !== hostOf(defaultHs)) url += `&hs=${encodeURIComponent(baseUrl)}`;
  return url;
}

/** Register a controller account if none is provided. */
export async function ensureControllerSession({ baseUrl, creds }) {
  if (creds) return creds;
  const password = randomPassword();
  const c = await registerAuto({ baseUrl, username: randomUsername("heimdall"), password });
  return { ...c, password };
}

/** Record an issued/onboarded code on the account so any surface can confirm it. */
export async function issueCode({ creds, code, exp, own = false, link = false }) {
  const reg = await getAccountData({ ...creds, type: CODE_TYPE }).catch(() => null);
  const active = (reg?.active || []).filter((c) => c.exp > Date.now());
  // `own`: the host says this is one of their own devices — it borrows from
  // the fleet without first earning credit (the ledger still counts it).
  // `link`: a secret carried by the share link (its QR code) rather than
  // read aloud — possessing the link IS the pairing, so it is not bound to
  // one device's key fingerprint and is not consumed by the first use.
  active.push({ hash: await sha256Hex(code), exp, ...(own ? { own: true } : {}), ...(link ? { link: true } : {}) });
  await setAccountData({ ...creds, type: CODE_TYPE, content: { active } });
  return true;
}

/** Ask the account whether a presented code hash is one it recorded.
 *  Returns the recorded entry ({ hash, exp, own? }) or null. */
export async function confirmCode({ creds, codeHash }) {
  const reg = await getAccountData({ ...creds, type: CODE_TYPE }).catch(() => null);
  const active = (reg?.active || []).filter((c) => c.exp > Date.now());
  return active.find((c) => c.hash === codeHash) ?? null;
}

/** Drop a used code from the registry so it can't be reused by another device. */
export async function consumeCode({ creds, codeHash }) {
  const reg = await getAccountData({ ...creds, type: CODE_TYPE }).catch(() => null);
  const active = (reg?.active || []).filter((c) => c.exp > Date.now() && c.hash !== codeHash);
  await setAccountData({ ...creds, type: CODE_TYPE, content: { active } }).catch(() => {});
}

/** Remember which device public key owns a userId|deviceId after pairing. */
export async function recordPairedKey({ creds, userId, deviceId, pubKey, own = false }) {
  const reg = await getAccountData({ ...creds, type: KEYS_TYPE }).catch(() => null);
  const paired = (reg?.paired || []).filter((k) => !(k.userId === userId && k.deviceId === deviceId));
  paired.push({ userId, deviceId, pubKey, at: Date.now(), ...(own ? { own: true } : {}) });
  await setAccountData({ ...creds, type: KEYS_TYPE, content: { paired } }).catch(() => {});
}

/** The paired devices the host marked as their own: [{ userId, deviceId }]. */
export async function ownPairedDevices({ creds }) {
  const reg = await getAccountData({ ...creds, type: KEYS_TYPE }).catch(() => null);
  return (reg?.paired || []).filter((k) => k.own).map((k) => ({ userId: k.userId, deviceId: k.deviceId }));
}

/** Forget a device's pairing so a re-join must prove the code again. */
export async function forgetPairedKey({ creds, userId, deviceId = null }) {
  const reg = await getAccountData({ ...creds, type: KEYS_TYPE }).catch(() => null);
  const paired = (reg?.paired || []).filter((k) => !(k.userId === userId && (deviceId == null || k.deviceId === deviceId)));
  await setAccountData({ ...creds, type: KEYS_TYPE, content: { paired } }).catch(() => {});
}

/* ------------------------------------------------------- revoked devices
   The account-wide list of devices the host has removed. Every surface
   signed into the controller account (site, CLI, fold) reads it before
   offering a link, so a removed device stays removed no matter which
   heimdall is watching the room. deviceId null = the whole user. */

export async function revokedList({ creds }) {
  const reg = await getAccountData({ ...creds, type: REVOKED_TYPE }).catch(() => null);
  return Array.isArray(reg?.revoked) ? reg.revoked : [];
}

export async function revokeDevice({ creds, userId, deviceId = null, reason = "" }) {
  const list = await revokedList({ creds });
  const next = withRevoked(list, revokeEntry({ userId, deviceId, reason }));
  await setAccountData({ ...creds, type: REVOKED_TYPE, content: { revoked: next } });
  return next;
}

export async function unrevokeDevice({ creds, userId, deviceId = null }) {
  const list = await revokedList({ creds });
  const next = withoutRevoked(list, { userId, deviceId });
  await setAccountData({ ...creds, type: REVOKED_TYPE, content: { revoked: next } });
  return next;
}

export async function pairedKeyFor({ creds, userId, deviceId }) {
  const reg = await getAccountData({ ...creds, type: KEYS_TYPE }).catch(() => null);
  return (reg?.paired || []).find((k) => k.userId === userId && k.deviceId === deviceId) || null;
}

/**
 * The one function every surface uses to mint an invite:
 *  - ensures a controller account (or reuses the provided one),
 *  - creates (or reuses) a fleet room,
 *  - returns the share link.
 * The 6-digit pairing code is generated on the WORKER's device and given to
 * the host out of band; the host records it (issueCode) to onboard that
 * worker. Works in the browser and in Node (CLI / fold).
 */
export async function createInvite({ baseUrl, creds, roomId, displayName, site }) {
  creds = await ensureControllerSession({ baseUrl, creds });
  const client = createClient({
    baseUrl,
    accessToken: creds.accessToken,
    userId: creds.userId,
    deviceId: creds.deviceId,
  });
  let code = null;
  if (!roomId) {
    // Mint the room with a short local alias so the invite can be typed by
    // hand (`?r=<code>`). A taken alias is the one expected collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = shortCode();
      try {
        const room = await client.createRoom({
          name: `heimdall-${Math.random().toString(36).slice(2, 7)}`,
          preset: "public_chat",
          visibility: "private",
          room_alias_name: candidate,
        });
        roomId = room.room_id;
        code = candidate;
        break;
      } catch (e) {
        if (aliasTaken(e)) continue;
        throw e;
      }
    }
    if (!roomId) {
      const room = await client.createRoom({
        name: `heimdall-${Math.random().toString(36).slice(2, 7)}`,
        preset: "public_chat",
        visibility: "private",
      });
      roomId = room.room_id;
    }
  } else {
    // Reusing an existing fleet: recover its short alias so the invite stays
    // typable. A room with no short alias reads null (full link only).
    try {
      const { aliases } = await client.getLocalAliases(roomId);
      code = (aliases || []).map((a) => a.split(":")[0].slice(1)).find((c) => /^[a-z0-9]{3,8}$/.test(c)) || null;
    } catch {
      code = null;
    }
  }
  const exp = Date.now() + INVITE_TTL;
  const name = displayName || creds.userId;
  return {
    url: buildInviteUrl({ site, roomId, baseUrl, host: creds.userId, name, exp }),
    shortUrl: code ? buildShortUrl({ site, code, baseUrl }) : null,
    code,
    exp,
    roomId,
    creds,
  };
}