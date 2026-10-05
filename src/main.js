import "./style.css";
import {
  MatrixPeer,
  login,
  registerAuto,
  randomUsername,
  shareUrl,
  parseShareUrl,
  deviceKey,
  sha256Hex,
} from "./matrix.js";
import { RtcPeer, RelayPeer } from "./rtc.js";
// A direct link that has not opened by now falls back to the Matrix relay.
const RELAY_AFTER_MS = 10_000;
import { WorkerEngine, OllamaEngine, WasmEngine, MODEL_CHOICES, DEFAULT_MODEL, FALLBACK_MODEL, webgpuAvailable } from "./llm.js";
import { SharedEngine } from "./engine-share.js";
import { answers, ollamaTagOf } from "./models.js";
import { detectBridge, connectBridge } from "./bridge-client.js";
import qrcode from "qrcode-generator";
import { isEligible, modelOf, pickGiver as routePickGiver, observe as routeObserve, markSent as routeMarkSent, isRoomMouth, mergeInflight, mergeMeanMs, electLeader, SIBLING_TTL_MS } from "./route.js";
import { amAlly, servesOf, pruneControllers, pickForwarder, makeFwdJob, validFwdJob, controllerKey, CONTROLLER_TTL_MS, FWD_TTL } from "./swarm.js";
import { standingOf, shouldRelink, shouldDropOnReady, isRevoked, hasAccepted, leaseLapsed, leaseMsFor, revokeEntry, withRevoked } from "./liveness.js";
import { retryWithBackoff, InflightDeadlines, TimerBag, restartInterval, withTimeout, mapBounded, membersToQuery, revokedWorkerKeys, mergeRevoked } from "./controller-core.js";
import { el, statusDot, copyBtn, toast, deviceName, publicIp, countdownText } from "./ui.js";
import {
  generateDeviceKeyPair,
  importPrivateKeyJwk,
  codeFromPublicKey,
  signText,
  pairingPayload,
  issueCode,
  confirmCode,
  consumeCode,
  importPublicKeyB64,
  verifyText,
  recordPairedKey,
  forgetPairedKey,
  revokedList,
  revokeDevice,
  unrevokeDevice,
  ownPairedDevices,
  buildShortUrl,
} from "./invite.js";

const DEFAULT_HS = "https://hyphae.social";
const PUBLIC_SITE = "https://scores-patch-points.github.io/heimdall/";
// The local bridge (`heimdall up`) borrows under this key. No worker's
// deviceKey can equal it (those are "@user:hs|DEVICE"), so a worker can
// never claim the bridge's exemption from the credit gate.
const BRIDGE_KEY = "bridge";
const SESSION_KEY = "heimdall.session.v1";
const MODEL_KEY = "heimdall.model.v1";
const NAME_KEY = "heimdall.name.v1";

const INVITE_TTL = 7 * 24 * 3600 * 1000; // a share link is good for 7 days
const LEASE_TTL = 12 * 3600 * 1000; // an accepted lease lasts 12h, then must be renewed

const FOLD_REPO = "https://github.com/scores-patch-points/the-fold.git";
const FOLD_WEB = "https://scores-patch-points.github.io/the-fold/";
const FOLD_CMD = `git clone ${FOLD_REPO} && cd the-fold && ./fold`;

const share = parseShareUrl();
const mode = share ? "worker" : "controller";
// ?embed: the controller shown inside another page (the Fold's Heimdall
// sheet) — just the pairing and the devices, none of the page chrome.
const embed = new URLSearchParams(location.search).has("embed");
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : "dev";
// One id per physical device, kept across sessions and accounts on it, so
// the host keeps one entry per phone however many times it re-pairs.
const HWID = (() => {
  try {
    let id = localStorage.getItem("heimdall.hwid");
    if (!id) {
      id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("heimdall.hwid", id);
    }
    return id;
  } catch {
    return null;
  }
})();
// A QR link carries its own pairing secret, so the phone page can be one
// button: nothing to read out, nothing to type.
const simple = mode === "worker" && !!share?.key;

const app = {
  mode,
  hs: share?.baseUrl || DEFAULT_HS,
  roomId: share?.roomId || null,
  session: loadSession(),
  modelId: localStorage.getItem(MODEL_KEY) || DEFAULT_MODEL,
  modelChosen: !!localStorage.getItem(MODEL_KEY), // the person picked it — never swapped for a fallback
  displayName: localStorage.getItem(NAME_KEY) || "",
  matrix: null,
  creatorId: null,
  workers: new Map(), // controller: deviceKey -> worker record
  peers: new Map(), // worker: controller deviceKey -> RtcPeer
  connecting: new Map(), // controller: deviceKey -> timestamp
  engine: null,
  wakeLock: null,
  leaseUntil: 0,
  leaseExpired: false,
  renewRequested: false,
  myIp: null,
  timers: new TimerBag(), // one-shot timers that remove themselves when they fire
  slots: {}, // named setIntervals (worker ready/ping): restarted, never stacked
  matrixPromise: null, // an in-flight ensureMatrix start, shared by concurrent callers
  fleetGen: 0, // bumps on every createRoom/rejoin: a newer call supersedes an older retry loop
  reconciling: false,
  reconcileAgain: false,
  revokedOk: false, // the account registry has been read successfully at least once
  revokedPending: [], // revocations whose registry write failed: still enforced here
  pendingVerify: null,
  ledger: new Map(), // deviceKey -> { give, borrow }
  relay: new Map(), // job id -> { giverKey, borrowerKey, borrowerRec, t0, model }
  runs: new Map(), // broadcast run id -> { rootEl, headEl, streams: Map(wkey -> stream rec) }
  route: { inflight: {}, meanMs: {}, idx: 0 }, // bifrost evidence: measured wait per giver
  siblings: new Map(), // same-account heimdall deviceKey -> { at, deviceId, inflight, meanMs }
  controllers: new Map(), // every announced heimdall deviceKey -> { at, deviceId, userId, serves, sameAccount }
  coordPeers: new Map(), // sibling deviceKey -> { peer, device, status }
  fwdRelay: new Map(), // fwdId -> origin- or servant-side forward state
  seenFwd: [], // fwdIds already served here — replays refused
  fwdIdx: 0, // rotation counter for forward targeting
  presenceTick: 0, // reconcile counter — hello broadcast every 3rd tick
  giverIdx: 0, // legacy counter, kept for broadcast rotation symmetry
  lendDevice: false,
  hubEngine: null,
  credit: { give: 0, borrow: 0, credit: 0 },
  revoked: [], // controller: the account's revoked-device registry (invite.js REVOKED_TYPE)
  revokedAt: 0, // when it was last read from the account
  reconcileTimer: null, // exactly one reconcile loop per page, however many times we (re)join
  removed: null, // worker: { reason, via } once the host removed this device
  heard: new Map(), // controller: deviceKey -> last time that device said anything
  retired: new Set(), // controller: older sessions of a device that re-paired
  bridge: null, // controller: the local bridge connection (bridge-client.js), when `heimdall up` serves this page
  bridgeInfo: null,
  ownDevices: new Set(), // controller: deviceKeys the host marked as their own (borrow without credit)
  pendingPairs: new Map(), // controller: codeHash -> a verify that arrived before its code was recorded
  own: false, // worker: the host marked this device as theirs
};

const REVOKED_REFRESH_MS = 60_000;
const HEARD_WITHIN_MS = 10 * 60_000;
const DEVICES_LOOKUP_CONCURRENCY = 4; // reconcile's devicesOf calls in flight at once
const DEVICES_LOOKUP_TIMEOUT_MS = 10_000; // one slow member never stalls the tick

/* ---------------------------------------------------------------- storage */

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(partial = {}) {
  app.session = { ...(app.session || {}), ...partial };
  localStorage.setItem(SESSION_KEY, JSON.stringify(app.session));
}

function clearSession() {
  app.session = null;
  localStorage.removeItem(SESSION_KEY);
  toast("session cleared");
}

function randomBytes() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "x");
}

/* ---------------------------------------------------------------- matrix */

async function ensureMatrix() {
  if (app.matrix) return app.matrix;
  // Concurrent callers share one start; a failed start clears the slot so the
  // next call (or the retry loop) begins again from scratch.
  if (!app.matrixPromise) {
    app.matrixPromise = startMatrix().finally(() => { app.matrixPromise = null; });
  }
  const matrix = await app.matrixPromise;
  await resolveShortInvite(matrix);
  return matrix;
}

async function startMatrix() {
  let creds = app.session?.creds;
  if (!creds) {
    const password = randomBytes();
    creds = await registerAuto({ baseUrl: app.hs, username: randomUsername(), password });
    // Keep the generated password so the owner can later prove ownership and
    // claim the account with a real password (see claimCard / doClaim).
    saveSession({ creds: { ...creds, password } });
  }
  const cryptoPrefix = "heimdall::" + creds.userId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const matrix = new MatrixPeer({
    ...creds,
    cryptoPrefix,
    onSignal,
    onSync: () => {},
    onMembers: () => {
      if (mode === "controller") reconcile();
    },
    onMyMembership: (membership, prev) => {
      // The homeserver moved us out of the room: a kick reads "leave", a
      // ban "ban". Only the room itself can say this — it is the one
      // removal signal a worker trusts without checking the sender.
      if (mode === "worker" && prev === "join" && (membership === "leave" || membership === "ban")) {
        onRemoved(membership === "ban" ? "banned from the fleet room" : "removed from the fleet room", "room");
      }
    },
  });
  // Publish app.matrix only once start() succeeded: a half-started peer must
  // not be handed out as ready (ensureMatrix would return it forever).
  try {
    await matrix.start();
  } catch (e) {
    try { matrix.client?.stopClient?.(); } catch {}
    throw e;
  }
  app.matrix = matrix;
  return matrix;
}

async function resolveShortInvite(matrix) {
  // A short invite (`?r=<code>`) names no room: resolve the code — the room's
  // local alias — to the fleet room before anything else. host/name/exp ride
  // nothing in the short link, so identity is checked against the room's
  // creator and pairing needs the read-aloud 6-digit code.
  if (share?.shortCode && !app.roomId) {
    try {
      app.roomId = await matrix.resolveAlias(share.shortCode);
      saveSession({ roomId: app.roomId });
    } catch (e) {
      toast(`no fleet found for "${share.shortCode}" — check the link or ask for a fresh one`);
      throw e;
    }
  }
  return matrix;
}

/** A full id (@you:server) names its own server: ask that server where its
 *  client API lives (.well-known), falling back to https://server. */
async function homeserverFor(username, fallback) {
  const m = /^@[^:]+:(.+)$/.exec(username.trim());
  if (!m) return fallback;
  const server = m[1];
  try {
    const r = await fetch(`https://${server}/.well-known/matrix/client`);
    const base = (await r.json())?.["m.homeserver"]?.base_url;
    if (base) return base.replace(/\/+$/, "");
  } catch {}
  return `https://${server}`;
}

async function tryLogin({ baseUrl, username, password }) {
  const creds = await login({ baseUrl, username, password });
  // A fleet belongs to the account that made it: on the computer, signing in
  // as someone new starts that account's own fleet (press Start again).
  if (mode === "controller") saveSession({ creds, roomId: null, linkKey: null, invite: null, autostart: true });
  else saveSession({ creds });
  location.reload();
}

/* ------------------------------------------------------------- signaling */

/** One entry per physical device: a newer session from the same phone
 *  retires the older ones. */
function retireOtherSessions(key, hwid) {
  if (!hwid) return;
  for (const [k, r] of app.workers) {
    if (k !== key && r.hwid === hwid) {
      dropWorker(k);
      app.retired.add(k);
    }
  }
}

async function onSignal(senderUserId, content) {
  // Anything a device says to us means it is alive now; only devices heard
  // from recently are offered links (never every device the room remembers).
  if (mode === "controller" && content?.deviceId && senderUserId) {
    const k = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    app.heard.set(k, Date.now());
    if (content.hwid) app.retired.delete(k);
  }
  // Diagnostics: what a phone says about itself, kept by the host.
  if (content.type === "diag" && mode === "controller") {
    app.diag = app.diag || {};
    app.diag[`${senderUserId}|${content.deviceId}`] = { ...content.state, at: Date.now() };
    // (No remote reload: telling a phone to reload interrupted it mid-job
    // twice. A stale page is shown in its build stamp here, and reloads by hand.)
    return;
  }
  if (content.type === "reload" && mode === "worker") {
    if (app.creatorId && senderUserId !== app.creatorId) return;
    if (!activity.running) location.reload();
    return;
  }
  // Sibling heimdall load snapshots (same account, another surface). Only
  // the account's own devices are trusted for steering — a worker or a
  // stranger's controller could otherwise inflate load and steer the fleet.
  // Cross-account coordination rides on worker-reported queueDepth instead,
  // which the worker itself authenticates over its own link.
  if (content.type === "coord" && mode === "controller") {
    if (!app.matrix || senderUserId !== app.matrix.userId) return;
    if (!content.deviceId || content.deviceId === app.matrix.deviceId) return;
    app.siblings.set(deviceKey({ userId: senderUserId, deviceId: content.deviceId }), {
      at: content.at || Date.now(),
      deviceId: content.deviceId,
      inflight: content.inflight || {},
      meanMs: content.meanMs || {},
    });
    renderFleet();
    return;
  }
  // Another heimdall announcing itself (any account) or heartbeating.
  // Recorded for the organism view and forward targeting. Load snapshots
  // that STEER routing are still same-account only (see "coord" above) —
  // a stranger's serves list only ever attracts a forward it must then
  // actually serve, and every forward carries its own timeout.
  if ((content.type === "hello-controller" || content.type === "coord-heartbeat") && mode === "controller") {
    if (!app.matrix || !content.deviceId) return;
    if (String(content.deviceId) === String(app.matrix.deviceId) && senderUserId === app.matrix.userId) return;
    app.controllers.set(deviceKey({ userId: senderUserId, deviceId: content.deviceId }), {
      at: content.at || Date.now(),
      deviceId: content.deviceId,
      userId: senderUserId,
      serves: Array.isArray(content.serves) ? content.serves.filter((m) => typeof m === "string") : [],
      sameAccount: senderUserId === app.matrix.userId,
    });
    renderFleet();
    return;
  }
  if (content.type === "relay" || content.type === "relay-open") {
    const key = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    if (mode === "controller") {
      if (content.type === "relay") {
        const rec = app.workers.get(key);
        if (rec?.peer?.deliver) rec.peer.deliver(content.msgs);
        else if (rec) {
          // The horse is still on the relay but our record moved on (a relink):
          // take the relay back rather than drop its words.
          rec.peer?.close?.();
          rec.peer = new RelayPeer({
            send: (msgs) => app.matrix.sendSignalRetry(rec.device, { type: "relay", deviceId: app.matrix.deviceId, msgs }, 3),
            onMessage: (msg) => onWorkerMessage(key, rec, msg),
          });
          rec.via = "relay";
          rec.status = "open";
          rec.peer.deliver(content.msgs);
        } else console.warn("heimdall: relay batch from an unknown horse", key);
      }
    } else {
      if (app.creatorId && senderUserId !== app.creatorId) return;
      const remote = { userId: senderUserId, deviceId: content.deviceId };
      if (content.type === "relay-open") openWorkerRelay(remote);
      else (app.peers.get(key)?.relay ? app.peers.get(key) : openWorkerRelay(remote)).deliver(content.msgs);
    }
    return;
  }
  if (content.type === "signal") {
    const key = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    if (mode === "controller") {
      // A sibling heimdall's WebRTC signal rides the same to-device type:
      // coord peers first (the organism's nerves), workers after.
      const coord = app.coordPeers.get(key);
      if (coord?.peer) {
        coord.peer.handleSignal(content.label, content.data).catch(() => {});
        return;
      }
      if (app.controllers.has(key)) {
        ensureCoordLink({ userId: senderUserId, deviceId: content.deviceId }, true)
          .then((peer) => peer.handleSignal(content.label, content.data).catch(() => {}));
        return;
      }
      const rec = app.workers.get(key);
      if (rec?.peer) rec.peer.handleSignal(content.label, content.data).catch(() => {});
    } else {
      if (app.creatorId && senderUserId !== app.creatorId) return;
      const remote = { userId: senderUserId, deviceId: content.deviceId };
      const peer = ensureWorkerPeer(remote);
      if (peer.opened || typeof peer.handleSignal !== "function") return;
      peer.handleSignal(content.label, content.data).catch(() => {});
    }
  } else if (content.type === "ready" && mode === "controller") {
    // A horse announcing itself while we hold a stale, dead, or lost
    // record for it: the old link is a husk. Drop it so reconcile
    // re-offers — the phone woke up, the tab came back, the NAT moved.
    const key = deviceKey({ userId: senderUserId, deviceId: content.deviceId });
    const rec = app.workers.get(key);
    // A relayed horse whose hello went to an earlier page of ours: its ready
    // announcement carries everything the hello did.
    if (rec && content.hidden != null) rec.hidden = !!content.hidden;
    if (rec && content.hwid && rec.hwid !== content.hwid) { rec.hwid = content.hwid; retireOtherSessions(key, content.hwid); }
    if (rec?.peer?.relay && rec.peer.opened && !rec.hello) {
      rec.hello = { model: content.model ?? null, name: content.name, leaseUntil: content.leaseUntil, leaseMs: content.leaseMs, queueDepth: content.queueDepth ?? 0 };
      rec.leaseAt = Date.now();
      rec.status = "ready";
      rec.lastSeen = Date.now();
      renderFleet();
      return;
    }
    // Only a genuine husk (dead / lost / stuck linking) is dropped: a hidden,
    // expired or stale horse is alive, and an in-flight job must finish.
    if (shouldDropOnReady(rec, Date.now(), { jobInFlight: jobInFlight(key) })) dropWorker(key);
    reconcile();
  } else if (content.type === "revoked" && mode === "worker") {
    // Courtesy notice from the host (creator only); the room membership
    // change is the authoritative one and arrives on its own.
    if (app.creatorId && senderUserId !== app.creatorId) return;
    onRemoved(content.reason || "removed by the host", "signal");
  } else if (content.type === "verify" && mode === "controller") {
    await verifyPairing(senderUserId, content);
  } else if (content.type === "verified" && mode === "worker") {
    if (app.creatorId && senderUserId !== app.creatorId) return;
    if (content.own) app.own = true;
    app.onAwaitingCode = null;
    if (app.pendingVerify) {
      const r = app.pendingVerify;
      app.pendingVerify = null;
      r(true);
    }
  } else if (content.type === "denied" && mode === "worker") {
    if (app.creatorId && senderUserId !== app.creatorId) return;
    // Not refused — the host just hasn't typed the code in yet. Keep
    // waiting: the host re-checks this attempt the moment they record it.
    if (content.reason === "unrecorded" && app.pendingVerify) {
      app.onAwaitingCode?.();
      return;
    }
    if (app.pendingVerify) {
      const r = app.pendingVerify;
      app.pendingVerify = null;
      r(false);
    }
  }
}

