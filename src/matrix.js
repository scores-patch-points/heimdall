import {
  createClient,
  ClientEvent,
  KnownMembership,
  RoomEvent,
  RoomStateEvent,
} from "matrix-js-sdk";

export const SIGNAL_TYPE = "org.heimdall.signal";

const ENCRYPTION_STATE = { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } };

// A short invite code is a room's local alias (`#<code>:<server>`): the code
// IS the thing a person types on the worker's computer, so the alphabet
// drops every look-alike pair (0/O, 1/I/l) and stays lowercase.
export const SHORT_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
export const SHORT_LENGTH = 5;

export function shortCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_LENGTH));
  return [...bytes].map((b) => SHORT_ALPHABET[b % SHORT_ALPHABET.length]).join("");
}

export function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** True when a createRoom/createAlias failure means the alias is taken — the
 *  one error a mint retries with a fresh code. */
export function aliasTaken(e) {
  if (e?.errcode === "M_IN_USE") return true;
  const m = String(e?.message || "").toLowerCase();
  return /in use|taken|already/.test(m);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function deviceKey(d) {
  return `${d.userId}|${d.deviceId}`;
}

/**
 * Thin wrapper around matrix-js-sdk that gives us:
 *  - a Matrix account (login or register) on any homeserver
 *  - one room per fleet, used ONLY as a directory of members
 *  - encrypted to-device messages for WebRTC signaling.
 *
 * Nothing about the actual inference payload ever touches the room:
 * that all flows over the WebRTC DataChannel.
 */
export class MatrixPeer {
  constructor({ baseUrl, userId, accessToken, deviceId, cryptoPrefix, onSignal, onSync, onMembers, onMyMembership }) {
    this.baseUrl = baseUrl;
    this.userId = userId;
    this.deviceId = deviceId;
    this.cryptoPrefix = cryptoPrefix;
    this.roomId = null;
    this.onSignal = onSignal || (() => {});
    this.onSync = onSync || (() => {});
    this.onMembers = onMembers || (() => {});
    this.onMyMembership = onMyMembership || (() => {});

    this.client = createClient({ baseUrl, userId, accessToken, deviceId });

    this.client.on(ClientEvent.Sync, (state) => {
      if (state === "PREPARED") this.onSync();
    });
    // Encrypted to-device events are decrypted for us; the type is the
    // original (our SIGNAL_TYPE) and the content is our payload.
    this.recvLog = []; // diagnostics: every to-device event, decrypted or not
    this.client.on(ClientEvent.ToDeviceEvent, (event) => {
      this.recvLog.push({
        type: event.getType(),
        kind: event.getType() === SIGNAL_TYPE ? event.getContent()?.type : null,
        from: event.getSender(),
        failed: !!event.isDecryptionFailure?.(),
        at: Date.now(),
      });
      if (this.recvLog.length > 40) this.recvLog.shift();
      if (event.getType() !== SIGNAL_TYPE) return;
      this.onSignal(event.getSender(), event.getContent());
    });
    this.client.on(RoomStateEvent.Members, (event, state) => {
      if (state.roomId === this.roomId) this.onMembers(event);
    });
    // Our own membership moving is how a worker learns it was removed:
    // a kick lands as "leave", a ban as "ban" — both from the homeserver,
    // which no forged to-device message can fake.
    this.client.on(RoomEvent.MyMembership, (room, membership, prev) => {
      if (room?.roomId !== this.roomId) return;
      if (membership === KnownMembership.Join) this.onMembers();
      this.onMyMembership(membership, prev);
    });
  }

  async start() {
    // Scope the IndexedDB crypto store to this account. The default prefix is
    // shared by every Matrix app on the same origin, which makes
    // "the account in the store doesn't match the account in the constructor"
    // blow up the moment two accounts (or two Matrix apps, like the fold)
    // touch the same browser. A per-account store means reusing the account
    // you're already logged in with just works.
    await this.client.initRustCrypto(
      this.cryptoPrefix ? { cryptoDatabasePrefix: this.cryptoPrefix } : {},
    );
    await this.client.startClient({ initialSyncLimit: 0 });
  }

  async createFleetRoom() {
    // The room is born with a short local alias (`#<code>:<server>`): the
    // invite link is then just `?r=<code>`, short enough to type by hand on
    // a worker's computer. A taken alias is the one expected collision — try
    // a fresh code; the last fallback creates the room with no alias and the
    // full link is still minted.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = shortCode();
      try {
        const res = await this.client.createRoom({
          name: `heimdall-${Math.random().toString(36).slice(2, 7)}`,
          preset: "public_chat",
          visibility: "private",
          room_alias_name: code,
          initial_state: [ENCRYPTION_STATE],
        });
        this.roomId = res.room_id;
        this.alias = code;
        return this.roomId;
      } catch (e) {
        if (aliasTaken(e)) continue;
        throw e;
      }
    }
    const res = await this.client.createRoom({
      name: `heimdall-${Math.random().toString(36).slice(2, 7)}`,
      preset: "public_chat",
      visibility: "private",
      initial_state: [ENCRYPTION_STATE],
    });
    this.roomId = res.room_id;
    this.alias = null;
    return this.roomId;
  }

  /** A short invite code is a room's local alias. Resolve `#<code>:<server>`
   *  to the room id, exactly as the matrix-js-sdk directory lookup does. */
  async resolveAlias(code) {
    const alias = `#${code}:${hostOf(this.baseUrl)}`;
    const roomId = await this.client.getRoomIdForAlias(alias);
    this.roomId = roomId;
    return roomId;
  }

  /** Recover the room's short alias after a rejoin, so the invite link keeps
   *  being typable. A room with no short alias reads null. */
  async restoreAlias() {
    try {
      const { aliases } = await this.client.getLocalAliases(this.roomId);
      const code = (aliases || [])
        .map((a) => a.split(":")[0].slice(1))
        .find((c) => /^[a-z0-9]{3,8}$/.test(c));
      this.alias = code || null;
    } catch {
      this.alias = null;
    }
    return this.alias;
  }

  /** The room carries no messages, but it must be ENCRYPTED: the crypto only
   *  tracks the device lists of people it shares an encrypted room with. In a
   *  plain room a worker whose keys were fetched a moment before it uploaded
   *  them stays "unknown device" forever, and every to-device signal to it is
   *  dropped. Idempotent; only someone allowed to set state can do it. */
  async ensureEncrypted() {
    const room = this.client.getRoom(this.roomId);
    if (room?.currentState?.getStateEvents("m.room.encryption", "")) return true;
    try {
      await this.client.sendStateEvent(this.roomId, "m.room.encryption", ENCRYPTION_STATE.content, "");
      return true;
    } catch {
      return false;
    }
  }

  async joinRoom(roomId) {
    this.roomId = roomId;
    await this.client.joinRoom(roomId);
    return this.roomId;
  }

  roomMembers() {
    const room = this.client.getRoom(this.roomId);
    if (!room) return [];
    return room
      .getJoinedMembers()
      .map((m) => m.userId)
      .filter((id) => id !== this.userId);
  }

  /** Our own membership in the fleet room: join | leave | ban | invite | null. */
  myMembership() {
    const room = this.client.getRoom(this.roomId);
    return room ? room.getMyMembership() : null;
  }

  /** Members the homeserver currently bans from the fleet room. */
  bannedMembers() {
    const room = this.client.getRoom(this.roomId);
    if (!room) return [];
    return room.getMembersWithMembership(KnownMembership.Ban).map((m) => m.userId);
  }

  /* Removal is a room-state act, enforced by the homeserver for every
     surface that ever reads the room. kick = leave now (the public link
     lets them back in); ban = leave and stay out until unban. The
     controller pairs either with a revoked-device entry on its account
     (invite.js) so its own reconcile never re-offers a link. */
  async kick(userId, reason = "removed by the host") {
    await this.client.kick(this.roomId, userId, reason);
  }

  async ban(userId, reason = "banned by the host") {
    await this.client.ban(this.roomId, userId, reason);
  }

  async unban(userId) {
    await this.client.unban(this.roomId, userId);
  }

  async leaveRoom() {
    if (!this.roomId) return;
    await this.client.leave(this.roomId);
  }

  roomCreator() {
    const room = this.client.getRoom(this.roomId);
    const create = room?.currentState?.getStateEvents("m.room.create")?.[0];
    return create ? create.getSender() : null;
  }

  /** The creator, read from the server when the room is not synced yet — a
   *  fresh join resolves before its state arrives, and reading "no creator"
   *  there made every honest link look like an impersonation. */
  async roomCreatorFetched() {
    for (let i = 0; i < 10; i++) {
      const local = this.roomCreator();
      if (local) return local;
      try {
        const events = await this.client.roomState(this.roomId);
        const create = events.find((e) => e.type === "m.room.create");
        if (create?.sender) return create.sender;
      } catch { /* not readable yet */ }
      await sleep(1000);
    }
    return null;
  }

  /**
   * Discover the E2EE-capable devices of a user. Retries because the
   * freshly-joined worker needs a sync cycle to upload its keys first.
   */
  async devicesOf(userId, { retry = 0 } = {}) {
    // matrix-js-sdk 42 has only the Rust crypto: the legacy
    // getStoredDevicesForUser/downloadKeys pair is gone, and calling it threw
    // on every lookup — so neither side could ever find the other's devices.
    const read = async (download) => {
      const map = await this.client.getCrypto()?.getUserDeviceInfo([userId], download);
      return [...(map?.get(userId)?.keys() ?? [])].map((deviceId) => ({ userId, deviceId: String(deviceId) }));
    };
    let attempts = 0;
    while (true) {
      let devs = [];
      try {
        devs = await read(false);
        if (!devs.length) devs = await read(true);
      } catch {
        /* user or device list not known yet */
      }
      if (devs.length) return devs;
      if (attempts >= retry) return [];
      attempts++;
      await sleep(2500);
    }
  }

  async sendSignal(device, content) {
    await this.client.encryptAndSendToDevice(
      SIGNAL_TYPE,
      [{ userId: device.userId, deviceId: device.deviceId }],
      content,
    );
  }

  /** Encrypted to-device, with backoff. Olm sessions may not exist yet. */
  async sendSignalRetry(device, content, attempts = 5) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.sendSignal(device, content);
        return true;
      } catch {
        if (i === attempts) return false;
        await sleep(2000 * i);
      }
    }
    return false;
  }

  stop() {
    this.client.stopClient();
  }
}

