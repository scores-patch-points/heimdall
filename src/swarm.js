// swarm.js — the fleet as one animal (2026-09-19).
//
// Several heimdalls may share one fleet room: the same account open on many
// surfaces (site + CLI + fold), or allied accounts controlling together.
// Each keeps its own credit ledger — reciprocity is pairwise, the way
// the-fold's own independent requesters stay correct against one mouth —
// and workers serialize concurrent jobs in their own queue. So independent
// routing stays CORRECT with no leader and no forwarding channel; what the
// swarm adds is shared signal and work migration:
//
//   - PRESENCE. Every controller announces itself (hello-controller,
//     heartbeated). Siblings are shown as one organism in the fleet UI.
//   - SHARED LOAD. Same-account siblings merge inflight/meanMs snapshots
//     (route.js); every account's controllers read worker queueDepth.
//   - MIGRATION. A borrow no local giver can serve is offered to a sibling
//     that advertises the model, settled per hop so every link earns/owes
//     symmetric. Only on typed local failure (no giver) — a wrong answer
//     never hops (huginn's discipline, P129).
//   - ALLY MODE. A controller that did not create the room cannot link
//     workers (they answer only their creator's devices) and stops trying:
//     it contributes its own lent device and accepts forwards.
//
// Trust boundary: the account. Same-user snapshots steer routing; other
// accounts' load claims never do (a stranger could inflate them) —
// cross-account coordination rides on worker-reported queueDepth, which the
// worker itself authenticates over its own link, plus advertised serves.

/** A controller sighting older than this is gone, not quiet. */
export const CONTROLLER_TTL_MS = 60_000;

/** Forward hops allowed per job. One: the sibling serves or refuses. */
export const FWD_TTL = 1;

export function controllerKey({ userId, deviceId }) {
  return `${userId}|${deviceId}`;
}

export function isControllerHello(c) {
  return !!c && (c.type === "hello-controller" || c.type === "coord-heartbeat");
}

/** True when this controller cannot link workers and must act as an ally:
// the room belongs to another account. Same-account surfaces are never
// allies — the creator IS their user. */
export function amAlly({ creatorId, userId } = {}) {
  if (!creatorId || !userId) return false;
  return creatorId !== userId;
}

/** Models this controller can serve right now: union of its ready workers'
// loaded models plus its own lent device. Drives forward targeting. */
export function servesOf(workers, self = null) {
  const out = new Set();
  const entries = workers instanceof Map ? workers.values() : Object.values(workers || {});
  for (const rec of entries) {
    const m = rec?.hello?.model ?? rec?.model;
    if (rec?.status === "ready" && m) out.add(m);
  }
  if (self?.loaded && self.model) out.add(self.model);
  return [...out].sort();
}

/** Drop sightings past their TTL. Returns a NEW Map. */
export function pruneControllers(map, now = Date.now()) {
  const out = new Map();
  for (const [k, v] of map) {
    if (v && Number.isFinite(v.at) && now - v.at <= CONTROLLER_TTL_MS) out.set(k, v);
  }
  return out;
}

/**
 * Pick a sibling to offer a job no local giver could serve.
 * Matches serves first (pinned model or any), skips tried, rotates ties.
 * Returns { key, rec } or null with a typed reason.
 */
export function pickForwarder(controllers, { wantModel = null, tried = [], idx = 0, now = Date.now() } = {}) {
  const entries = controllers instanceof Map ? [...controllers.entries()] : Object.entries(controllers || {});
  const live = entries.filter(
    ([k, c]) => !tried.includes(k) && c && Number.isFinite(c.at) && now - c.at <= CONTROLLER_TTL_MS,
  );
  const able = live.filter(([, c]) => {
    const serves = c.serves || [];
    return !wantModel || serves.includes(wantModel);
  });
  if (!able.length) {
    const anyLive = live.length > 0;
    return { forwarder: null, reason: wantModel && anyLive ? "no_sibling_serves_model" : "no_sibling_available" };
  }
  const [key, rec] = able[idx % able.length];
  return { forwarder: { key, rec }, reason: "forward_failover" };
}

/** Build a forward envelope. ttl starts at FWD_TTL and only decreases. */
export function makeFwdJob({ fwdId, job, from, ttl = FWD_TTL }) {
  return {
    kind: "fwd-job",
    fwdId,
    ttl,
    from, // origin controller deviceKey — the borrower of record one hop down
    job: {
      id: job.id,
      model: job.model ?? null,
      messages: job.messages,
      temperature: job.temperature ?? 0.7,
      max_tokens: job.max_tokens ?? 1024,
    },
  };
}

/** Validate an inbound forward: whole shape, positive ttl, never seen.
// A sibling must never re-forward (one hop max) and a replayed fwdId is
// refused — the tried-list discipline, one level down. */
export function validFwdJob(env, seen = []) {
  if (!env || env.kind !== "fwd-job") return { ok: false, reason: "not_a_forward" };
  if (!env.fwdId || !env.job?.id || !Array.isArray(env.job?.messages)) return { ok: false, reason: "bad_forward_shape" };
  if (!Number.isFinite(env.ttl) || env.ttl <= 0) return { ok: false, reason: "forward_ttl_spent" };
  if (seen.includes(env.fwdId)) return { ok: false, reason: "forward_replay" };
  return { ok: true, reason: null };
}