/* ------------------------------------------------------------ controller */

/** The worker proves the pairing. The whole chain is verified before
 *  confirming — nothing can be faked without the private key:
 *    1. the presented code hash was actually recorded by us,
 *    2. that code is the fingerprint of the presented PUBLIC key,
 *    3. the signature is valid under that public key, over room+identity+code.
 *  A proof whose signature holds but whose code isn't recorded YET is kept:
 *  the host typing the code in re-runs it (recordCode), so the phone never
 *  has to press accept twice. */
async function verifyPairing(senderUserId, content) {
  let ok = false;
  let recorded = null;
  let sigHolds = false;
  try {
    if (app.session?.creds && content.pubKey && content.sig && content.codeHash) {
      const creds = app.session.creds;
      const pubKey = await importPublicKeyB64(content.pubKey);
      const fingerprint = await codeFromPublicKey(content.pubKey);
      const fpMatches = (await sha256Hex(fingerprint)) === content.codeHash;
      const payload = pairingPayload(app.roomId, senderUserId, content.deviceId, content.codeHash);
      const sigValid = await verifyText(pubKey, payload, content.sig);
      sigHolds = fpMatches && sigValid;
      if (sigValid) recorded = await confirmCode({ creds, codeHash: content.codeHash });
      // A read-aloud code must be this device's key fingerprint; a link
      // secret (from the QR code) needs only the signature binding it to
      // this device's key.
      ok = sigValid && !!recorded && (fpMatches || !!recorded.link);
      if (ok) {
        const own = !!recorded.own;
        if (!recorded.link) consumeCode({ creds, codeHash: content.codeHash }).catch(() => {});
        recordPairedKey({ creds, userId: senderUserId, deviceId: content.deviceId, pubKey: content.pubKey, own }).catch(() => {});
        if (own) app.ownDevices.add(deviceKey({ userId: senderUserId, deviceId: content.deviceId }));
      }
    }
  } catch {}
  const device = { userId: senderUserId, deviceId: content.deviceId };
  if (ok) {
    app.pendingPairs.delete(content.codeHash);
    app.matrix?.sendSignalRetry(device, { type: "verified", deviceId: app.matrix.deviceId, own: !!recorded?.own }, 3).then(() => {});
    toast(`paired ${senderUserId} — signature + code verified`);
    renderPendingPairs();
    return true;
  }
  if (sigHolds && !recorded) {
    app.pendingPairs.set(content.codeHash, { senderUserId, content, at: Date.now() });
    app.matrix?.sendSignalRetry(device, { type: "denied", reason: "unrecorded", deviceId: app.matrix.deviceId }, 3).then(() => {});
    renderPendingPairs();
    toast("a device is waiting — type the code it shows");
    return false;
  }
  app.matrix?.sendSignalRetry(device, { type: "denied", deviceId: app.matrix.deviceId }, 3).then(() => {});
  toast(`pairing refused for ${senderUserId} — code, key, or signature didn't check out`);
  return false;
}

/** Record a code the worker read out, then re-check any device already
 *  waiting on it. */
async function recordCode(code, own) {
  await issueCode({ creds: app.session.creds, code, exp: Date.now() + INVITE_TTL, own });
  const hash = await sha256Hex(code);
  const waiting = app.pendingPairs.get(hash);
  if (waiting) await verifyPairing(waiting.senderUserId, waiting.content);
  return !!waiting;
}

function renderPendingPairs() {
  const box = document.getElementById("pending-pairs");
  if (!box) return;
  const cut = Date.now() - 15 * 60_000;
  for (const [h, p] of app.pendingPairs) if (p.at < cut) app.pendingPairs.delete(h);
  const n = app.pendingPairs.size;
  box.hidden = !n;
  box.textContent = n ? `${n} device${n > 1 ? "s" : ""} waiting — type the 6-digit code shown on ${n > 1 ? "each" : "it"}` : "";
}

/** The link's pairing secret: minted once per room and invite, recorded on
 *  the account as an own-device code, and carried in the link. Scanning the
 *  QR code is the whole pairing — no code to read out. The link is therefore
 *  a credential: anyone holding it joins as your own device until it expires
 *  (remove/ban still apply). */
async function linkSecret(exp) {
  if (app.session?.linkKey?.room === app.roomId && app.session.linkKey.exp > Date.now()) return app.session.linkKey.key;
  const key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await issueCode({ creds: app.session.creds, code: key, exp, own: true, link: true });
  saveSession({ linkKey: { room: app.roomId, key, exp } });
  return key;
}

async function buildInviteUrl() {
  const name = app.displayName || app.matrix.userId;
  const exp = Date.now() + INVITE_TTL;
  app.invite = { name, exp };
  saveSession({ invite: app.invite });
  const k = await linkSecret(exp);
  // Served by the local bridge, the page lives on localhost — a phone
  // can't open that. Hand out the public site instead (same code).
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const base = shareUrl(app.roomId, app.hs, local ? app.bridgeInfo?.site || PUBLIC_SITE : undefined);
  // The 6-digit pairing code is generated on the WORKER's device and given to
  // you out of band; you record it to onboard them. It never rides in the link.
  return `${base}&host=${encodeURIComponent(app.matrix.userId)}&name=${encodeURIComponent(name)}&exp=${exp}&k=${k}`;
}

async function renewInvite() {
  // Renewed consent: a fresh link, same room, fresh expiry.
  await refreshShareBox();
  toast("new link issued — share it with your worker");
}

async function refreshShareBox() {
  if (!shareBoxEl || !app.roomId) return;
  const full = await buildInviteUrl();
  const short = shortShareUrl();
  // The box carries the SHORT link — the one a person can actually type on a
  // worker's computer by hand. The QR keeps the full link so a phone still
  // scans into an auto-pairing invite (its `k` secret, no code to read out).
  shareBoxEl.value = short || full;
  shareBoxEl.disabled = false;
  if (fullLinkBtnEl) fullLinkBtnEl.hidden = !short;
  if (qrEl) {
    const qr = qrcode(0, "M");
    qr.addData(full);
    qr.make();
    qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
    qrEl.hidden = false;
  }
  inviteExpiryEl.textContent = `link expires ${countdownText(app.invite.exp)} — renew to keep it alive`;
}

/** The short invite link (`?r=<code>`), when this fleet room has an alias. */
function shortShareUrl() {
  if (!app.matrix?.alias) return null;
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const site = local ? app.bridgeInfo?.site || PUBLIC_SITE : undefined;
  return buildShortUrl({
    site: site || `${location.origin}${location.pathname}`,
    code: app.matrix.alias,
    baseUrl: app.hs,
  });
}

/** Bring the fleet up, retrying with backoff (2s .. 60s) until it works: a
 *  failed createRoom/rejoin used to leave startReconcile unrun until reload.
 *  A newer call supersedes an older loop; `fatal` errors stop it. */
async function bringUpFleet(label, step, { fatal = () => false } = {}) {
  const gen = ++app.fleetGen;
  const done = await retryWithBackoff(step, {
    shouldStop: () => app.fleetGen !== gen,
    isFatal: fatal,
    onError: (e, n) => toast(`could not ${label}: ${e.message}${n === 0 ? " — retrying" : ""}`),
  });
  if (!done.ok) return false;
  fleetCardEl.hidden = false;
  promptCardEl.hidden = false;
  refreshShareBox();
  startReconcile();
  try { await reconcile(); } catch {}
  return true;
}

async function createRoom() {
  await bringUpFleet("create room", async () => {
    const matrix = await ensureMatrix();
    const roomId = await matrix.createFleetRoom();
    saveSession({ roomId });
    app.roomId = roomId;
    toast("fleet room ready — send the link");
  });
}

async function rejoin() {
  if (!app.session?.roomId) return;
  await bringUpFleet("rejoin", async () => {
    const matrix = await ensureMatrix();
    await matrix.joinRoom(app.session.roomId);
    app.roomId = app.session.roomId;
    await matrix.ensureEncrypted();
    await matrix.restoreAlias();
    toast("rejoined fleet");
  }, { fatal: (e) => e?.errcode === "M_FORBIDDEN" || e?.errcode === "M_UNKNOWN_TOKEN" });
}

/* ------------------------------------------------ the local bridge ----
   When `heimdall up` serves this page, this computer's own callers
   (eoreader7, anything that speaks Ollama) reach the fleet through it. */

async function startBridge() {
  const info = app.bridgeInfo || (await detectBridge());
  if (!info) return;
  app.bridgeInfo = info;
  app.bridgeJobs = 0;
  app.bridge = connectBridge({
    onJob: onBridgeJob,
    getState: bridgeState,
    onStatus: (st) => {
      app.bridgeStatus = st;
      renderBridge();
    },
  });
  if (bridgeCardEl) bridgeCardEl.hidden = false;
  if (ownBoxEl) ownBoxEl.checked = true; // it's your computer: devices you pair here are yours
  renderBridge();
  if (app.roomId) refreshShareBox();
  // No fleet yet: the Start button on the page makes one (it creates a
  // Matrix account, so it waits for a person's click) — or the person just
  // signed in, which is that click.
  if (!app.session?.roomId && app.session?.autostart) {
    saveSession({ autostart: false });
    await createRoom();
  }
  // Lend this computer's Ollama back, so a phone can borrow its GPU.
  if (info.lendModel && !app.lendDevice) await lendOllama(info.lendModel);
}

function onBridgeJob(m) {
  app.bridgeJobs++;
  const rec = {
    device: { userId: "this computer", deviceId: BRIDGE_KEY },
    peer: { opened: true, send: (x) => app.bridge?.reply(x) },
  };
  onBorrowJob(BRIDGE_KEY, rec, {
    type: "job",
    id: m.id,
    model: m.model,
    messages: m.messages,
    temperature: m.temperature,
    max_tokens: m.max_tokens,
  });
  renderBridge();
}

/** What the bridge may promise its callers: who is ready, with what. */
function bridgeState() {
  const now = Date.now();
  const workers = [...app.workers.entries()].map(([key, rec]) => ({
    key,
    name: rec.hello?.name || rec.device.userId,
    model: modelOf(rec),
    ctx: rec.hello?.ctx ?? null,
    standing: standingOf(rec, now),
    // Routable only once the phone has tapped Start (a live lease) and says
    // which weights are actually loaded.
    ready: isEligible(rec, now) && !!modelOf(rec), // isEligible already requires an accepted, unlapsed lease
    // The same worker-reported backlog route.js already ranks givers by
    // (rec.queueDepth, from the phone's own WorkerEngine.pending) — the
    // bridge needs it too, to answer callers honestly instead of "ready".
    queueDepth: rec.queueDepth ?? 0,
  }));
  const s = selfGiver();
  // This tab lending WebLLM is one more giver the bridge may use; a lent
  // Ollama is not (the bridge reaches Ollama directly).
  if (s && !(app.hubEngine instanceof OllamaEngine)) {
    workers.push({ key: "self", name: "this computer (browser)", model: s.model, ctx: app.hubEngine?.contextWindow ?? null, standing: "ready", queueDepth: app.hubEngine?.pending ?? 0, ready: true });
  }
  return {
    at: now,
    room: app.roomId,
    diag: app.diag || {},
    hostRecv: (app.matrix?.recvLog || []).slice(-15).map((r) => ({ ...r, ago: Math.round((now - r.at) / 1000) })),
    workers,
    self: s ? { model: s.model, kind: app.hubEngine instanceof OllamaEngine ? "ollama" : "webllm" } : null,
  };
}

let bridgePushAt = 0;
function bridgeNudge() {
  if (!app.bridge || Date.now() - bridgePushAt < 1000) return;
  bridgePushAt = Date.now();
  app.bridge.pushState();
}

async function lendOllama(tag) {
  const eng = new OllamaEngine();
  try {
    await eng.load(tag);
    app.hubEngine = eng;
    app.lendDevice = true;
    if (lendBtnEl) lendBtnEl.disabled = true;
    if (lendStatusEl) lendStatusEl.textContent = `lending this computer's Ollama (${tag}) — your phone can borrow it`;
    renderFleet();
    renderBridge();
  } catch (e) {
    if (lendStatusEl) lendStatusEl.textContent = `could not lend Ollama: ${e.message}`;
  }
}

