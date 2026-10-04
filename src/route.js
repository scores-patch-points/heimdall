// route.js — heimdall's bifrost router (2026-09-19).
//
// Which giver answers which job when many surfaces hit at once:
//   - the controller's own "Run" broadcast,
//   - workers borrowing from the fleet (job → host routes → giver),
//   - the host lending its own device (self),
//   - a remote mouth reached over Matrix (room:@who:server model).
//
// Pure, node-testable: worker records, job specs, and measured evidence
// are all injected. The page / CLI wires them to live RtcPeers; tests
// wire counters.
//
// Rules, in order:
//   1. ELIGIBLE — status ready, link open, lease live. Nothing else is
//      routable, never silently.
//   2. PINNED — a job naming a model only goes to a giver LOADED with
//      that exact model id (or the Ollama tag it maps to, models.js). No match → { giver: null, reason:
//      "no_giver_for_model" }, never a quiet wrong-model answer.
//      (Mirrors the-fold's isPinnedModel: a picked mouth outranks the
//      ladder. Here the pin is the model id itself.)
//   3. NOT-SELF — a borrower never routes to itself.
//   4. SHORTEST EXPECTED WAIT — in-flight × measured mean ms (the-fold's
//      pickMouth, P129). Unmeasured givers score at the mean of the
//      measured ones (1 when none), so they are tried, never starved or
//      preferred. Ties rotate, so an idle fleet spreads instead of
//      pinning the first worker forever.
//
// Evidence: observe() lands one wall-time sample per completed job (EWMA,
// alpha 0.4 — huginn's own weight). Failures drop in-flight without moving
// the mean, so a flaky giver sheds load without poisoning its score.

import { STALE_AFTER_MS } from "./liveness.js";
import { answers } from "./models.js";

export const EWMA_ALPHA = 0.4;

/** A job naming `room:@who:server model` is a remote Matrix mouth, not a
 *  local WebLLM id. The router never swaps it for a local giver — the
 *  caller must send it down the Matrix path instead. Same shape the-fold
 *  pins (model-routing.js::isPinnedModel). */
export const isRoomMouth = (name) =>
  typeof name === "string" && /^room:@[^:\s]+:\S+\s+\S/.test(name);

/** True when this giver record may take work right now. Reads only the
 *  fields the controller already keeps; `now` injected for tests. */
export function isEligible(rec, now = Date.now()) {
  if (!rec) return false;
  if (rec.status !== "ready") return false;
  if (rec.hidden) return false; // the phone left the app: held, never routed to
  if (!rec.peer?.opened) return false;
  if (rec.hello?.leaseUntil && now > rec.hello.leaseUntil) return false;
  // A horse not heard from in 3 pings is stale: shown, never routed to
  // (liveness.js). Unknown lastSeen is not silence — legacy records pass.
  if (rec.lastSeen != null && now - rec.lastSeen >= STALE_AFTER_MS) return false;
  return true;
}

/** The model a giver is loaded with: hello.model, or rec.model, or null
 *  when unknown (never guessed). */
export function modelOf(rec) {
  return rec?.hello?.model ?? rec?.model ?? null;
}

/**
 * Rank eligible givers for a job.
 *
 * @param {Map|Object} workers  key -> worker record ({ hello, peer, status })
 * @param {Object} opts
 *   - borrowerKey: excluded from candidacy (never route to itself)
 *   - model: null/undefined = any model; string = that exact model only
 *   - self: optional { key, model, loaded } — the host lending its device
 *   - inflight: { key: n } jobs already sent and unanswered (this heimdall)
 *   - meanMs: { key: ms } measured means
 *   - queued: { key: n } worker-reported queue depth (backpressure — covers
 *     jobs sent by OTHER heimdalls no local inflight map can see)
 *   - idx: rotation counter for ties (caller holds and increments)
 *   - now: ms epoch, injected for tests
 * @returns {{ giver: {key,rec}|null, order: string[], reason: string }}
 */
export function pickGiver(workers, {
  borrowerKey = null,
  model = null,
  self = null,
  inflight = {},
  meanMs = {},
  queued = {},
  idx = 0,
  now = Date.now(),
} = {}) {
  const entries = workers instanceof Map ? [...workers.entries()] : Object.entries(workers || {});
  let cands = [];
  for (const [key, rec] of entries) {
    if (key === borrowerKey) continue;
    if (!isEligible(rec, now)) continue;
    if (model && !answers(modelOf(rec), model)) continue;
    cands.push(key);
  }
  // The host lending its own device is a giver too — same eligibility
  // bar (loaded), same model pin, never itself when it borrows.
  if (self?.loaded && self.key !== borrowerKey && (!model || answers(self.model, model))) {
    cands.push(self.key);
  }
  if (!cands.length) {
    const anyEligible = entries.some(([k, r]) => k !== borrowerKey && isEligible(r, now));
    return {
      giver: null,
      order: [],
      reason: model && anyEligible ? "no_giver_for_model" : "no_giver_available",
    };
  }
  const timed = cands.map((k) => meanMs[k]).filter((v) => Number.isFinite(v) && v > 0);
  const typical = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : 1;
  // Outstanding = what THIS heimdall sent and hasn't seen answered, PLUS
  // what the worker itself reports queued (jobs other heimdalls sent).
  // Either alone underestimates under concurrency; the sum never does.
  const waitOf = (k) =>
    ((inflight[k] ?? 0) + (queued[k] ?? 0)) *
    (Number.isFinite(meanMs[k]) && meanMs[k] > 0 ? meanMs[k] : typical);
  const waits = new Map(cands.map((k) => [k, waitOf(k)]));
  const min = Math.min(...waits.values());
  const tied = cands.filter((k) => waits.get(k) === min);
  // All idle (or all equally loaded): rotate so one worker doesn't take
  // everything. Otherwise the single shortest wait wins outright.
  let pickKey;
  if (tied.length > 1) pickKey = tied[idx % tied.length];
  else pickKey = tied[0];
  const rest = cands
    .slice()
    .sort((a, b) => waits.get(a) - waits.get(b) || cands.indexOf(a) - cands.indexOf(b))
    .filter((k) => k !== pickKey);
  const order = [pickKey, ...rest];
  const rec = pickKey === self?.key ? { ...self, self: true } : (workers instanceof Map ? workers.get(pickKey) : workers[pickKey]);
  return { giver: { key: pickKey, rec }, order, reason: model ? "pinned_model" : "shortest_expected_wait" };
}