export async function login({ baseUrl, username, password }) {
  const tmp = createClient({ baseUrl });
  const res = await tmp.login("m.login.password", {
    identifier: { type: "m.id.user", user: username },
    password,
    initial_device_display_name: "heimdall",
  });
  return {
    baseUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: String(res.device_id),
  };
}

export async function register({ baseUrl, username, password }) {
  const tmp = createClient({ baseUrl });
  const res = await tmp.registerRequest(username, password, undefined, {
    initial_device_display_name: "heimdall",
  });
  if (!res?.access_token) throw new Error("registration incomplete");
  return {
    baseUrl,
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: String(res.device_id),
  };
}

/**
 * Auto-provision a Matrix account on a homeserver with open registration.
 * Handles the `m.login.dummy` UIA stage automatically (no captcha/email),
 * which is what self-hosted servers like hyphae.social use. Throws if the
 * server demands other stages — callers can fall back to a login form.
 */
export async function registerAuto({ baseUrl, username, password }) {
  const url = `${baseUrl}/_matrix/client/v3/register?kind=user`;
  const body = {
    username,
    password,
    initial_device_display_name: "heimdall",
  };
  const post = async (payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, data: await res.json() };
  };

  let { status, data } = await post(body);
  if (status === 429) throw new Error("homeserver rate limited account creation; wait a moment");
  if (data.session && Array.isArray(data.flows)) {
    const dummy = data.flows.some((f) => f.stages.includes("m.login.dummy"));
    if (!dummy) throw new Error(`registration requires ${JSON.stringify(data.flows.map((f) => f.stages))}`);
    ({ status, data } = await post({ ...body, auth: { type: "m.login.dummy", session: data.session } }));
  }
  if (!data.access_token) throw new Error(`registration failed: ${JSON.stringify(data)}`);
  return {
    baseUrl,
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: String(data.device_id),
  };
}