function renderBridge() {
  if (!bridgeStatusEl || !app.bridgeInfo) return;
  const now = Date.now();
  const ready = [...app.workers.entries()].filter(([, r]) => isEligible(r, now));
  const busy = ready.filter(([k, r]) => (app.route.inflight[k] ?? 0) > 0 || (r.queueDepth ?? 0) > 0);
  const nameOf = (r) => r.hello?.name || "phone";
  const line = app.bridgeStatus && app.bridgeStatus !== "connected"
    ? "reconnecting to this computer…"
    : busy.length
      ? `Running on ${busy.map(([, r]) => nameOf(r)).join(", ")} now`
      : ready.length
        ? `${ready.map(([, r]) => `${nameOf(r)} ready (${labelOf(modelOf(r))})`).join(", ")}`
        : [...app.workers.values()].some((r) => r.hidden)
          ? "Phone left the app — open heimdall on it to resume"
          : app.workers.size
          ? "Phone connecting…"
          : "Waiting for a phone";
  bridgeStatusEl.replaceChildren(
    el("div", { class: "bridge-line" + (busy.length ? " running" : "") }, [el("span", { class: "act-dot" }), el("span", { text: line })]),
    ...(app.bridgeJobs ? [el("div", { class: "muted small", text: `${app.bridgeJobs} request${app.bridgeJobs > 1 ? "s" : ""} from this computer so far` })] : []),
  );
}

// WebLLM is the default engine, and there is ONE per browser: the first tab builds it and the others proxy to it
// (engine-share.js). Weights are already shared through Cache Storage; this makes the engine itself shared too.
const newWebllmEngine = (onProgress) => new SharedEngine({ onProgress, makeEngine: (cb) => new WorkerEngine(cb) });

async function lendMyDevice() {
  if (app.lendDevice) return;
  app.lendDevice = true;
  lendBtnEl.disabled = true;
  lendStatusEl.textContent = "loading model…";
  app.hubEngine = newWebllmEngine((p) => {
    lendStatusEl.textContent = p.text || `loading model ${Math.round((p.progress || 0) * 100)}%`;
  });
  try {
    await app.hubEngine.load(app.modelId);
    lendStatusEl.textContent = `${app.modelId} — you lend compute now`;
    toast("you are giving compute back to the fleet");
    renderFleet();
  } catch (e) {
    app.lendDevice = false;
    lendBtnEl.disabled = false;
    lendStatusEl.textContent = `failed: ${e.message}`;
  }
}

/** One loop, however many times createRoom/rejoin run in a page's life. */
function startReconcile() {
  if (app.reconcileTimer) return;
  app.reconcileTimer = setInterval(() => reconcile(), 15000);
}

/** Read the account's revoked-device registry, at most once a minute. Any
 *  surface on this account (site, CLI, fold) may have revoked since. */
async function refreshRevoked(force = false) {
  if (!app.session?.creds) return app.revoked;
  if (!force && Date.now() - app.revokedAt < REVOKED_REFRESH_MS) return app.revoked;
  try {
    // revokedList THROWS on a failed read (invite.js): the last list is kept
    // and revokedAt stays put, so the very next reconcile reads again.
    const fresh = await revokedList({ creds: app.session.creds });
    // A revocation this tab made whose registry write failed is still enforced.
    app.revokedPending = app.revokedPending.filter((p) => !isRevoked(fresh, p));
    app.revoked = mergeRevoked(fresh, app.revokedPending);
    app.revokedAt = Date.now();
    app.revokedOk = true;
  } catch { /* keep the last list; never re-offer on a failed read */ }
  // Own devices ride the same account read, so a pairing made on another
  // surface (or before a reload) still borrows freely here.
  ownPairedDevices({ creds: app.session.creds })
    .then((list) => { for (const d of list) app.ownDevices.add(deviceKey(d)); })
    .catch(() => {});
  return app.revoked;
}

/** Tear one worker's link down and forget it, so the next reconcile
 *  re-offers from scratch (or never does, if revoked). */
function dropWorker(key) {
  const rec = app.workers.get(key);
  try { rec?.peer?.close(); } catch {}
  app.workers.delete(key);
  // Start the relink cool-down now rather than erasing it — an immediate
  // re-offer raced the old link's teardown.
  app.connecting.set(key, Date.now() - 20_000);
  renderFleet();
}

/** A job is running on this horse right now. */
function jobInFlight(key) {
  for (const r of app.relay.values()) if (r.giverKey === key) return true;
  return (app.route.inflight[key] ?? 0) > 0;
}

/** One reconcile at a time; a call that lands mid-run schedules exactly one more. */
async function reconcile() {
  if (!app.matrix || !app.roomId) return;
  if (app.reconciling) { app.reconcileAgain = true; return; }
  app.reconciling = true;
  try {
    do {
      app.reconcileAgain = false;
      await reconcileOnce();
    } while (app.reconcileAgain);
  } finally {
    app.reconciling = false;
  }
}

async function reconcileOnce() {
  if (!app.matrix || !app.roomId) return;
  await refreshRevoked();
  // Revocation gates what is ALREADY linked, not just new offers: a revoked
  // horse is dropped (link closed, record gone, so it is unrouted) now.
  for (const key of revokedWorkerKeys(app.workers, app.revoked, isRevoked)) dropWorker(key);
  // Never read the registry successfully (the read failed): offering links now
  // would fail OPEN. Hold offers until one read lands; the next tick retries.
  const registryUnknown = !!app.session?.creds && !app.revokedOk;
  // Ally mode: this room belongs to another account, so its workers will
  // never answer our offers (they serve their creator's devices only).
  // Don't storm them — contribute the lent device, accept forwards.
  const ally = amAlly({ creatorId: app.matrix.roomCreator(), userId: app.matrix.userId });
  app.ally = ally;
  if (!ally && !registryUnknown) {
    // Your own account's other devices count too: a phone signed into the
    // same account as this computer is the plainest pairing there is.
    // Only members with a device heard recently can yield an offer (the
    // heard filter below), so only they are looked up — in parallel, capped,
    // each with its own timeout, instead of serially for the whole room.
    const members = membersToQuery([...app.matrix.roomMembers(), app.matrix.userId], app.heard, Date.now(), HEARD_WITHIN_MS);
    const found = await mapBounded(
      members,
      async (userId) => ({ userId, devs: await withTimeout(app.matrix.devicesOf(userId, { retry: 0 }), DEVICES_LOOKUP_TIMEOUT_MS, []) }),
      DEVICES_LOOKUP_CONCURRENCY,
    );
    for (const { userId, devs } of found) {
      for (const device of devs) {
        if (userId === app.matrix.userId && String(device.deviceId) === String(app.matrix.deviceId)) continue; // this page
        if (app.controllers.has(deviceKey(device))) continue; // another heimdall, not a horse
        const heardAt = app.heard.get(deviceKey(device)) || 0;
        if (Date.now() - heardAt > HEARD_WITHIN_MS) continue; // silent for long: an old session, not a phone
        if (app.retired.has(deviceKey(device))) continue;
        const key = deviceKey(device);
        if (isRevoked(app.revoked, device)) continue; // removed stays removed
        if (app.workers.has(key)) continue;
        const last = app.connecting.get(key) || 0;
        if (Date.now() - last < 30000) continue;
        app.connecting.set(key, Date.now());
        ensureWorkerLink(key, device);
      }
    }
  }
  presenceHeartbeat();
}

/** The organism's pulse. Every tick: prune the quiet, share load snapshots
 *  with same-account siblings (trusted steering), heartbeat serves to every
 *  announced controller, and every 3rd tick broadcast hello-controller to
 *  the whole room so allied accounts can find us. All best-effort, one
 *  attempt — the next 15s tick sends it again. */
async function siblingHeartbeat() {
  return presenceHeartbeat();
}

async function presenceHeartbeat() {
  if (mode !== "controller" || !app.matrix) return;
  const now = Date.now();
  for (const [key, snap] of app.siblings) {
    if (now - snap.at > SIBLING_TTL_MS) app.siblings.delete(key);
  }
  app.controllers = pruneControllers(app.controllers, now);
  const serves = servesOf(app.workers, selfGiver());
  // Same-account siblings: full load snapshots (shared steering).
  try {
    const own = await app.matrix.devicesOf(app.matrix.userId, { retry: 0 });
    const snap = {
      type: "coord",
      deviceId: app.matrix.deviceId,
      at: now,
      inflight: app.route.inflight,
      meanMs: app.route.meanMs,
      serves,
    };
    for (const d of own) {
      if (String(d.deviceId) === String(app.matrix.deviceId)) continue;
      app.matrix.sendSignalRetry(d, snap, 1).then(() => {});
    }
  } catch { /* presence is best-effort */ }
  // Announced controllers (any account): serves heartbeat.
  const beat = { type: "coord-heartbeat", deviceId: app.matrix.deviceId, at: now, serves };
  for (const [, c] of app.controllers) {
    app.matrix.sendSignalRetry({ userId: c.userId, deviceId: c.deviceId }, beat, 1).then(() => {});
  }
  // Whole room, every 3rd tick: hello so unknown allies can find us.
  // Workers ignore unknown to-device types, so this noise costs them nothing.
  app.presenceTick++;
  if (app.presenceTick % 3 === 0) {
    const hello = { type: "hello-controller", deviceId: app.matrix.deviceId, at: now, serves };
    try {
      for (const userId of app.matrix.roomMembers()) {
        const devs = await app.matrix.devicesOf(userId, { retry: 0 });
        for (const d of devs) app.matrix.sendSignalRetry(d, hello, 1).then(() => {});
      }
    } catch { /* presence is best-effort */ }
  }
  renderFleet();
}

/** What the router sees: own measurements plus live sibling snapshots, and
 *  worker-reported queue depth (jobs other heimdalls — any account — sent
 *  that no local map can see). */
function effectiveLoad() {
  const snaps = [...app.siblings.values()];
  return {
    inflight: mergeInflight(app.route.inflight, snaps),
    meanMs: mergeMeanMs(app.route.meanMs, snaps),
  };
}

/** Worker-reported queue depth per giver key, plus the host's own engine. */
function queuedLoad() {
  const out = {};
  for (const [key, rec] of app.workers) {
    if (Number.isFinite(rec.queueDepth) && rec.queueDepth > 0) out[key] = rec.queueDepth;
  }
  const selfPending = app.hubEngine?.pending ?? 0;
  if (selfPending > 0) out.self = selfPending;
  return out;
}

function ensureWorkerLink(key, device) {
  const rec = {
    device,
    peer: null,
    status: "linking",
    hello: null,
    lastSeen: null,
    renewed: false,
    createdAt: Date.now(), // a link still "linking" long after this is a husk (liveness.js LINK_STUCK_MS)
  };
  app.workers.set(key, rec);
  renderFleet();

  const peer = new RtcPeer({
    signal: (label, data) =>
      app.matrix
        .sendSignalRetry(device, { type: "signal", deviceId: app.matrix.deviceId, label, data })
        .then(() => {}),
    onOpen: () => {
      rec.status = "open";
      rec.lastSeen = Date.now();
      renderFleet();
    },
    onClose: () => {
      rec.status = "lost";
      renderFleet();
      app.timers.later(() => {
        // Only reap OUR record: a relink may already hold a new one under
        // this key (dropWorker + reconcile run inside 5s).
        if (app.workers.get(key) !== rec || rec.peer !== peer) return; // swapped to the relay: not ours to reap
        app.workers.delete(key);
        app.connecting.delete(key);
        reconcile();
      }, 5000);
    },
    onMessage: (msg) => onWorkerMessage(key, rec, msg),
  });
  rec.peer = peer;
  peer.offer().catch(() => {
    app.workers.delete(key);
    app.connecting.delete(key);
  });
  app.timers.later(() => {
    if (app.workers.get(key) !== rec || rec.peer !== peer || peer.opened) return;
    peer.onClose = () => {};
    peer.close();
    rec.peer = new RelayPeer({
      send: (msgs) => app.matrix.sendSignalRetry(device, { type: "relay", deviceId: app.matrix.deviceId, msgs }, 3),
      onMessage: (msg) => onWorkerMessage(key, rec, msg),
    });
    rec.via = "relay";
    rec.status = "open";
    rec.lastSeen = Date.now();
    app.matrix.sendSignalRetry(device, { type: "relay-open", deviceId: app.matrix.deviceId }, 3).catch(() => {});
    renderFleet();
  }, RELAY_AFTER_MS);
}

function selfGiver() {
  if (app.lendDevice && app.hubEngine?.loaded) {
    return { key: "self", model: app.hubEngine.modelId || app.modelId, loaded: true };
  }
  return null;
}

function noteObserved(giverKey, ms, ok) {
  const next = routeObserve(app.route, giverKey, { ms, ok });
  app.route.inflight = next.inflight;
  app.route.meanMs = next.meanMs;
}

function onWorkerMessage(key, rec, msg) {
  rec.lastSeen = Date.now(); // any word from the horse — tokens of a long answer included — is life
  // A relayed job: worker borrowed from the fleet, tokens come back via the hub.
  if (msg.type === "token" && app.relay.has(msg.id)) {
    const r = app.relay.get(msg.id);
    r.arm?.();
    if (r.borrowerRec?.peer?.opened) r.borrowerRec.peer.send({ type: "token", id: msg.id, text: msg.text });
    return;
  }
  if ((msg.type === "result" || msg.type === "error") && app.relay.has(msg.id)) {
    const r = app.relay.get(msg.id);
    app.relay.delete(msg.id);
    clearTimeout(r.timer);
    noteObserved(r.giverKey, Date.now() - r.t0, msg.type === "result");
    // A model-mismatch error is the router's own failure to avoid — never
    // settle credit on it, so a misrouted job doesn't mint borrow debt.
    if (msg.type === "result") settle(r.giverKey, r.borrowerKey);
    if (r.borrowerRec?.peer?.opened) {
      r.borrowerRec.peer.send({ type: msg.type, id: msg.id, text: msg.text, duration_ms: msg.duration_ms, message: msg.message });
    }
    renderFleet();
    return;
  }
  // A worker borrowing from the fleet (reciprocal path).
  if (msg.type === "job") {
    onBorrowJob(key, rec, msg);
    return;
  }
  if (msg.hidden != null) rec.hidden = !!msg.hidden;
  if (msg.hwid) {
    if (rec.hwid !== msg.hwid) retireOtherSessions(key, msg.hwid);
    rec.hwid = msg.hwid;
  }
  if (msg.type === "hello") {
    rec.hello = msg;
    rec.leaseAt = Date.now(); // msg.leaseMs (remaining) is aged from here, on OUR clock
    rec.status = "ready";
    rec.lastSeen = Date.now();
    rec.queueDepth = Number.isFinite(msg.queueDepth) && msg.queueDepth > 0 ? msg.queueDepth : 0;
    pushCredit(key, ledgerOf(key)); // tells an own device it may borrow now
    renderFleet();
  } else if (msg.type === "lease") {
    rec.hello = { ...(rec.hello || {}), leaseUntil: msg.until, leaseMs: msg.leaseMs };
    rec.leaseAt = Date.now();
    rec.renewed = true;
    rec.status = "ready";
    rec.lastSeen = Date.now();
    if (Number.isFinite(msg.queueDepth)) rec.queueDepth = Math.max(0, msg.queueDepth);
    renderFleet();
  } else if (msg.type === "ping") {
    rec.lastSeen = Date.now();
    // Backpressure + model freshness from the worker itself: what the
    // worker reports queued covers jobs sibling heimdalls sent that no
    // local inflight map can see. A cross-account heimdall coordinates
    // through exactly this number.
    if (Number.isFinite(msg.queueDepth)) rec.queueDepth = Math.max(0, msg.queueDepth);
    if (msg.model && rec.hello) rec.hello.model = msg.model;
    if (msg.ctx && rec.hello) rec.hello.ctx = msg.ctx;
  } else if (msg.type === "token") {
    // A broadcast run's tokens land in the worker's own stream block, so
    // "run on all" stays readable instead of one interleaved soup.
    pushRunToken(msg.id, key, msg.text);
    app.deadlines.touch(key, msg.id); // a streaming horse is alive: re-arm its deadline
  } else if (msg.type === "result") {
    app.deadlines.settle(key, msg.id);
    finishRunStream(msg.id, key, `[done ${msg.duration_ms}ms]`, true);
    rec.lastSeen = Date.now();
    noteObserved(key, msg.duration_ms ?? null, true);
    // The hub borrowed from this worker — it gave compute. Credit it.
    const l = app.ledger.get(key) || { give: 0, borrow: 0 };
    l.give++;
    app.ledger.set(key, l);
    pushCredit(key, l);
    renderFleet();
  } else if (msg.type === "error") {
    app.deadlines.settle(key, msg.id);
    finishRunStream(msg.id, key, `[error] ${msg.message}`, false);
    // A model_mismatch here means the broadcast label drifted or the
    // worker swapped models mid-lease — free the slot, keep the mean.
    noteObserved(key, null, false);
    rec.status = "ready";
    renderFleet();
  }
}

