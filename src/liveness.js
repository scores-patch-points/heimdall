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
//   idle     linked and heard, but has NOT accepted duty (no lease yet): shown,
//            never routed to. A horse is routable only after it said it
//            accepted (hello/lease carrying leaseMs > 0 or leaseUntil > 0).
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
// A link that has been "linking" this long (offered, never opened, no relay
// fallback either) is a husk, not a slow handshake: a `ready` may drop it.
export const LINK_STUCK_MS = 30_000;

/* ----------------------------------------------------------------- lease
   Intended rule (2026-10-05, defect 6):
   - A horse is routable only after it said it accepted duty: its hello/lease
     carries leaseMs > 0 (remaining, preferred) or leaseUntil > 0 (absolute).
     An absent/0 lease means "has not accepted", NEVER "unlimited".
   - The lease is judged by the REMAINING time the worker reported
     (`leaseMs`), aged by the controller's own clock since receipt
     (`rec.leaseAt`) — the phone's clock and the controller's are never
     compared. Only an old worker that sends the absolute `leaseUntil` alone
     falls back to comparing clocks, and that comparison tolerates
     LEASE_SKEW_TOLERANCE_MS of skew before it calls the lease lapsed. */
export const LEASE_SKEW_TOLERANCE_MS = 60_000;

/** What a worker reports as its lease on the wire: remaining ms (0 = none). */
export function leaseMsFor(until, now = Date.now()) {
  return Number.isFinite(until) && until > 0 ? Math.max(0, Math.round(until - now)) : 0;
}

/** Remaining lease in ms by the controller's reckoning; null = never accepted. */
export function leaseRemainingMs(rec, now = Date.now()) {
  const h = rec?.hello;
  if (!h) return null;
  const abs = Number.isFinite(h.leaseUntil) && h.leaseUntil > 0;
  if (Number.isFinite(h.leaseMs) && (h.leaseMs > 0 || abs)) {
    const at = Number.isFinite(rec.leaseAt) ? rec.leaseAt : now;
    return h.leaseMs - Math.max(0, now - at);
  }
  if (abs) return h.leaseUntil + LEASE_SKEW_TOLERANCE_MS - now;
  return null;
}

/** True once the horse has said it accepted duty. */
export const hasAccepted = (rec) => leaseRemainingMs(rec, 0) != null;

/** True when the horse accepted and its lease has since lapsed. */
export function leaseLapsed(rec, now = Date.now()) {
  const rem = leaseRemainingMs(rec, now);
  return rem != null && rem <= 0;
}

/** Derive a worker's standing from evidence the controller already keeps.
 *  `rec.lastSeen` is the last ping/hello/lease/result; null = never heard
 *  (linking). `now` injected for tests. */
export function standingOf(rec, now = Date.now()) {
  if (!rec) return "lost";
  if (rec.status === "lost") return "lost";
  if (!rec.peer?.opened) return "linking";
  if (leaseLapsed(rec, now)) return "expired";
  const calm = hasAccepted(rec) ? "ready" : "idle";
  if (rec.lastSeen == null) return rec.hello ? calm : "linking";
  const silent = now - rec.lastSeen;
  if (rec.hidden) return silent >= AWAY_HOLD_MS ? "dead" : "away";
  if (silent >= DEAD_AFTER_MS) return "dead";
  if (silent >= STALE_AFTER_MS) return "stale";
  return rec.hello ? calm : "linking";
}

/** True when the controller should tear the link down and re-offer. */
export function shouldRelink(rec, now = Date.now()) {
  const s = standingOf(rec, now);
  return s === "dead" || s === "lost";
}

/** A `ready` announcement arrived from this horse: should the controller drop
 *  its record and re-offer? Only a genuine husk — dead, lost, or linking so
 *  long it is stuck — and never one with a job in flight. A hidden (away),
 *  expired or merely stale horse is alive: dropping it would defeat
 *  AWAY_HOLD and churn the link (defect 1). */
export function shouldDropOnReady(rec, now = Date.now(), { jobInFlight = false } = {}) {
  if (!rec || jobInFlight) return false;
  const s = standingOf(rec, now);
  if (s === "dead" || s === "lost") return true;
  if (s === "linking") return Number.isFinite(rec.createdAt) && now - rec.createdAt >= LINK_STUCK_MS;
  return false;
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