export function randomUsername(prefix = "heimdall") {
  const hex = crypto.getRandomValues(new Uint8Array(4)).join("");
  return `${prefix}-${hex}`;
}

/**
 * Claim the device's auto-provisioned account: set a real password so the
 * owner can log in from their other devices. Uses UIA with the current
 * (generated) password as proof of ownership.
 */
export async function claimAccount({ baseUrl, userId, accessToken, password, newPassword }) {
  const url = `${baseUrl}/_matrix/client/v3/account/password`;
  const auth = (session) => ({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: userId },
    password,
    ...(session ? { session } : {}),
  });
  const body = (session) => JSON.stringify({ new_password: newPassword, auth: auth(session) });
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };

  let res = await fetch(url, { method: "POST", headers, body: body(null) });
  let data = await res.json();
  if (res.status === 401 && data.session) {
    res = await fetch(url, { method: "POST", headers, body: body(data.session) });
    data = await res.json();
  }
  if (!res.ok) throw new Error(`claim failed: ${JSON.stringify(data)}`);
  return true;
}

export async function setDisplayName({ baseUrl, accessToken, userId, displayName }) {
  const url = `${baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ displayname: displayName }),
  });
  if (!res.ok) throw new Error(`display name failed: ${await res.text()}`);
  return true;
}

export function shareUrl(roomId, baseUrl, site) {
  const here = site ? site.replace(/\?.*$/, "") : `${location.origin}${location.pathname}`;
  return `${here}?room=${encodeURIComponent(roomId)}&hs=${encodeURIComponent(baseUrl)}`;
}

export function parseShareUrl(defaultHs) {
  const params = new URLSearchParams(location.search);
  const room = params.get("room");
  const hs = params.get("hs");
  // A short invite: just `?r=<code>` (optionally `&hs=` when the fleet is not
  // on the default server). The code is the room's local alias, resolved
  // before the worker joins; host/name/exp ride nothing here, so identity is
  // verified against the room's creator and pairing needs the 6-digit code.
  if (!room) {
    const code = String(params.get("r") || "").toLowerCase();
    if (/^[a-z0-9]{3,8}$/.test(code)) {
      return {
        shortCode: code,
        baseUrl: params.get("hs") || defaultHs || null,
        host: "",
        name: "",
        exp: 0,
        codeHash: "",
        key: "",
      };
    }
    return null;
  }
  if (!hs) return null;
  return {
    roomId: room,
    baseUrl: hs,
    host: params.get("host") || "",
    name: params.get("name") || "",
    exp: Number(params.get("exp")) || 0,
    codeHash: params.get("c") || "",
    key: params.get("k") || "", // the link's own pairing secret (the QR code carries it)
  };
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Account-scoped data: the shared code registry lives here so that any
   surface signed into the controller account (browser, CLI, fold) can issue
   and confirm invite codes. */
function apiHeaders(accessToken) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };
}

export async function setAccountData({ baseUrl, accessToken, userId, type, content }) {
  const url = `${baseUrl}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`;
  const res = await fetch(url, { method: "PUT", headers: apiHeaders(accessToken), body: JSON.stringify(content) });
  if (!res.ok) throw new Error(`account data failed: ${await res.text()}`);
  return true;
}

export async function getAccountData({ baseUrl, accessToken, userId, type }) {
  const url = `${baseUrl}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`;
  const res = await fetch(url, { headers: apiHeaders(accessToken) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`account data read failed: ${await res.text()}`);
  return res.json();
}