/* ------------------------------------------------------- reciprocal ledger */

function ledgerOf(key) {
  return app.ledger.get(key) || { give: 0, borrow: 0 };
}

function pushCredit(key, l) {
  const rec = app.workers.get(key);
  if (rec?.peer?.opened) {
    rec.peer.send({ type: "credit", give: l.give, borrow: l.borrow, credit: l.give - l.borrow, own: app.ownDevices.has(key) });
  }
}

function settle(giverKey, borrowerKey) {
  if (giverKey !== "self") {
    const g = ledgerOf(giverKey);
    g.give++;
    app.ledger.set(giverKey, g);
    pushCredit(giverKey, g);
  }
  const b = ledgerOf(borrowerKey);
  b.borrow++;
  app.ledger.set(borrowerKey, b);
  pushCredit(borrowerKey, b);
}

const JOB_TIMEOUT_MS = 120_000;

// A broadcast job sent to a horse that then dies would hold its inflight slot
// (and jobInFlight, which blocks the relink) forever: silence for
// JOB_TIMEOUT_MS clears it, the same bound the relayed jobs use.
app.deadlines = new InflightDeadlines({
  ms: JOB_TIMEOUT_MS,
  onExpire: (key, id) => {
    noteObserved(key, null, false);
    finishRunStream(id, key, "[timed out — no word from this horse]", false);
    renderFleet();
  },
});