/** Order every eligible giver for a broadcast (controller "Run on all").
 *  Broadcasts fan out — no pin, no borrower exclusion beyond eligibility. */
export function broadcastTargets(workers, { self = null, now = Date.now() } = {}) {
  const entries = workers instanceof Map ? [...workers.entries()] : Object.entries(workers || {});
  const out = entries.filter(([, r]) => isEligible(r, now)).map(([k]) => k);
  if (self?.loaded) out.push(self.key);
  return out;
}

/** Land one observation. Returns { inflight, meanMs } — new objects, never
 *  mutated. A failure clears one in-flight slot and leaves the mean alone. */
export function observe({ inflight = {}, meanMs = {} }, key, { ms = null, ok = true } = {}) {
  const nextFlight = { ...inflight };
  nextFlight[key] = Math.max(0, (nextFlight[key] ?? (ok ? 1 : 0)) - 1);
  if (!ok || ms == null || !Number.isFinite(ms) || ms <= 0) return { inflight: nextFlight, meanMs: { ...meanMs } };
  const prev = meanMs[key];
  const next = prev == null ? Math.round(ms) : Math.round((1 - EWMA_ALPHA) * prev + EWMA_ALPHA * ms);
  return { inflight: nextFlight, meanMs: { ...meanMs, [key]: next } };
}

/** Mark one job sent: +1 in-flight for the giver. Takes the inflight map
 *  directly (unlike observe, which takes the whole route state). */
export function markSent(inflight = {}, key) {
  return { ...inflight, [key]: (inflight[key] ?? 0) + 1 };
}

/* ------------------------------------------------- other heimdalls ----
   Several heimdalls may share one fleet room: the same account open on two
   surfaces (site + CLI + fold), or two accounts both controlling. Each keeps
   its own credit ledger (reciprocity is pairwise — credit earned with A is
   not credit with B), and workers serialize concurrent jobs in their own
   queue, so independent routing stays CORRECT the way the-fold's own
   multiple requesters stay correct against one mouth. What siblings share
   is load signal, so neither underestimates a worker the other is using:
   periodic { inflight, meanMs } snapshots over encrypted to-device events,
   merged here with an expiry so a dead sibling stops counting. No leader,
   no forwarding channel — a leader election would add a failover the fleet
   has never needed, and the precedent (independent requesters + mouth-side
   serialization) already holds. */

/** Snapshots older than this stop counting toward effective load. */
export const SIBLING_TTL_MS = 30_000;

/** Fold sibling snapshots into effective inflight: own counts plus every
 *  live sibling's counts per giver key. Pure. */
export function mergeInflight(own = {}, snapshots = [], now = Date.now()) {
  const out = { ...own };
  for (const s of snapshots) {
    if (!s || typeof s !== "object") continue;
    if (!Number.isFinite(s.at) || now - s.at > SIBLING_TTL_MS) continue;
    for (const [k, v] of Object.entries(s.inflight || {})) {
      if (!Number.isFinite(v) || v <= 0) continue;
      out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

/** Adopt sibling pace readings only where this heimdall measured nothing:
 *  a sibling's mean beats the blind typical, never overrides a local one. */
export function mergeMeanMs(own = {}, snapshots = [], now = Date.now()) {
  const out = { ...own };
  for (const s of snapshots) {
    if (!s || typeof s !== "object") continue;
    if (!Number.isFinite(s.at) || now - s.at > SIBLING_TTL_MS) continue;
    for (const [k, v] of Object.entries(s.meanMs || {})) {
      if (out[k] != null) continue;
      if (!Number.isFinite(v) || v <= 0) continue;
      out[k] = v;
    }
  }
  return out;
}

/** Deterministic leader for DISPLAY only (fleet UI names one heimdall as
 *  the one to watch): smallest id among live siblings including self.
 *  Never gates routing — see above. */
export function electLeader(ids = []) {
  const live = [...new Set(ids.filter(Boolean))].sort();
  return live[0] ?? null;
}
