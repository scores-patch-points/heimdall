// controller-core.js — the pure, DOM-free pieces of the browser-tab controller
// (2026-10-05). main.js wires these to the page; src/controller.js (the
// headless controller, not built yet) can import them unchanged. Everything
// here takes its clock/timers/sleep by injection so it is testable hermetically.

/* ------------------------------------------------------ retry / backoff */

/** 2s, 4s, 8s … capped at 60s. n is the 0-based failed-attempt count. */
export function backoffMs(n, { base = 2000, max = 60_000 } = {}) {
  return Math.min(max, base * 2 ** Math.max(0, n));
}

/** Run `fn(n)` until it resolves, sleeping backoffMs between failures.
 *  `isFatal(e)` stops at once; `shouldStop()` is checked around every sleep
 *  (a newer attempt superseded this loop). Resolves { ok, value?, error? }. */
export async function retryWithBackoff(fn, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  base = 2000,
  max = 60_000,
  shouldStop = () => false,
  isFatal = () => false,
  onError = () => {},
} = {}) {
  for (let n = 0; ; n++) {
    try {
      return { ok: true, value: await fn(n) };
    } catch (e) {
      onError(e, n);
      if (isFatal(e)) return { ok: false, error: e };
      if (shouldStop()) return { ok: false, error: e, stopped: true };
      await sleep(backoffMs(n, { base, max }));
      if (shouldStop()) return { ok: false, error: e, stopped: true };
    }
  }
}

/* ------------------------------------------------------- inflight deadline
   A broadcast marks a giver in-flight; a dead horse never answers, so the
   slot (and jobInFlight, and the tick's relink guard) would stay forever.
   Each (key,id) gets a silence deadline — touch() on every token re-arms it,
   settle() on result/error cancels it, expiry calls onExpire(key,id). */
export class InflightDeadlines {
  constructor({ ms, onExpire, timers = { set: setTimeout, clear: clearTimeout } }) {
    this.ms = ms;
    this.onExpire = onExpire;
    this.timers = timers;
    this.map = new Map(); // `${key}\u0000${id}` -> timer
  }

  _k(key, id) {
    return `${key}\u0000${id}`;
  }

  arm(key, id) {
    const k = this._k(key, id);
    this.timers.clear(this.map.get(k));
    this.map.set(k, this.timers.set(() => {
      this.map.delete(k);
      this.onExpire(key, id);
    }, this.ms));
  }

  /** Re-arm only if armed (a token from a settled/unknown job is not a deadline). */
  touch(key, id) {
    if (this.map.has(this._k(key, id))) this.arm(key, id);
  }

  settle(key, id) {
    const k = this._k(key, id);
    if (!this.map.has(k)) return false;
    this.timers.clear(this.map.get(k));
    this.map.delete(k);
    return true;
  }

  get size() {
    return this.map.size;
  }

  clearAll() {
    for (const t of this.map.values()) this.timers.clear(t);
    this.map.clear();
  }
}

/* ------------------------------------------------------------ timer hygiene */

/** One-shot timers that remove themselves when they fire (no unbounded list). */
export class TimerBag {
  constructor(timers = { set: setTimeout, clear: clearTimeout }) {
    this.timers = timers;
    this.set = new Set();
  }

  later(fn, ms) {
    const t = this.timers.set(() => {
      this.set.delete(t);
      fn();
    }, ms);
    this.set.add(t);
    return t;
  }

  get size() {
    return this.set.size;
  }

  clearAll() {
    for (const t of this.set) this.timers.clear(t);
    this.set.clear();
  }
}

/** (Re)start the named interval in `slots`, clearing the previous one first,
 *  so renewing duty never stacks a second timer. */
export function restartInterval(slots, name, fn, ms, timers = { set: setInterval, clear: clearInterval }) {
  if (slots[name] != null) timers.clear(slots[name]);
  slots[name] = timers.set(fn, ms);
  return slots[name];
}

/* ------------------------------------------------- bounded reconcile reads */

/** Resolve `promise`, or `fallback` after `ms` — never rejects, never hangs. */
export function withTimeout(promise, ms, fallback, timers = { set: setTimeout, clear: clearTimeout }) {
  return new Promise((resolve) => {
    const t = timers.set(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (v) => { timers.clear(t); resolve(v); },
      () => { timers.clear(t); resolve(fallback); },
    );
  });
}

/** Map `items` through async `fn` with at most `limit` in flight; results keep order. */
export async function mapBounded(items, fn, limit = 4) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The members worth a device lookup: those with at least one device heard
 *  within `maxAgeMs` (heard: Map deviceKey "user|device" -> ms). reconcile
 *  already ignores any device not heard in that window, so skipping the
 *  lookup for a silent member changes cost, never outcome. */
export function membersToQuery(members, heard, now, maxAgeMs) {
  const fresh = new Set();
  for (const [k, at] of heard) {
    if (now - at <= maxAgeMs) fresh.add(k.slice(0, k.lastIndexOf("|")));
  }
  return [...new Set(members)].filter((u) => fresh.has(u));
}

/* ------------------------------------------------------------- revocation */

/** Keys of linked workers whose device is on the revoked list. The caller
 *  drops and unroutes them at the next reconcile tick (defect 3). */
export function revokedWorkerKeys(workers, list, isRevoked) {
  const out = [];
  for (const [key, rec] of workers instanceof Map ? workers.entries() : Object.entries(workers || {})) {
    if (rec?.device && isRevoked(list, rec.device)) out.push(key);
  }
  return out;
}

/** Union of the account's list and entries this tab revoked locally whose
 *  registry write did not land, so a removal survives a failed save. */
export function mergeRevoked(list, pending) {
  const out = Array.isArray(list) ? [...list] : [];
  for (const p of pending || []) {
    if (!out.some((e) => e && e.userId === p.userId && (e.deviceId ?? null) === (p.deviceId ?? null))) out.push(p);
  }
  return out;
}