function onBorrowJob(borrowerKey, rec, msg) {
  const l = ledgerOf(borrowerKey);
  // The host's own callers (the bridge) and devices the host marked as
  // their own borrow freely; the ledger still counts every job.
  const exempt = borrowerKey === BRIDGE_KEY || app.ownDevices.has(borrowerKey);
  if (!exempt && l.borrow >= l.give) {
    rec.peer.send({ type: "error", id: msg.id, message: "no credit — you have to give compute before you can borrow. Serve a job first." });
    return;
  }
  const wantModel = msg.model ?? null;
  // A remote Matrix mouth is never served by a local WebLLM giver. Route
  // it down the Matrix path instead of quietly answering with the wrong
  // model — the-fold's pinned-model rule, one level down.
  if (wantModel && isRoomMouth(wantModel)) {
    rec.peer.send({ type: "error", id: msg.id, message: "remote Matrix mouth — not routable to local workers" });
    return;
  }
  const eff = effectiveLoad();
  // A bridge job never lands on the computer's own Ollama through the
  // fleet: the bridge already passes those through directly.
  const self = borrowerKey === BRIDGE_KEY && app.hubEngine instanceof OllamaEngine ? null : selfGiver();
  const picked = routePickGiver(app.workers, {
    borrowerKey,
    model: wantModel,
    self,
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  if (!picked.giver) {
    // No local giver — the organism migrates the work, not the refusal.
    // Offer it to a sibling that advertises the model; only when nobody
    // can serve does the borrower hear "no".
    forwardJobToSibling(borrowerKey, rec, msg, wantModel, picked.reason).catch(() => {
      rec.peer?.send?.({
        type: "error",
        id: msg.id,
        message: picked.reason === "no_giver_for_model"
          ? `no giver loaded with ${wantModel} right now`
          : "no giver available right now",
      });
    });
    return;
  }
  const giver = picked.giver;
  // Pin to the giver's own weights id: a job asked for `gemma2:2b` reaches
  // a phone as the exact WebLLM build it holds (models.js), never looser.
  const giverModel = giver.key === "self" ? self?.model : modelOf(giver.rec);
  const req = {
    type: "infer",
    id: msg.id,
    model: wantModel ? giverModel : null,
    messages: msg.messages || [{ role: "user", content: msg.prompt }],
    stream: true,
    temperature: msg.temperature ?? 0.7,
    max_tokens: msg.max_tokens ?? 1024,
  };
  app.route.inflight = routeMarkSent(app.route.inflight, giver.key);
  const t0 = Date.now();
  const relayRec = { giverKey: giver.key, borrowerKey, borrowerRec: rec, t0, model: wantModel, timer: null };
  // Timed on silence, not length: a long answer that keeps streaming is
  // alive; JOB_TIMEOUT_MS with no token at all is not.
  relayRec.arm = () => {
    clearTimeout(relayRec.timer);
    relayRec.timer = setTimeout(() => {
      if (app.relay.get(msg.id) !== relayRec) return;
      app.relay.delete(msg.id);
      noteObserved(giver.key, null, false);
      rec.peer?.send?.({ type: "error", id: msg.id, message: "giver timed out — try again" });
      renderFleet();
    }, JOB_TIMEOUT_MS);
  };
  relayRec.arm();
  app.relay.set(msg.id, relayRec);
  if (giver.key === "self") {
    serveSelf(req, rec);
  } else {
    giver.rec.peer.send(req);
  }
  renderFleet();
}

function pickGiver(borrowerKey, model = null) {
  const eff = effectiveLoad();
  const picked = routePickGiver(app.workers, {
    borrowerKey,
    model,
    self: selfGiver(),
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  return picked.giver;
}

async function serveSelf(req, borrowerRec) {
  const t0 = Date.now();
  try {
    // The host's own device is a giver under the same pin: a job naming a
    // model it isn't loaded with is refused, never silently answered.
    const loaded = app.hubEngine?.modelId || app.modelId;
    if (req.model && !answers(loaded, req.model)) {
      throw new Error(`model_mismatch: host loaded with ${loaded}, job asked for ${req.model}`);
    }
    const { text } = await app.hubEngine.infer(
      req.messages,
      { stream: true, temperature: req.temperature, max_tokens: req.max_tokens },
      (delta) => {
        app.relay.get(req.id)?.arm?.();
        borrowerRec.peer?.send({ type: "token", id: req.id, text: delta });
      },
    );
    const r = app.relay.get(req.id);
    if (r) clearTimeout(r.timer);
    app.relay.delete(req.id);
    noteObserved("self", Date.now() - t0, true);
    settle("self", r?.borrowerKey || "");
    borrowerRec.peer?.send({ type: "result", id: req.id, text, duration_ms: Date.now() - t0 });
  } catch (e) {
    const r = app.relay.get(req.id);
    if (r) clearTimeout(r.timer);
    app.relay.delete(req.id);
    noteObserved("self", Date.now() - t0, false);
    borrowerRec.peer?.send({ type: "error", id: req.id, message: String(e?.message || e) });
  }
}

/* ------------------------------------------- the organism's nerves ----
   Controller-to-controller DataChannels: work migrates over these when one
   heimdall has no local giver. RtcPeer is reused whole — a coord peer is a
   worker peer pointed at a sibling, speaking fwd-* envelopes instead of
   infer. Timeouts keep every migration loud: a link that won't open in
   15s, a job unanswered in 120s, both fail the borrower with words. */

const COORD_OPEN_MS = 15_000;

function coordSend(siblingKey, msg) {
  const c = app.coordPeers.get(siblingKey);
  if (c?.peer?.opened) {
    c.peer.send(msg);
    return true;
  }
  return false;
}

/** Open (or reuse) the coord link to a sibling controller. Inbound offers
 *  (inbound=true, from onSignal) only bind the peer — the offer itself is
 *  handled by the caller right after. */
function ensureCoordLink(device, inbound = false) {
  const key = controllerKey(device);
  const existing = app.coordPeers.get(key);
  // One link per sibling: concurrent forwards share the pending open
  // instead of orphaning duplicate peers.
  if (existing?.peer) {
    if (existing.peer.opened) return Promise.resolve(existing.peer);
    if (existing.opening) return existing.opening;
  }
  const entry = { device, peer: null, status: "linking", opening: null };
  const opening = new Promise((resolve, reject) => {
    const peer = new RtcPeer({
      signal: (label, data) =>
        app.matrix
          .sendSignalRetry(device, { type: "signal", deviceId: app.matrix.deviceId, label, data })
          .then(() => {}),
      onOpen: () => {
        entry.status = "open";
        renderFleet();
        resolve(peer);
      },
      onClose: () => {
        entry.status = "lost";
        renderFleet();
        setTimeout(() => {
          if (app.coordPeers.get(key) === entry) app.coordPeers.delete(key);
        }, 5000);
      },
      onMessage: (cmsg) => onCoordMessage(key, device, cmsg),
    });
    entry.peer = peer;
    app.coordPeers.set(key, entry);
    renderFleet();
    if (!inbound) {
      peer.offer().catch((e) => {
        app.coordPeers.delete(key);
        reject(e);
      });
      setTimeout(() => {
        if (!peer.opened) {
          app.coordPeers.delete(key);
          reject(new Error("coord link timed out"));
        }
      }, COORD_OPEN_MS);
    } else {
      // Inbound: the offer arrives via onSignal right after — resolve now
      // so the caller can handle it; if nothing ever comes, reap the husk.
      resolve(peer);
      setTimeout(() => {
        if (!peer.opened && app.coordPeers.get(key) === entry) app.coordPeers.delete(key);
      }, COORD_OPEN_MS);
    }
  });
  entry.opening = opening;
  opening.then(
    () => { entry.opening = null; },
    () => { if (app.coordPeers.get(key)?.opening === opening) app.coordPeers.delete(key); },
  );
  return opening;
}

/** Migrate a borrow no local giver could serve. Tries each able sibling
 *  once (tried-list, huginn's discipline); the first open link that takes
 *  the job wins. Rejects when nobody can — the caller then fails loudly. */
async function forwardJobToSibling(borrowerKey, borrowerRec, msg, wantModel) {
  const tried = [];
  for (;;) {
    const { forwarder } = pickForwarder(app.controllers, {
      wantModel,
      tried,
      idx: app.fwdIdx++,
    });
    if (!forwarder) throw new Error("no sibling can serve");
    tried.push(forwarder.key);
    const device = { userId: forwarder.rec.userId, deviceId: forwarder.rec.deviceId };
    let peer;
    try {
      peer = await ensureCoordLink(device);
      if (!peer.opened) throw new Error("coord link not open");
    } catch {
      continue; // this sibling unreachable — try the next, never stall
    }
    const fwdId = crypto.randomUUID();
    const env = makeFwdJob({
      fwdId,
      from: controllerKey({ userId: app.matrix.userId, deviceId: app.matrix.deviceId }),
      job: {
        id: msg.id,
        model: wantModel,
        messages: msg.messages || [{ role: "user", content: msg.prompt }],
        temperature: msg.temperature ?? 0.7,
        max_tokens: msg.max_tokens ?? 1024,
      },
    });
    const t0 = Date.now();
    const timer = setTimeout(() => {
      if (!app.fwdRelay.has(fwdId)) return;
      app.fwdRelay.delete(fwdId);
      noteObserved(forwarder.key, null, false);
      borrowerRec.peer?.send?.({ type: "error", id: msg.id, message: "sibling heimdall timed out — try again" });
      renderFleet();
    }, JOB_TIMEOUT_MS);
    app.fwdRelay.set(fwdId, { borrowerKey, borrowerRec, siblingKey: forwarder.key, t0, timer, jobId: msg.id });
    app.route.inflight = routeMarkSent(app.route.inflight, forwarder.key);
    peer.send(env);
    return; // handed off — tokens/results land in onCoordMessage
  }
}

/** One hop's far end. fwd-job is SERVED here (never re-forwarded — ttl 1),
 *  fwd-token/result/error continue a job we originated. */
function onCoordMessage(siblingKey, siblingDevice, cmsg) {
  if (!cmsg || typeof cmsg !== "object") return;
  if (cmsg.kind === "fwd-job") {
    serveForwarded(siblingKey, cmsg);
    return;
  }
  const st = app.fwdRelay.get(cmsg.fwdId);
  if (!st) return;
  if (cmsg.kind === "fwd-token") {
    if (st.borrowerRec?.peer?.opened) st.borrowerRec.peer.send({ type: "token", id: st.jobId, text: cmsg.text });
  } else if (cmsg.kind === "fwd-result" || cmsg.kind === "fwd-error") {
    app.fwdRelay.delete(cmsg.fwdId);
    clearTimeout(st.timer);
    // Per-hop settlement: the sibling earned with us, the borrower owes us.
    // Symmetric with every direct route — the organism keeps no central
    // wallet, each link settles its own.
    noteObserved(st.siblingKey, Date.now() - st.t0, cmsg.kind === "fwd-result");
    if (cmsg.kind === "fwd-result") settle(st.siblingKey, st.borrowerKey);
    if (st.borrowerRec?.peer?.opened) {
      st.borrowerRec.peer.send(
        cmsg.kind === "fwd-result"
          ? { type: "result", id: st.jobId, text: cmsg.text, duration_ms: cmsg.duration_ms }
          : { type: "error", id: st.jobId, message: cmsg.message },
      );
    }
    renderFleet();
  }
}

/** Serve a sibling's forwarded job from LOCAL givers only. The sibling is
 *  the borrower of record: settlement and credit flow through the existing
 *  relay path unchanged, via a virtual borrowerRec that speaks fwd-*
 *  back over the coord link. */
function serveForwarded(siblingKey, env) {
  const fail = (message) => coordSend(siblingKey, { kind: "fwd-error", fwdId: env.fwdId, id: env.job?.id, message });
  const v = validFwdJob(env, app.seenFwd);
  if (!v.ok) {
    if (v.reason !== "forward_replay") fail(`refused forward: ${v.reason}`);
    return;
  }
  app.seenFwd.push(env.fwdId);
  if (app.seenFwd.length > 500) app.seenFwd.splice(0, app.seenFwd.length - 500);
  // Same job.id twice (an origin retry after its own timeout, while we still
  // serve the first): refuse rather than overwrite the live relay entry,
  // which would let the first timer kill the second job.
  if (app.relay.has(env.job.id)) {
    fail("already serving that job here — dedupe by job id");
    return;
  }
  const wantModel = env.job.model ?? null;
  if (wantModel && isRoomMouth(wantModel)) {
    fail("remote Matrix mouth — not routable to local workers");
    return;
  }
  const eff = effectiveLoad();
  const picked = routePickGiver(app.workers, {
    borrowerKey: siblingKey, // a sibling is never its own giver
    model: wantModel,
    self: selfGiver(),
    inflight: eff.inflight,
    meanMs: eff.meanMs,
    queued: queuedLoad(),
    idx: app.route.idx++,
  });
  if (!picked.giver) {
    fail(picked.reason === "no_giver_for_model" ? `no giver loaded with ${wantModel} here` : "no giver available here");
    return;
  }
  const giver = picked.giver;
  // Virtual borrower: the relay path settles (giver ↔ sibling) and pushes
  // credit exactly as for a direct borrow; only the last mile differs.
  const virtualRec = {
    peer: {
      opened: true,
      send: (m) => {
        if (m.type === "token") coordSend(siblingKey, { kind: "fwd-token", fwdId: env.fwdId, id: env.job.id, text: m.text });
        else if (m.type === "result") coordSend(siblingKey, { kind: "fwd-result", fwdId: env.fwdId, id: env.job.id, text: m.text, duration_ms: m.duration_ms });
        else if (m.type === "error") coordSend(siblingKey, { kind: "fwd-error", fwdId: env.fwdId, id: env.job.id, message: m.message });
      },
    },
  };
  const req = {
    type: "infer",
    id: env.job.id,
    model: wantModel,
    messages: env.job.messages,
    stream: true,
    temperature: env.job.temperature ?? 0.7,
    max_tokens: env.job.max_tokens ?? 1024,
  };
  app.route.inflight = routeMarkSent(app.route.inflight, giver.key);
  const t0 = Date.now();
  const timer = setTimeout(() => {
    if (!app.relay.has(req.id)) return;
    app.relay.delete(req.id);
    noteObserved(giver.key, null, false);
    fail("giver timed out — try again");
    renderFleet();
  }, JOB_TIMEOUT_MS);
  app.relay.set(req.id, { giverKey: giver.key, borrowerKey: siblingKey, borrowerRec: virtualRec, t0, model: wantModel, timer });
  if (giver.key === "self") serveSelf(req, virtualRec);
  else giver.rec.peer.send(req);
}

/* ------------------------------------------------------ removal, via matrix
   Removing a horse is three acts, each enforced by a different body:
     1. the ROOM — kick (leave now; the public link lets them back in) or
        ban (out until unban). The homeserver enforces it for every surface.
     2. the ACCOUNT — a revoked-device entry every controller on this account
        consults before offering a link, plus the pairing is forgotten so a
        return must prove its code again.
     3. the LINK — a courtesy "revoked" notice, the channel closed, the
        record dropped. The worker stops serving at once, not at next ping.
   Order: link first (the notice must go while the link's Olm session is
   warm), then account, then room. A failure in any later step is toasted,
   never silent — the earlier steps have already stood the horse down. */
async function removeWorker(key, { ban = false, reason = "" } = {}) {
  const rec = app.workers.get(key);
  if (!rec) return;
  const { userId, deviceId } = rec.device;
  const why = reason || (ban ? "banned by the host" : "removed by the host");
  try {
    if (rec.peer?.opened) rec.peer.send({ type: "revoked", reason: why });
    await app.matrix?.sendSignalRetry(rec.device, { type: "revoked", deviceId: app.matrix.deviceId, reason: why }, 2);
  } catch {}
  dropWorker(key);
  const creds = app.session?.creds;
  if (creds) {
    try {
      // A ban revokes the user (every device); a kick revokes this device.
      app.revoked = await revokeDevice({ creds, userId, deviceId: ban ? null : deviceId, reason: why });
      app.revokedAt = Date.now();
      await forgetPairedKey({ creds, userId, deviceId: ban ? null : deviceId });
    } catch (e) {
      // The registry read/write failed: still enforce it here (reconcile drops
      // it at the next tick) and keep it until a later read sees it saved.
      const entry = revokeEntry({ userId, deviceId: ban ? null : deviceId, reason: why });
      app.revokedPending = withRevoked(app.revokedPending, entry);
      app.revoked = withRevoked(app.revoked, entry);
      toast(`revoked locally, but the account registry did not save: ${e.message}`);
    }
  }
  try {
    if (ban) await app.matrix.ban(userId, why);
    else await app.matrix.kick(userId, why);
    toast(`${ban ? "banned" : "removed"} ${userId}`);
  } catch (e) {
    toast(`${userId} dropped and revoked, but the room ${ban ? "ban" : "kick"} failed: ${e.message}`);
  }
  renderFleet();
}

/** Undo a removal: clear the registry entry, unban if banned. The device
 *  still has to open the link and prove its code again — restoring trust
 *  is never silent either. */
async function restoreDevice(entry) {
  const creds = app.session?.creds;
  if (!creds) return;
  try {
    app.revoked = await unrevokeDevice({ creds, userId: entry.userId, deviceId: entry.deviceId ?? null });
    app.revokedAt = Date.now();
    if (app.matrix?.bannedMembers().includes(entry.userId)) await app.matrix.unban(entry.userId);
    toast(`restored ${entry.userId}${entry.deviceId ? ` (${entry.deviceId})` : ""} — they must re-pair to serve again`);
  } catch (e) {
    toast(`could not restore: ${e.message}`);
  }
  renderFleet();
}

function nudgeRenew(key) {
  const rec = app.workers.get(key);
  if (rec?.peer?.opened) rec.peer.send({ type: "renew" });
}

function sendInferAll() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;
  const id = crypto.randomUUID();
  const run = beginRun(id, prompt);
  // A broadcast fans out to every eligible giver (each model answers in
  // its own voice — that IS the experiment). Per-target inflight is
  // tracked so the next borrowed job sees the real load.
  let sent = 0;
  for (const [wkey, rec] of app.workers) {
    if (rec.peer?.opened && rec.status !== "expired" && hasAccepted(rec) && !leaseLapsed(rec)) {
      rec.peer.send({
        type: "infer",
        id,
        model: rec.hello?.model ?? null, // labelled, so a mismatch is visible, never silent
        messages: [{ role: "user", content: prompt }],
        stream: true,
        temperature: 0.7,
        max_tokens: 1024,
      });
      app.route.inflight = routeMarkSent(app.route.inflight, wkey);
      app.deadlines.arm(wkey, id);
      openRunStream(id, wkey, rec.hello?.name || rec.device.userId, rec.hello?.model ?? null);
      sent++;
    }
  }
  const self = selfGiver();
  if (self) {
    openRunStream(id, "self", "you (this device)", self.model);
    const req = {
      type: "infer",
      id: `self:${id}`,
      model: self.model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    };
    app.route.inflight = routeMarkSent(app.route.inflight, "self");
    const t0 = Date.now();
    app.hubEngine
      .infer(req.messages, { stream: true, temperature: 0.7, max_tokens: 1024 }, (d) => pushRunToken(id, "self", d))
      .then(({ text }) => {
        noteObserved("self", Date.now() - t0, true);
        finishRunStream(id, "self", `[done ${Date.now() - t0}ms]`, true);
      })
      .catch((e) => {
        noteObserved("self", Date.now() - t0, false);
        finishRunStream(id, "self", `[error] ${e?.message || e}`, false);
      });
    sent++;
  }
  if (!sent) {
    run.headEl.append(el("span", { class: "muted", text: " — no live workers connected" }));
    endRun(id);
    toast("no live workers connected");
  }
}

/* -------------------------------------------------------- run streams */

/** Every broadcast run gets a group: a muted prompt header, then one
 *  streaming block per giver. Tokens land in the block for the worker that
 *  sent them — a live cursor marks the one still writing. */
function beginRun(id, prompt) {
  const run = { id, streams: new Map() };
  const rootEl = el("div", { class: "run" });
  const headEl = el("div", { class: "run-head", text: `▶ ${prompt}` });
  run.rootEl = rootEl;
  run.headEl = headEl;
  rootEl.append(headEl);
  streamsEl.append(rootEl);
  app.runs.set(id, run);
  streamsEl.scrollTop = streamsEl.scrollHeight;
  return run;
}

function openRunStream(runId, wkey, label, model) {
  const run = app.runs.get(runId);
  if (!run) return null;
  const existing = run.streams.get(wkey);
  if (existing) return existing;
  const head = el("div", { class: "stream-head" }, [
    statusDot("busy", "streaming"),
    el("span", { class: "name", text: label }),
    model ? el("span", { class: "badge", text: model }) : null,
    el("span", { class: "status", text: "streaming…" }),
  ]);
  const body = el("div", { class: "stream-body" });
  const caret = el("span", { class: "caret", text: "▌" });
  body.append(caret);
  const stream = el("div", { class: "stream" }, [head, body]);
  run.rootEl.append(stream);
  const rec = { stream, head, body, caret };
  run.streams.set(wkey, rec);
  streamsEl.scrollTop = streamsEl.scrollHeight;
  return rec;
}

function pushRunToken(runId, wkey, text) {
  const run = app.runs.get(runId);
  const rec = run?.streams.get(wkey);
  if (!rec) return;
  // Insert ahead of the caret so the cursor always rides the latest token.
  rec.caret.insertAdjacentText("beforebegin", text);
  streamsEl.scrollTop = streamsEl.scrollHeight;
}

function finishRunStream(runId, wkey, note, ok) {
  const run = app.runs.get(runId);
  const rec = run?.streams.get(wkey);
  if (!rec) return;
  rec.stream.classList.add("done");
  rec.stream.classList.add(ok ? "ok" : "err");
  rec.caret.remove();
  rec.body.append(el("div", { class: "run-note", text: note }));
  const dot = rec.stream.querySelector(".dot");
  if (dot) dot.className = `dot ${ok ? "dot-ok" : "dot-err"}`;
  const status = rec.stream.querySelector(".status");
  if (status) status.textContent = ok ? "done" : "failed";
  streamsEl.scrollTop = streamsEl.scrollHeight;
  let open = 0;
  for (const [, s] of run.streams) if (!s.stream.classList.contains("done")) open++;
  if (open === 0) endRun(runId);
}

function endRun(runId) {
  app.runs.delete(runId);
}

function clearRuns() {
  app.runs.clear();
  streamsEl.textContent = "";
}

/* ---------------------------------------------------------------- worker */

function inviteExpired() {
  return !!share.exp && Date.now() > share.exp;
}

async function acceptDuty() {
  if (app.removed) {
    toast(`this device was removed by the host (${app.removed.reason}) — ask for a fresh link and pair again`);
    return;
  }
  if (inviteExpired()) {
    toast(`this invite expired — ask ${share.name || "the host"} for a fresh link`);
    return;
  }
  // The pairing is cryptographic. Your device holds an ECDSA keypair; the
  // 6-digit code is a fingerprint of its PUBLIC KEY, and you prove the pairing
  // by signing it with the PRIVATE KEY. The host records the code you give
  // them, then verifies: recorded code ⟷ key fingerprint ⟷ valid signature.
  const verifiedFlag = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1";
  if (!verifiedFlag) {
    await ensureDeviceKeys();
    if (!share.key && !/^\d{6}$/.test(app.pairCode || "")) {
      toast("waiting for your device code…");
      return;
    }
  }
  acceptBtnEl.disabled = true;
  acceptBtnEl.textContent = "Joining…";
  try {
    const matrix = await ensureMatrix();
    await matrix.joinRoom(app.roomId);
    app.creatorId = await matrix.roomCreatorFetched();
    startWorkerDiag();
    renderIdentity();

    // Hard consent gate: the identity claimed on the link must actually own
    // the room. Otherwise a forged link+code could route a device into a
    // stranger's fleet while impersonating the intended host.
    if (!app.creatorId) {
      reenableAccept();
      statusEl.textContent = "Couldn't reach the room — check the connection and tap Start again.";
      return;
    }
    if (share.host && app.creatorId !== share.host) {
      reenableAccept();
      statusEl.textContent = `blocked: the room belongs to ${app.creatorId}, not ${share.host}`;
      toast("refused — this link impersonates the host");
      return;
    }

    if (!verifiedFlag) {
      // Prove the pairing: fingerprint code + signed payload to the host.
      const codeHash = await sha256Hex(share.key || app.pairCode);
      const payload = pairingPayload(app.roomId, matrix.userId, matrix.deviceId, codeHash);
      const sig = await signText(app.pairPriv, payload);
      const confirmed = await hostConfirmCode(matrix, codeHash, app.pairPub, sig);
      if (!confirmed) {
        reenableAccept();
        statusEl.textContent = share.key ? "blocked: the host didn't confirm this link — it may have expired, or their page is closed" : "blocked: the host didn't confirm your code";
        toast(share.key ? "the host didn't confirm this link — is their heimdall page open?" : "the host didn't confirm your code — they may be offline, or the code is wrong");
        return;
      }
      // Confirmed once by the host on this device → lease renewals don't re-ask.
      localStorage.setItem(`heimdall.verified.${app.roomId}`, "1");
    }

    statusEl.textContent = "Loading model…";
    // The download started when the page opened (prefetchModel); this
    // joins it rather than starting over.
    if (!app.modelReady) app.modelReady = prefetchModel();
    await app.modelReady;
    if (!app.engine?.loaded) throw new Error(modelStatusEl.textContent || "the model did not load");

    app.leaseUntil = app.resumeLease && app.resumeLease > Date.now() ? app.resumeLease : Date.now() + LEASE_TTL;
    app.resumeLease = null;
    app.leaseExpired = false;
    app.renewRequested = false;
    localStorage.setItem(`heimdall.lease.${app.roomId}`, String(app.leaseUntil));
    for (const peer of app.peers.values()) {
      if (peer.opened) peer.send({ type: "lease", until: app.leaseUntil, leaseMs: leaseMsFor(app.leaseUntil), queueDepth: app.engine?.pending ?? 0 });
    }
    statusEl.textContent = `Standing by until ${countdownText(app.leaseUntil)}`;
    acceptBtnEl.textContent = "Renew compute duties";

    await announceReady();
    restartInterval(app.slots, "ready", () => announceReady(), 20000);
    restartInterval(app.slots, "ping", () => {
      for (const peer of app.peers.values()) {
        if (peer.opened) {
          peer.send({
            type: "ping",
            hwid: HWID,
            hidden: document.hidden,
            t: Date.now(),
            queueDepth: app.engine?.pending ?? 0,
            model: app.engine?.loaded ? app.engine.modelId : null,
            ctx: app.engine?.contextWindow ?? null,
          });
        }
      }
    }, 15000);
    await keepAwake();
    if (!app.visibilityHooked) {
      app.visibilityHooked = true;
      // Leaving the app throttles (then freezes) this page: say so now, so
      // the host holds our place instead of timing us out; say so again on
      // return, so work resumes at once.
      document.addEventListener("visibilitychange", () => {
        for (const peer of app.peers.values()) {
          if (peer.opened) peer.send({ type: "ping", hwid: HWID, hidden: document.hidden, t: Date.now(), queueDepth: app.engine?.pending ?? 0, model: app.engine?.loaded ? app.engine.modelId : null });
        }
        if (!document.hidden) announceReady().catch(() => {});
      });
    }
    renderWorkerStatus();
    updateComposer();
    toast("you are compute now. keep this tab open.");
  } catch (e) {
    reenableAccept();
    statusEl.textContent = `failed: ${e.message}`;
    toast(`accept failed: ${e.message}`);
  }
}

/** Start downloading and loading the model the moment the link opens, so it
 *  is ready by the time pairing is done. WebLLM caches the weights on the
 *  device; a second visit loads from the cache. If the default model will
 *  not load here (memory, GPU), fall back to the small one — unless the
 *  person picked the model themselves. */
/** No usable GPU: run the small model on the CPU instead of giving up. */
async function loadOnCpu() {
  const onProgress = (p) => {
    const pct = Math.round((p.progress || 0) * 100);
    if (pct > 0 && pct < 100) progressEl.hidden = false;
    progressFillEl.style.width = `${pct}%`;
    modelStatusEl.textContent = pct < 100 ? `Downloading the model (no GPU — using the processor)… ${pct}%` : "Starting the model…";
  };
  app.engine = new WasmEngine(onProgress);
  try {
    await app.engine.load();
    progressEl.hidden = true;
    app.modelId = app.engine.modelId;
    modelStatusEl.textContent = simple ? "Ready (on the processor — no GPU)." : `${app.engine.modelId} — ready on the CPU`;
    renderWorkerStatus();
  } catch (e) {
    progressEl.hidden = true;
    modelStatusEl.textContent = `model failed to load: ${e?.message || e}`;
  }
}

async function prefetchModel() {
  if (!webgpuAvailable()) return loadOnCpu();
  if (!webgpuAvailable()) {
    modelStatusEl.textContent = simple
      ? "This browser can't use the phone's GPU. Open this link in Chrome."
      : "This browser has no WebGPU, so it can't run a model. On iPhone use Safari (iOS 26+); on Android use Chrome.";
    return;
  }
  if (!app.engine) {
    app.engine = newWebllmEngine((p) => {
      if (p.progress > 0 && p.progress < 1) progressEl.hidden = false;
      progressFillEl.style.width = `${Math.round((p.progress || 0) * 100)}%`;
      const pct = Math.round((p.progress || 0) * 100);
      modelStatusEl.textContent = simple ? (pct < 100 ? `Downloading the model… ${pct}%` : "Starting the model…") : p.text || "downloading model";
    });
  }
  const want = app.modelId;
  try {
    modelStatusEl.textContent = simple ? "Getting ready…" : `getting ${labelOf(want)} ready…`;
    await app.engine.load(want);
    progressEl.hidden = true;
    modelStatusEl.textContent = simple ? "Ready." : `${labelOf(app.engine.modelId)} ready`;
    renderWorkerStatus();
  } catch (e) {
    progressEl.hidden = true;
    if (/GPU|adapter|WebGPU/i.test(String(e?.message || e))) {
      toast("no usable GPU here — running on the processor instead");
      return loadOnCpu();
    }
    if (!app.modelChosen && want !== FALLBACK_MODEL) {
      toast(`${labelOf(want)} didn't fit on this device — using a smaller model`);
      app.modelId = FALLBACK_MODEL;
      const sel = document.getElementById("model-select");
      if (sel) sel.value = FALLBACK_MODEL;
      return prefetchModel();
    }
    modelStatusEl.textContent = `model failed to load: ${e?.message || e}`;
  }
}

function labelOf(id) {
  return MODEL_CHOICES.find((m) => m.id === id)?.label.split(" — ")[0] || id;
}

function reenableAccept() {
  acceptBtnEl.disabled = false;
  acceptBtnEl.textContent = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1"
    ? "Renew compute duties"
    : "Accept compute duties";
}

/** The device's persistent ECDSA keypair; the pairing code is its fingerprint. */
async function ensureDeviceKeys() {
  const key = `heimdall.keys.${app.roomId}`;
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(key) || "null");
  } catch {}
  if (stored?.pub && stored?.priv) {
    app.pairPub = stored.pub;
    app.pairPriv = await importPrivateKeyJwk(stored.priv);
    app.pairCode = await codeFromPublicKey(stored.pub);
    return;
  }
  const fresh = await generateDeviceKeyPair();
  localStorage.setItem(key, JSON.stringify({ pub: fresh.pubB64, priv: fresh.privJwk }));
  app.pairPub = fresh.pubB64;
  app.pairPriv = fresh.privateKey;
  app.pairCode = await codeFromPublicKey(fresh.pubB64);
}

/** Send the signed pairing proof to the host and wait for confirmation. */
function hostConfirmCode(matrix, codeHash, pubKey, sig) {
  return new Promise((resolve) => {
    let resend = null;
    let timer = null;
    // Whoever answers (verified / denied, or the timeout) stops the resends.
    app.pendingVerify = (v) => {
      clearInterval(resend);
      clearTimeout(timer);
      resolve(v);
    };
    const giveUp = () => {
      clearInterval(resend);
      if (app.pendingVerify) {
        app.pendingVerify = null;
        app.onAwaitingCode = null;
        resolve(false);
      }
    };
    timer = setTimeout(giveUp, 25000);
    const sendProof = () =>
      matrix.devicesOf(app.creatorId, { retry: 3 }).then((devs) => {
        for (const d of devs) {
          matrix
            .sendSignalRetry(d, { type: "verify", deviceId: matrix.deviceId, codeHash, pubKey, sig }, 3)
            .catch(() => {});
        }
        return devs;
      });
    // The host answered "not recorded yet": they are there, just haven't
    // typed the code. Wait for them (the host re-checks when they do).
    app.onAwaitingCode = () => {
      clearTimeout(timer);
      timer = setTimeout(giveUp, 15 * 60_000);
      // Re-offer the proof now and then: if the host's page reloads while
      // we wait, it forgets this attempt, and a fresh offer lets the code
      // they type still find us.
      if (!resend) resend = setInterval(() => { if (app.pendingVerify) sendProof().catch(() => {}); }, 20_000);
      statusEl.replaceChildren(
        el("div", { class: "alert warn" }, [
          el("div", { text: "Almost there — type this code on your computer:" }),
          el("div", { class: "kbd big", text: app.pairCode || "" }),
        ]),
      );
    };
    sendProof()
      .then((devs) => {
        if (!devs.length) {
          clearTimeout(timer);
          app.pendingVerify = null;
          resolve(false);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        app.pendingVerify = null;
        resolve(false);
      });
  });
}

async function announceReady() {
  if (!app.matrix || !app.creatorId || !app.leaseUntil) return;
  const devs = await app.matrix.devicesOf(app.creatorId, { retry: 0 });
  for (const device of devs) {
    await app.matrix.sendSignalRetry(
      device,
      {
        type: "ready",
        hwid: HWID,
        hidden: document.hidden,
        deviceId: app.matrix.deviceId,
        model: app.engine?.loaded ? app.engine.modelId : null, // the weights actually loaded, never the picker alone
        queueDepth: app.engine?.pending ?? 0,
        name: deviceName(),
        leaseUntil: app.leaseUntil,
        leaseMs: leaseMsFor(app.leaseUntil), // remaining, judged on the controller's clock not ours
      },
      3,
    );
  }
}

/** The worker's side of the relay: the host found no direct path. */
function openWorkerRelay(remoteDevice) {
  const key = deviceKey(remoteDevice);
  const old = app.peers.get(key);
  if (old?.relay) {
    old.send(workerHello()); // the host's page may be new: introduce ourselves again
    return old;
  }
  if (old) {
    old.onClose = () => {};
    old.close();
  }
  const peer = new RelayPeer({
    send: (msgs) => app.matrix.sendSignalRetry(remoteDevice, { type: "relay", deviceId: app.matrix.deviceId, msgs }, 3),
    onMessage: (msg) => onWorkerRtcMessage(peer, msg),
  });
  app.peers.set(key, peer);
  peer.send(workerHello());
  renderWorkerStatus();
  return peer;
}

/** What the browser will actually hand a page: one adapter request per
 *  option set (WebLLM asks for high-performance), measured once. */
let gpuProbeResult = null;
async function gpuProbe() {
  if (gpuProbeResult) return gpuProbeResult;
  const out = { ua: navigator.userAgent.slice(0, 160) };
  for (const [name, opts] of [["default", {}], ["high", { powerPreference: "high-performance" }], ["low", { powerPreference: "low-power" }], ["fallback", { forceFallbackAdapter: true }]]) {
    try {
      const a = await navigator.gpu?.requestAdapter?.(opts);
      out[name] = a ? { ok: true, f16: a.features?.has?.("shader-f16"), vendor: a.info?.vendor || "", arch: a.info?.architecture || "", maxBuf: a.limits?.maxBufferSize } : { ok: false };
    } catch (e) {
      out[name] = { error: String(e?.message || e).slice(0, 80) };
    }
  }
  return (gpuProbeResult = out);
}

function startWorkerDiag() {
  if (app.diagTimer) return;
  app.diagTimer = setInterval(async () => {
    if (!app.matrix || !app.creatorId) return;
    const state = {
      page: "simple:" + simple,
      build: BUILD,
      model: app.engine?.modelId || null,
      loaded: !!app.engine?.loaded,
      status: statusEl?.textContent?.slice(0, 120) || "",
      modelStatus: modelStatusEl?.textContent?.slice(0, 80) || "",
      lease: app.leaseUntil ? Math.round((app.leaseUntil - Date.now()) / 60000) + "m" : null,
      peers: [...app.peers.entries()].map(([k, p]) => ({ k: k.slice(-12), relay: !!p.relay, opened: !!p.opened, state: p.pc?.connectionState || null, ice: p.pc?.iceConnectionState || null })),
      recv: (app.matrix.recvLog || []).slice(-12).map((r) => `${r.kind || r.type}${r.failed ? "!FAIL" : ""}@${Math.round((Date.now() - r.at) / 1000)}s`),
      pendingVerify: !!app.pendingVerify,
      webgpu: webgpuAvailable(),
      gpu: await gpuProbe(),
    };
    try {
      const devs = await app.matrix.devicesOf(app.creatorId, { retry: 0 });
      for (const d of devs) app.matrix.sendSignal(d, { type: "diag", deviceId: app.matrix.deviceId, state }).catch(() => {});
    } catch {}
  }, 10_000);
}

function workerHello() {
  return {
    hwid: HWID,
    hidden: document.hidden,
    type: "hello",
    role: "worker",
    deviceId: app.matrix.deviceId,
    model: app.engine?.loaded ? app.engine.modelId : null,
    ctx: app.engine?.contextWindow ?? null,
    queueDepth: app.engine?.pending ?? 0,
    name: deviceName(),
    ua: navigator.userAgent,
    leaseUntil: app.leaseUntil,
    leaseMs: leaseMsFor(app.leaseUntil),
  };
}

function ensureWorkerPeer(remoteDevice) {
  const key = deviceKey(remoteDevice);
  if (app.peers.has(key)) return app.peers.get(key);
  const peer = new RtcPeer({
    signal: (label, data) =>
      app.matrix
        .sendSignalRetry(remoteDevice, { type: "signal", deviceId: app.matrix.deviceId, label, data })
        .then(() => {}),
    onOpen: () => {
      renderWorkerStatus();
      peer.send({
        hwid: HWID,
        hidden: document.hidden,
        type: "hello",
        role: "worker",
        deviceId: app.matrix.deviceId,
        model: app.engine?.loaded ? app.engine.modelId : null, // the weights actually loaded, never the picker alone
        ctx: app.engine?.contextWindow ?? null,
        queueDepth: app.engine?.pending ?? 0,
        name: deviceName(),
        ua: navigator.userAgent,
        leaseUntil: app.leaseUntil,
        leaseMs: leaseMsFor(app.leaseUntil),
      });
    },
    onClose: () => renderWorkerStatus(),
    onMessage: (msg) => onWorkerRtcMessage(peer, msg),
  });
  app.peers.set(key, peer);
  return peer;
}

async function onWorkerRtcMessage(peer, msg) {
  if (msg.type === "renew") {
    app.renewRequested = true;
    renderWorkerStatus();
    toast(`${share.name || "the host"} asked you to renew your compute lease`);
    return;
  }
  if (msg.type === "credit") {
    app.credit = { give: msg.give, borrow: msg.borrow, credit: msg.credit };
    if (msg.own) app.own = true;
    renderWorkerStatus();
    updateComposer();
    return;
  }
  if (msg.type === "token") {
    workerConsolePush(msg.text);
    return;
  }
  if (msg.type === "result") {
    workerConsolePush(`\n[done ${msg.duration_ms}ms]\n`);
    return;
  }
  if (msg.type === "error") {
    workerConsolePush(`\n[error] ${msg.message}\n`);
    return;
  }
  if (msg.type !== "infer") return;
  if (app.removed) {
    peer.send({ type: "error", id: msg.id, message: `removed by the host — ${app.removed.reason}` });
    return;
  }
  if (!app.engine) {
    peer.send({ type: "error", id: msg.id, message: "engine not ready" });
    return;
  }
  if (app.leaseExpired || !app.leaseUntil || Date.now() > app.leaseUntil) {
    peer.send({ type: "error", id: msg.id, message: "compute lease expired — renew to keep serving" });
    return;
  }
  // Model pin, enforced at the edge: a job naming a model this device
  // isn't loaded with is refused loudly, never answered with the wrong
  // weights. The router should have avoided this; this is the wall behind
  // that wall.
  const loaded = app.engine?.modelId || app.modelId; // the weights, never the picker alone
  if (msg.model && !answers(loaded, msg.model)) {
    peer.send({ type: "error", id: msg.id, message: `model_mismatch: loaded with ${loaded}, job asked for ${msg.model}` });
    return;
  }
  const t0 = Date.now();
  activityStart(msg);
  try {
    const { text } = await app.engine.infer(
      msg.messages || [{ role: "user", content: msg.prompt }],
      {
        stream: msg.stream !== false,
        temperature: msg.temperature ?? 0.7,
        max_tokens: msg.max_tokens ?? 1024,
      },
      (delta) => {
        activityToken(delta);
        peer.send({ type: "token", id: msg.id, text: delta });
      },
    );
    peer.send({ type: "result", id: msg.id, text, duration_ms: Date.now() - t0 });
    activityEnd(true, Date.now() - t0);
    renderWorkerStatus();
  } catch (e) {
    activityEnd(false);
    peer.send({ type: "error", id: msg.id, message: String(e?.message || e) });
  }
}

/* ---- what this phone is doing right now: shown, so running inference on
   the phone is something you can see happen, not take on faith. ---- */
const activity = { running: 0, served: 0, lastMs: null };
let activityEl, activityTextEl;

function activityStart(msg) {
  activity.running++;
  const ask = (msg.messages || []).filter((m) => m.role === "user").at(-1)?.content || msg.prompt || "";
  if (activityTextEl) {
    activityTextEl.textContent = "";
    activityTextEl.dataset.ask = String(ask).slice(0, 140);
  }
  renderActivity();
}
function activityToken(delta) {
  if (!activityTextEl) return;
  activityTextEl.textContent = (activityTextEl.textContent + delta).slice(-600);
}
function activityEnd(ok, ms) {
  activity.running = Math.max(0, activity.running - 1);
  if (ok) {
    activity.served++;
    activity.lastMs = ms;
  }
  renderActivity();
}
function renderActivity() {
  if (!activityEl) return;
  const on = activity.running > 0;
  activityEl.classList.toggle("on", on);
  activityEl.querySelector(".act-label").textContent = on
    ? "Running inference on this phone"
    : activity.served
      ? `Idle · ${activity.served} answered${activity.lastMs ? ` · last ${(activity.lastMs / 1000).toFixed(1)}s` : ""}`
      : app.leaseUntil ? "Ready — waiting for work" : "Not lending yet";
  const ask = activityTextEl?.dataset.ask;
  activityEl.querySelector(".act-ask").textContent = on && ask ? ask : "";
}

function borrowNow() {
  const prompt = borrowEl?.value?.trim();
  if (!prompt) return;
  if (!app.own && app.credit.credit <= 0) {
    toast("no credit — serve compute to the fleet first, then borrow");
    return;
  }
  const peer = [...app.peers.values()].find((p) => p.opened);
  if (!peer) {
    toast("not connected to the fleet");
    return;
  }
  borrowEl.value = "";
  workerConsolePush(`${workerConsoleEl?.textContent ? "\n\n" : ""}▶ ${prompt}\n`);
  // model: null = any giver (shortest expected wait). A surface that needs
  // a specific model sets it to that exact WebLLM id and the router pins it.
  peer.send({ type: "job", id: crypto.randomUUID(), prompt, model: null, temperature: 0.7, max_tokens: 1024 });
}

function workerConsolePush(text) {
  if (!workerConsoleEl) return;
  workerConsoleEl.textContent += text;
  workerConsoleEl.scrollTop = workerConsoleEl.scrollHeight;
}

function updateComposer() {
  if (!borrowBtnEl) return;
  const can = app.own || app.credit.credit > 0;
  borrowBtnEl.disabled = !can;
  borrowHintEl.textContent = simple
    ? (can ? "" : "available once lending starts")
    : app.own
    ? `${share.name || "the host"} marked this as their own device — ask away (answered by the computer or any other device)`
    : can
    ? `credit ${app.credit.credit} — you can borrow`
    : "you have not given any compute yet — serve a job first, then you can borrow";
}

/** The host removed this device. Stand down at once: no lease, no serving,
 *  no re-announce; forget the room pairing so a return must prove its code
 *  again. `via` names which body said so — the room (authoritative) or a
 *  to-device notice from the creator (courtesy, arrives first). */
function onRemoved(reason, via) {
  if (app.removed) return;
  app.removed = { reason, via, at: Date.now() };
  app.leaseUntil = 0;
  app.leaseExpired = true;
  app.renewRequested = false;
  try {
    localStorage.removeItem(`heimdall.lease.${app.roomId}`);
    localStorage.removeItem(`heimdall.verified.${app.roomId}`);
  } catch {}
  for (const peer of app.peers.values()) {
    try { peer.close(); } catch {}
  }
  app.peers.clear();
  if (acceptBtnEl) {
    acceptBtnEl.disabled = true;
    acceptBtnEl.textContent = "Removed by the host";
  }
  if (statusEl) statusEl.textContent = `removed: ${reason}`;
  renderWorkerStatus();
  toast(`the host removed this device — ${reason}`);
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator) {
      app.wakeLock = await navigator.wakeLock.request("screen");
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") {
          try {
            app.wakeLock = await navigator.wakeLock.request("screen");
          } catch {}
        }
      });
    }
  } catch {}
}

