// liveness.js — how a horse is known to be running (2026-09-21).
//
// Before this, the controller only learned a worker was gone when its
// DataChannel CLOSED. A suspended tab, a sleeping phone, a NAT that quietly
// dropped the path — none of these close the channel promptly, so the
// fleet list read "ready" for a horse that had not been heard from in
// minutes, and the router kept sending it work that timed out at 120s.
//
// The worker pings every PING_EVERY_MS over the channel. The controller
// derives standing from the last ping, never from the channel alone:
//
//   ready    heard within STALE_AFTER_MS — routable
//   stale    3 pings missed — shown, NOT routable; the channel is left
//            alone (a phone waking from sleep recovers by itself)
//   dead     DEAD_AFTER_MS silent — the link is torn down and re-offered
//            through Matrix, exactly as if it had closed
//   lost     the channel itself closed
//   expired  the lease lapsed (the worker's own hand renews it)
//   linking  offered, not yet open
//
// A silent horse is never convicted on the first missed ping; a dead one is
// never left in the list forever. Both bounds are stated here and tested.
//
// Revocation lives here too: the controller account keeps a revoked-device
// registry (invite.js REVOKED_TYPE). `isRevoked` is what reconcile consults
// so a removed device is never re-offered a link, by ANY surface signed
// into the account — the room ban is the homeserver's wall, this is ours.

export const PING_EVERY_MS = 15_000;
export const STALE_AFTER_MS = 45_000; // 3 missed pings
export const DEAD_AFTER_MS = 90_000; // 6 missed pings → relink
// A phone that said it left the app (tab hidden): its timers are throttled
// and it may be frozen. Held, never routed to, and only given up on after this.
export const AWAY_HOLD_MS = 30 * 60_000;

/** Derive a worker's standing from evidence the controller already keeps.
 *  `rec.lastSeen` is the last ping/hello/lease/result; null = never heard
 *  (linking). `now` injected for tests. */
export function standingOf(rec, now = Date.now()) {
  if (!rec) return "lost";
  if (rec.status === "lost") return "lost";
  if (!rec.peer?.opened) return "linking";
  if (rec.hello?.leaseUntil && now > rec.hello.leaseUntil) return "expired";
  if (rec.lastSeen == null) return rec.hello ? "ready" : "linking";
  const silent = now - rec.lastSeen;
  if (rec.hidden) return silent >= AWAY_HOLD_MS ? "dead" : "away";
  if (silent >= DEAD_AFTER_MS) return "dead";
  if (silent >= STALE_AFTER_MS) return "stale";
  return rec.hello ? "ready" : "linking";
}

/** True when the controller should tear the link down and re-offer. */
export function shouldRelink(rec, now = Date.now()) {
  const s = standingOf(rec, now);
  return s === "dead" || s === "lost";
}

/** True when a job may be routed to this worker: heard recently, channel
 *  open, lease live. route.js consults this through isEligible. */
export function isLive(rec, now = Date.now()) {
  return standingOf(rec, now) === "ready";
}

/** A revoked-registry entry. `deviceId` null revokes every device of the
 *  user (a ban); a specific deviceId revokes that device only. */
export function revokeEntry({ userId, deviceId = null, reason = "", at = Date.now() }) {
  return { userId, deviceId: deviceId == null ? null : String(deviceId), reason: String(reason || ""), at };
}

/** True when the device is on the revoked list — by exact device, or by a
 *  user-wide entry. */
export function isRevoked(list, { userId, deviceId }) {
  if (!Array.isArray(list)) return false;
  return list.some((e) => e && e.userId === userId && (e.deviceId == null || String(e.deviceId) === String(deviceId)));
}

/** Add an entry, replacing any older entry for the same user+device. */
export function withRevoked(list, entry) {
  const out = (Array.isArray(list) ? list : []).filter(
    (e) => !(e && e.userId === entry.userId && (e.deviceId ?? null) === (entry.deviceId ?? null)),
  );
  out.push(entry);
  return out;
}

/** Remove every entry for the user (deviceId null) or one device. */
export function withoutRevoked(list, { userId, deviceId = null }) {
  return (Array.isArray(list) ? list : []).filter((e) => {
    if (!e || e.userId !== userId) return true;
    if (deviceId == null) return false;
    return String(e.deviceId) !== String(deviceId);
  });
}