/* ------------------------------------------------------------------- view */

let qrEl, bridgeCardEl, bridgeStatusEl, ownBoxEl;
let shareBoxEl, inviteExpiryEl, fullLinkBtnEl, fleetCardEl, promptCardEl, promptEl, streamsEl, lendBtnEl, lendStatusEl;
let acceptBtnEl, statusEl, progressEl, progressFillEl, modelStatusEl, codeEl, identityEl, borrowEl, borrowBtnEl, borrowHintEl, workerConsoleEl;

function header() {
  return el("header", { class: "site" }, [
    el("h1", { text: "heimdall" }),
    el("span", { class: "sub", text: "distributed local inference — matrix + webrtc + webllm" }),
  ]);
}

function foldCard() {
  return el("div", { class: "card" }, [
    el("h2", { text: "Also: the fold" }),
    el("p", { class: "muted", text: "The same page can stand up the fold — a personal reading instrument that remembers everything you discuss with it. Two ways in:" }),
    el("div", { class: "col" }, [
      el("div", { class: "row" }, [
        el("span", { class: "badge ok", text: "try it" }),
        el("a", { href: FOLD_WEB, target: "_blank", rel: "noopener", text: "open the fold in this browser — WebGPU, no install" }),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "badge", text: "run it" }),
        el("code", { text: FOLD_CMD }),
        copyBtn("copy", () => FOLD_CMD),
      ]),
    ]),
  ]);
}

function loginCard() {
  const hs = el("input", { value: app.hs, placeholder: "https://homeserver" });
  const user = el("input", { placeholder: "username" });
  const pass = el("input", { type: "password", placeholder: "password" });
  const out = el("div", { class: "col" }, [
    el("label", { text: "homeserver" }), hs,
    el("label", { text: "username" }), user,
    el("label", { text: "password" }), pass,
    el("button", {
      class: "primary",
      text: "Sign in with my own account",
      onclick: async () => {
        try {
          const baseUrl = await homeserverFor(user.value, hs.value.trim() || DEFAULT_HS);
          await tryLogin({ baseUrl, username: user.value.trim(), password: pass.value });
        } catch (e) {
          toast(`login failed: ${e.message}`);
        }
      },
    }),
  ]);
  return el("div", { class: "card", hidden: false }, [
    el("h2", { text: "optional: use your own matrix account" }),
    el("p", { class: "muted", text: "By default every device auto-creates a throwaway account on hyphae.social. Sign in here instead if you want a real account." }),
    out,
  ]);
}

/** Signed in with a real account (a generated one keeps its password). */
function signedIn() {
  return !!app.session?.creds && !app.session.creds.password;
}

function signInScreen(onSkip) {
  const user = el("input", { placeholder: "username or @you:server", autocomplete: "username", autocapitalize: "off" });
  const pass = el("input", { type: "password", placeholder: "password", autocomplete: "current-password" });
  const hs = el("input", { value: DEFAULT_HS, placeholder: "https://homeserver" });
  const err = el("div", { class: "muted small" });
  const go = el("button", { class: "primary big", text: "Sign in" });
  const submit = async () => {
    go.disabled = true;
    go.textContent = "Signing in…";
    err.textContent = "";
    try {
      const baseUrl = await homeserverFor(user.value, hs.value.trim() || DEFAULT_HS);
      await tryLogin({ baseUrl, username: user.value.trim(), password: pass.value });
    } catch (e) {
      err.textContent = `Couldn't sign in: ${e.message}`;
      go.disabled = false;
      go.textContent = "Sign in";
    }
  };
  go.onclick = submit;
  pass.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  return el("div", { class: "view simple" + (embed ? " embed" : "") }, [
    el("div", { class: "card center" }, [
      el("h2", { text: "Sign in" }),
      el("div", { class: "col" }, [
        user,
        pass,
        el("details", { class: "small" }, [el("summary", { class: "muted", text: "server" }), hs]),
        go,
        err,
      ]),
      el("button", { class: "ghost small", text: app.session?.creds ? "keep using the temporary account" : "use a temporary account instead", onclick: onSkip }),
    ]),
  ]);
}

function controllerView() {
  const nameEl = el("input", { value: app.displayName, placeholder: "your name shown to workers" });
  nameEl.addEventListener("change", () => {
    app.displayName = nameEl.value.trim();
    localStorage.setItem(NAME_KEY, app.displayName);
    if (app.roomId) refreshShareBox();
  });

  shareBoxEl = el("input", { readonly: true, value: "", placeholder: "share link appears here" });
  inviteExpiryEl = el("div", { class: "muted small" });
  // The box carries the short link (typable); the QR and this button carry
  // the full link (a phone scans and auto-pairs, no code to read out).
  fullLinkBtnEl = el("button", { class: "ghost small", text: "full link", hidden: "", onclick: async () => {
    try {
      await navigator.clipboard.writeText(await buildInviteUrl());
      toast("full link copied");
    } catch {
      toast("could not copy — use the share box");
    }
  } });
  const shareRow = el("div", { class: "linkbox" }, [
    shareBoxEl,
    copyBtn("copy", () => shareBoxEl.value),
    fullLinkBtnEl,
    el("button", { class: "ghost small", text: "renew link", onclick: renewInvite }),
  ]);

  // The worker generates the pairing code on their device and gives it to you
  // out of band. You record it here to onboard them; it never rides in the link.
  const workerCodeEl = el("input", { placeholder: "6-digit code a worker gave you", inputmode: "numeric" });
  const recordBtn = el("button", {
    class: "primary",
    text: "Record",
    onclick: async () => {
      const code = workerCodeEl.value.trim();
      if (!/^\d{6}$/.test(code)) {
        toast("enter the 6-digit code your worker gave you");
        return;
      }
      if (!app.session?.creds) {
        toast("not signed in yet — create or rejoin a fleet first");
        return;
      }
      try {
        recordBtn.disabled = true;
        const waited = await recordCode(code, ownBoxEl.checked);
        workerCodeEl.value = "";
        if (!waited) toast(`recorded ${code} — that device can accept now`);
      } catch (e) {
        toast(`could not record: ${e.message}`);
      } finally {
        recordBtn.disabled = false;
      }
    },
  });
  workerCodeEl.addEventListener("keydown", (e) => { if (e.key === "Enter") recordBtn.click(); });
  ownBoxEl = el("input", { type: "checkbox" });
  const ownRow = el("label", { class: "row small" }, [
    ownBoxEl,
    el("span", { text: "this is my own device — it can use this computer's inference without earning credit first" }),
  ]);
  const pendingEl = el("div", { class: "alert warn", id: "pending-pairs", hidden: true });
  qrEl = el("div", { class: "qr", hidden: true, title: "scan with your phone's camera" });
  const codeRow = el("div", { class: "linkbox" }, [
    workerCodeEl,
    recordBtn,
    el("span", { class: "muted small", text: "their code → you record it → they accept" }),
  ]);

  const cliCmd = "npx --yes github:scores-patch-points/heimdall invite";
  const cliRow = el("div", { class: "row" }, [
    el("span", { class: "muted small", text: "or mint the link from any terminal / the fold:" }),
    el("code", { text: cliCmd }),
    copyBtn("copy", () => cliCmd),
  ]);

  const createBtn = el("button", {
    class: "primary",
    text: app.session?.roomId ? "Rejoin last fleet" : "Create fleet room",
    onclick: () => (app.session?.roomId ? rejoin() : createRoom()),
  });
  const freshBtn = el("button", { class: "ghost", text: "New room", onclick: createRoom });

  fleetCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Workers" }),
    el("div", { class: "muted small", id: "siblings" }),
    el("ul", { class: "fleet", id: "fleet" }),
    el("div", { class: "col", id: "revoked" }),
  ]);

  promptEl = el("textarea", { placeholder: "send a prompt to every connected worker…" });
  streamsEl = el("div", { class: "streams" });
  promptCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "Run" }),
    promptEl,
    el("div", { class: "row" }, [
      el("button", { class: "primary", text: "Run on all workers", onclick: sendInferAll }),
      el("button", { class: "ghost small", text: "clear log", onclick: clearRuns }),
    ]),
    streamsEl,
  ]);

  lendBtnEl = el("button", {
    class: "ghost",
    text: "Lend my device",
    onclick: lendMyDevice,
  });
  lendStatusEl = el("div", { class: "muted small" });
  const lendCard = el("div", { class: "card" }, [
    el("h2", { text: "Give compute" }),
    el("p", { class: "muted", text: "Inference runs both ways. Lend this device too, and you earn credit back to the fleet instead of only borrowing." }),
    el("div", { class: "row" }, [lendBtnEl, lendStatusEl]),
  ]);

  bridgeStatusEl = el("div", { class: "col" });
  const hostsLine = "ER7_OLLAMA_HOSTS=local=http://localhost:11434,fleet=" + location.origin;
  bridgeCardEl = el("div", { class: "card", hidden: true }, [
    el("h2", { text: "This computer" }),
    el("ol", { class: "steps" }, [
      el("li", { text: "Scan the QR code below with your phone. It opens heimdall and starts downloading its model." }),
      el("li", { text: "Tap Accept on the phone. It shows a 6-digit code." }),
      el("li", { text: "Type that code below. Both machines are then connected." }),
    ]),
    bridgeStatusEl,
    el("p", { class: "muted small", text: `Programs on this computer reach the phones at ${location.origin}, which works like an Ollama server. If no phone has the requested model, the request goes to your real Ollama instead. For eoreader7, set:` }),
    el("div", { class: "row" }, [el("code", { text: hostsLine }), copyBtn("copy", () => hostsLine)]),
  ]);

  // Served by `heimdall up` (or embedded in the Fold): one thing to do —
  // scan. Everything else folds under "more".
  if (app.bridgeInfo) {
    let startFleetEl;
    const view = el("div", { class: "view simple" + (embed ? " embed" : "") }, [
      el("div", { class: "card center" }, [
        el("h2", { text: app.session?.roomId ? "Scan with your phone" : "Share this computer's compute" }),
        app.session?.roomId ? null : (startFleetEl = el("button", { class: "primary big", text: "Start", onclick: async () => {
          startFleetEl.disabled = true;
          startFleetEl.textContent = "Starting…";
          await createRoom();
          startFleetEl.hidden = true;
          view.querySelector("h2").textContent = "Scan with your phone";
        } })),
        qrEl,
        bridgeStatusEl,
      ].filter(Boolean)),
      fleetCardEl,
      el("details", { class: "card more" }, [
        el("summary", { class: "muted", text: "more" }),
        el("div", { class: "row" }, [createBtn, freshBtn]),
        shareRow,
        inviteExpiryEl,
        el("p", { class: "muted small", text: "Programs on this computer reach the phone at " + location.origin + " (it speaks Ollama). For eoreader7:" }),
        el("div", { class: "row" }, [el("code", { text: hostsLine }), copyBtn("copy", () => hostsLine)]),
        lendCard,
        loginCard(),
      ]),
    ]);
    return view;
  }

  if (embed) {
    return el("div", { class: "view embed" }, [
      bridgeCardEl,
      el("div", { class: "card" }, [
        el("div", { class: "row" }, [createBtn, freshBtn]),
        shareRow,
        qrEl,
        pendingEl,
        codeRow,
        ownRow,
        inviteExpiryEl,
      ]),
      fleetCardEl,
      lendCard,
    ]);
  }

  return el("div", { class: "view" }, [
    header(),
    bridgeCardEl,
    el("div", { class: "card" }, [
      el("h2", { text: "Fleet" }),
      el("p", { class: "muted", text: "The link names you, carries an expiry, and a secret code the worker must enter to accept. The room is only a directory — prompts and answers travel device-to-device over WebRTC, never through the room. Everyone who borrows must first give." }),
      el("label", { text: "your name" }),
      nameEl,
      el("div", { class: "row", style: "" }, [createBtn, freshBtn]),
      shareRow,
      qrEl,
      pendingEl,
      codeRow,
      ownRow,
      cliRow,
      inviteExpiryEl,
    ]),
    fleetCardEl,
    promptCardEl,
    lendCard,
    foldCard(),
    loginCard(),
    footer(),
  ]);
}

function renderFleet() {
  // The organism view: every heimdall here is one animal. Same-account
  // siblings merge load signal; allied accounts migrate work over coord
  // links. Routing stays independent — no leader, no central queue — so
  // this line is awareness, never control.
  const sibEl = document.getElementById("siblings");
  if (sibEl && app.matrix) {
    const now = Date.now();
    const ctrls = [...app.controllers.entries()].filter(([, c]) => now - c.at <= CONTROLLER_TTL_MS);
    const parts = [];
    if (app.ally) parts.push("ally mode — this room belongs to another account; contributing compute, accepting forwards");
    if (ctrls.length) {
      const ids = [String(app.matrix.deviceId), ...ctrls.map(([, c]) => String(c.deviceId)).filter(Boolean)];
      const leader = electLeader(ids);
      const allies = ctrls.filter(([, c]) => !c.sameAccount).length;
      parts.push(`${ctrls.length + 1} heimdalls, one animal${allies ? ` (${allies} allied)` : ""} — display led by ${leader === String(app.matrix.deviceId) ? "you" : leader}`);
    } else if (!app.ally) {
      parts.push("sole heimdall on this fleet");
    }
    const coordOpen = [...app.coordPeers.values()].filter((c) => c.peer?.opened).length;
    if (coordOpen) parts.push(`${coordOpen} coord link${coordOpen > 1 ? "s" : ""} open`);
    sibEl.textContent = parts.join(" · ");
  }
  bridgeNudge();
  renderBridge();
  const ul = document.getElementById("fleet");
  if (!ul) return;
  ul.replaceChildren();
  if (app.workers.size === 0) {
    ul.append(el("li", { class: "muted", text: "No workers yet. Share the link and wait for an accept." }));
    return;
  }
  for (const [key, rec] of app.workers) {
    const h = rec.hello;
    const standing = standingOf(rec);
    const color = standing === "ready" ? "ok" : standing === "stale" || standing === "linking" || standing === "away" || standing === "idle" ? "warn" : "err";
    const name = h?.name || rec.device.userId;
    const queue = rec.queueDepth ? ` · queued ${rec.queueDepth}` : "";
    const pace = app.route.meanMs[key] ? ` · ~${Math.round(app.route.meanMs[key] / 100) / 10}s avg` : "";
    const meta = h ? `${h.model || ""}${queue}${pace}` : `linking…`;
    const l = ledgerOf(key);
    const credit = l.give || l.borrow
      ? ` · gave ${l.give} took ${l.borrow}`
      : "";
    const lease = el("span", {
      class: "countdown muted",
      "data-until": h?.leaseUntil || 0,
      text: h?.leaseUntil ? countdownText(h.leaseUntil) : "…",
    });
    ul.append(
      el("li", { class: "worker" }, [
        statusDot(color, standing),
        el("div", { class: "who" }, [
          el("div", { class: "name", text: name }),
          el("div", { class: "meta", text: meta + credit }),
          el("div", { class: "meta", text: lastSeenText(rec.lastSeen) + (rec.renewed ? " · renewed" : "") }),
        ]),
        lease,
        (app.route.inflight[key] ?? 0) > 0 || (rec.queueDepth ?? 0) > 0
          ? el("span", { class: "badge running", text: "running now" })
          : el("span", { class: "badge", text: standing }),
        el("button", { class: "ghost small", text: "renew", onclick: () => nudgeRenew(key) }),
        el("button", { class: "ghost small", title: "kick from the room and revoke this device", text: "remove", onclick: () => removeWorker(key) }),
        el("button", { class: "ghost small", title: "ban from the room and revoke every device of this account", text: "ban", onclick: () => removeWorker(key, { ban: true }) }),
      ]),
    );
  }
  renderRevoked();
}

/** The account's removed devices, with a way back. Read from the account
 *  so a removal made on the CLI or the fold shows here too. */
function renderRevoked() {
  const box = document.getElementById("revoked");
  if (!box) return;
  box.replaceChildren();
  const list = app.revoked || [];
  if (!list.length) return;
  box.append(el("div", { class: "muted small", text: `removed: ${list.length}` }));
  for (const e of list) {
    box.append(
      el("div", { class: "row" }, [
        el("span", { class: "badge err", text: e.deviceId == null ? "banned" : "removed" }),
        el("span", { class: "small", text: `${e.userId}${e.deviceId ? ` · ${e.deviceId}` : " · every device"}${e.reason ? ` — ${e.reason}` : ""}` }),
        el("button", { class: "ghost small", text: "restore", onclick: () => restoreDevice(e) }),
      ]),
    );
  }
}

function lastSeenText(ts) {
  if (!ts) return "…";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function simpleWorkerView() {
  const who = share.name || share.host || "your computer";
  acceptBtnEl = el("button", { class: "primary big", text: "Start", onclick: acceptDuty });
  progressEl = el("div", { class: "progress", hidden: true });
  progressFillEl = el("div");
  progressEl.append(progressFillEl);
  modelStatusEl = el("div", { class: "muted small" });
  statusEl = el("div", { class: "muted small" });

  const modelSel = el(
    "select",
    { id: "model-select" },
    MODEL_CHOICES.map((m) => el("option", { value: m.id, selected: m.id === app.modelId ? "" : null, text: m.label })),
  );
  modelSel.addEventListener("change", () => {
    app.modelId = modelSel.value;
    app.modelChosen = true;
    localStorage.setItem(MODEL_KEY, app.modelId);
    app.modelReady = prefetchModel();
  });

  activityTextEl = el("div", { class: "act-text" });
  activityEl = el("div", { class: "activity" }, [
    el("div", { class: "row" }, [el("span", { class: "act-dot" }), el("span", { class: "act-label" })]),
    el("div", { class: "act-ask muted small" }),
    activityTextEl,
  ]);

  borrowEl = el("textarea", { placeholder: `Ask ${who}…` });
  borrowBtnEl = el("button", { class: "primary", text: "Ask", disabled: "", onclick: borrowNow });
  borrowHintEl = el("div", { class: "muted small" });
  workerConsoleEl = el("div", { class: "console", text: "" });

  const view = el("div", { class: "view simple" }, [
    el("div", { class: "card" }, [
      el("h2", { text: "Lend this phone" }),
      modelStatusEl,
      progressEl,
      el("div", { style: "height:8px" }),
      acceptBtnEl,
      statusEl,
    ].filter(Boolean)),
    el("div", { class: "card", id: "worker-status" }, [activityEl]),
    el("details", { class: "card more" }, [
      el("summary", { class: "muted", text: app.session?.creds?.userId ? `signed in as ${app.session.creds.userId}` : "sign in (optional)" }),
      el("p", { class: "muted small", text: "Sign in with the same account as your computer to keep one account for all your devices." }),
      loginCard(),
    ]),
  ]);
  renderActivity();
  return view;
}

function workerView() {
  const roomBox = el("div", { class: "row" }, [
    el("span", { class: "badge", text: `room ${app.roomId || "…"}` }),
    el("span", { class: "badge", text: app.hs }),
  ]);

  identityEl = el("div", { class: "col" });
  renderIdentity();

  const who = share.name || share.host || "someone";
  const ipEl = el("span", { class: "muted small", text: "looking up your IP…" });
  publicIp().then((ip) => {
    app.myIp = ip;
    ipEl.textContent = `Your public IP: ${ip} — the host can see this (and your device type) once you connect.`;
  });

  const modelSel = el(
    "select",
    { id: "model-select" },
    MODEL_CHOICES.map((m) =>
      el("option", { value: m.id, selected: m.id === app.modelId ? "" : null, text: m.label }),
    ),
  );
  modelSel.addEventListener("change", () => {
    app.modelId = modelSel.value;
    app.modelChosen = true;
    localStorage.setItem(MODEL_KEY, app.modelId);
    app.modelReady = prefetchModel();
  });

  const verifiedFlag = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1";
  const pairBox = el("div", { class: "alert warn" });
  if (!verifiedFlag) {
    // Load the device keypair and show its fingerprint code.
    ensureDeviceKeys()
      .then(() => {
        if (!app.pairCode) return;
        pairBox.replaceChildren(
          el("div", { class: "row" }, [
            el("span", { text: "Your code (fingerprint of this device's key): " }),
            el("span", { class: "kbd", text: app.pairCode }),
            copyBtn("copy", () => app.pairCode),
          ]),
          el("div", { class: "muted small", text: "Send this code to the host out of band. When you accept, this device proves it with its private key — the code alone can't be faked." }),
        );
        if (codeEl) codeEl.value = app.pairCode;
      })
      .catch(() => {
        pairBox.textContent = "could not create this device's key";
      });
  }

  codeEl = el("input", {
    placeholder: "6-digit code",
    inputmode: "numeric",
    readonly: verifiedFlag ? true : "",
    autocomplete: "off",
    oninput: (e) => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    },
  });

  const acceptCard = el("div", { class: "card" });
  acceptBtnEl = el("button", {
    class: "primary big",
    text: verifiedFlag ? "Renew compute duties" : "Accept compute duties",
    onclick: acceptDuty,
  });
  progressEl = el("div", { class: "progress", hidden: true });
  progressFillEl = el("div");
  progressEl.append(progressFillEl);

  const expLine = el("div", {
    class: "muted small",
    text: share.exp ? `this invite ${countdownText(share.exp)}` : "no expiry set on this link — treat it with care",
  });
  const codeLine = el("div", {
    class: "alert " + (verifiedFlag ? "ok" : "warn"),
    text: verifiedFlag
      ? "This device is already paired for this room — renewals skip the proof."
      : "Your code is the fingerprint of this device's key, and it is confirmed live by the host with a signature — a stolen link or a leaked code alone can't fake the pairing.",
  });

  acceptCard.append(
    el("h2", { text: "Lend this device" }),
    el("p", { class: "muted", text: `Accepting runs a small language model in this tab and makes it available to ${who}. Nothing is stored on a server; your device does the compute. The lease lasts 12 hours and must be renewed. Inference is mutual — you lend your compute, and you can borrow from the fleet only what you have given.` }),
    el("label", { text: "model" }),
    modelSel,
    el("div", { class: "row" }, [
      webgpuAvailable()
        ? el("span", { class: "badge ok", text: "WebGPU ready" })
        : el("span", { class: "badge warn", text: "no WebGPU — inference will be slow or fail" }),
      el("span", { class: "badge", text: deviceName() }),
    ]),
    el("div", { style: "height:10px" }),
    pairBox,
    codeLine,
    el("label", { text: verifiedFlag ? "already paired" : "your device code" }),
    codeEl,
    el("div", { style: "height:10px" }),
    acceptBtnEl,
    expLine,
    progressEl,
  );

  statusEl = el("div", { class: "col" });
  modelStatusEl = el("span", { class: "muted small" });

  borrowEl = el("textarea", { placeholder: "borrow compute from the fleet — ask anything…" });
  borrowBtnEl = el("button", { class: "primary", text: "Borrow compute", disabled: "", onclick: borrowNow });
  borrowHintEl = el("div", { class: "muted small", text: "you have not given any compute yet — serve a job first, then you can borrow" });
  workerConsoleEl = el("div", { class: "console", text: "" });
  const borrowCard = el("div", { class: "card" }, [
    el("h2", { text: "Borrow compute" }),
    el("p", { class: "muted", text: "Inference is mutual: you give compute by serving jobs, and you can borrow from the fleet only what you have already given." }),
    borrowEl,
    el("div", { class: "row" }, [borrowBtnEl, borrowHintEl]),
    workerConsoleEl,
  ]);

  return el("div", { class: "view" }, [
    header(),
    roomBox,
    el("div", { class: "card" }, [
      el("h2", { text: "Who is asking" }),
      identityEl,
      ipEl,
    ]),
    acceptCard,
    el("div", { class: "card", id: "worker-status" }, [
      el("h2", { text: "Status" }),
      statusEl,
      modelStatusEl,
    ]),
    borrowCard,
    foldCard(),
    loginCard(),
    footer(),
  ]);
}

function renderIdentity() {
  if (!identityEl) return;
  const name = share.name || share.host || "someone";
  const parts = [
    el("div", { class: "who" }, [
      el("div", { class: "name", text: name }),
      el("div", { class: "meta", text: share.host ? `matrix id: ${share.host}` : "no matrix id claimed in this link" }),
    ]),
  ];
  if (share.host) {
    if (app.creatorId) {
      if (app.creatorId === share.host) {
        parts.push(el("div", { class: "alert ok", text: "identity verified — the room was created by the account this link claims" }));
      } else {
        parts.push(el("div", { class: "alert err", text: `warning: the link claims ${share.host} but the room was actually created by ${app.creatorId}` }));
      }
    } else {
      parts.push(el("div", { class: "alert warn", text: "identity claim not yet verified — it will be checked once you join" }));
    }
  }
  identityEl.replaceChildren(...parts);
}

function renderWorkerStatus() {
  if (simple) {
    if (!statusEl) return;
    const online = [...app.peers.values()].some((p) => p.opened);
    statusEl.textContent = app.removed
      ? `Removed by ${share.name || "the host"}.`
      : app.leaseExpired
        ? "Paused — tap Start to lend again."
        : app.leaseUntil
          ? `${online ? "Connected" : "Connecting…"} · lending for ${countdownText(app.leaseUntil).replace(/^in /, "")}`
          : "";
    if (acceptBtnEl && app.leaseUntil && !app.leaseExpired && !app.removed) {
      acceptBtnEl.textContent = "Lending";
      acceptBtnEl.disabled = true;
    } else if (acceptBtnEl && (app.leaseExpired || app.renewRequested)) {
      acceptBtnEl.textContent = "Start";
      acceptBtnEl.disabled = false;
    }
    renderActivity();
    return;
  }
  const box = document.getElementById("worker-status");
  if (!box || !statusEl) return;
  const online = [...app.peers.values()].filter((p) => p.opened).length;
  const leaseBadge = app.removed
    ? el("span", { class: "badge err", text: `removed by the host (${app.removed.via})` })
    : app.leaseExpired
    ? el("span", { class: "badge err", text: "lease expired" })
    : app.leaseUntil
      ? el("span", { class: "countdown badge ok", "data-until": app.leaseUntil, text: `lease ${countdownText(app.leaseUntil)}` })
      : el("span", { class: "badge", text: "no lease yet" });
  const creditBadge = el("span", {
    class: `badge ${app.credit.credit > 0 ? "ok" : "warn"}`,
    text: `credit ${app.credit.credit} (gave ${app.credit.give}, took ${app.credit.borrow})`,
  });
  const renewBtn = !app.removed && (app.leaseExpired || app.renewRequested)
    ? el("button", { class: "primary small", text: "Renew now", onclick: acceptDuty })
    : null;
  const lines = [
    el("div", { class: "row" }, [
      el("span", { class: "badge", text: `links: ${online}` }),
      app.wakeLock ? el("span", { class: "badge ok", text: "screen awake" }) : null,
      el("span", { class: "badge", text: `model: ${app.modelId}` }),
      creditBadge,
      leaseBadge,
      renewBtn,
    ]),
  ].filter(Boolean);
  statusEl.replaceChildren(...lines);
}

function footer() {
  return el("div", { class: "foot" }, [
    el("span", { text: "heimdall — matrix signaling · webrtc data · webllm compute. the fold docks here too." }),
    el("span", { style: "margin-left:8px" }),
    el("button", { class: "ghost small", text: "reset session", onclick: () => { clearSession(); location.reload(); } }),
  ]);
}

/* ------------------------------------------------------------------ tick */

setInterval(tick, 1000);

function tick() {
  document.querySelectorAll(".countdown[data-until]").forEach((elNode) => {
    const until = Number(elNode.dataset.until);
    elNode.textContent = until ? countdownText(until) : "…";
  });
  if (mode === "worker") workerTick();
  if (mode === "controller") controllerTick();
}

function workerTick() {
  if (app.leaseUntil && !app.leaseExpired && Date.now() > app.leaseUntil) {
    app.leaseExpired = true;
    renderWorkerStatus();
    toast("your compute lease expired — renew to keep serving");
  }
}

function controllerTick() {
  const now = Date.now();
  let changed = false;
  for (const [key, rec] of app.workers) {
    if (leaseLapsed(rec, now) && rec.status !== "expired") {
      rec.status = "expired";
      nudgeRenew(key);
      changed = true;
    }
    // Liveness is derived from the last ping, never from the channel
    // alone (liveness.js): a silent horse goes stale (shown, not routed),
    // then dead (link torn down and re-offered through Matrix).
    const standing = standingOf(rec, now);
    if (standing !== rec.standing) {
      rec.standing = standing;
      changed = true;
    }
    if (shouldRelink(rec, now) && rec.status !== "lost" && !jobInFlight(key)) {
      dropWorker(key);
      reconcile();
      changed = true;
    }
  }
  if (changed) renderFleet();
}

/* ------------------------------------------------------------------ boot */

async function main() {
  const root = document.getElementById("app");
  // One controller per browser. Two tabs (or this page and the Fold's
  // sheet) sharing one Matrix session would fight over the same device.
  if (mode === "controller" && navigator.locks) {
    const got = await new Promise((resolve) => {
      navigator.locks.request("heimdall-controller", { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise(() => {}) : undefined; // hold it for the page's life
      });
    });
    if (!got) {
      root.append(
        el("div", { class: "view" + (embed ? " embed" : "") }, [
          el("div", { class: "card" }, [
            el("h2", { text: "Heimdall is already running" }),
            el("p", { class: "muted", text: "Another tab in this browser (or the Fold's Heimdall sheet) is already the controller. Use that one, or close it and reload this." }),
          ]),
        ]),
      );
      return;
    }
  }
  if (mode === "controller") app.bridgeInfo = await detectBridge();
  // A short invite (`?r=<code>`) names no room: resolve the code to the fleet
  // room before anything renders, so lease/verified resume reads the right
  // keys and the room badge isn't null. A failure still renders the worker
  // view (acceptDuty will re-ask and the toast already said so).
  if (mode === "worker" && share?.shortCode) {
    try {
      await ensureMatrix();
    } catch {}
  }
  const skipped = sessionStorage.getItem("heimdall.skipSignIn") === "1";
  if (mode === "controller" && app.bridgeInfo && !signedIn() && !skipped) {
    // First screen on this computer: who is this fleet for.
    root.append(signInScreen(() => { sessionStorage.setItem("heimdall.skipSignIn", "1"); location.reload(); }));
    return;
  }
  root.append(mode === "controller" ? controllerView() : simple ? simpleWorkerView() : workerView());
  if (mode === "controller" && app.session?.roomId) {
    rejoin();
  }
  if (mode === "worker") {
    const saved = Number(localStorage.getItem(`heimdall.lease.${app.roomId}`) || 0);
    if (saved) {
      app.leaseUntil = saved;
      app.leaseExpired = saved <= Date.now();
    }
    renderWorkerStatus();
    updateComposer();
    app.modelReady = prefetchModel();
    // A reload inside a live lease (the host asked for one, the tab was
    // discarded, the phone rebooted) picks up where it left off — the lease
    // was already consented to, and it is kept, never extended.
    const paired = localStorage.getItem(`heimdall.verified.${app.roomId}`) === "1";
    if (paired && saved > Date.now()) {
      app.resumeLease = saved;
      acceptDuty();
    }
  }
  if (mode === "controller") startBridge();
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

main();