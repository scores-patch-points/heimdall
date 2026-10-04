// bridge-client.js — the controller tab's half of the local bridge
// (bridge-server.mjs). Present only when the page is served by
// `heimdall up`; on the public site detectBridge() finds nothing and the
// page is unchanged.
//
// Down: server-sent events carry jobs from this computer's callers.
// Up: POSTs carry the fleet's state (who is ready with which model) and the
// token stream back. Replies leave through one ordered outbox so tokens can
// never arrive out of order.

export async function detectBridge() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return null;
  try {
    const r = await fetch("bridge/hello", { cache: "no-store" });
    if (!r.ok) return null;
    const info = await r.json();
    return info?.bridge ? info : null;
  } catch {
    return null;
  }
}

export function connectBridge({ onJob, getState, onStatus = () => {} }) {
  const post = (path, body) =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // The stream down. A browser gives up on an EventSource for good after some
  // failures (a bridge restart can cause one), so a closed stream is reopened
  // from the state timer — the page never needs a reload to find the bridge.
  let es = null;
  const open = () => {
    es = new EventSource("bridge/events");
    es.onopen = () => onStatus("connected");
    es.onerror = () => onStatus("reconnecting");
    es.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m?.type === "job") onJob(m);
      else if (m?.type === "ping") pushState(); // answered from an event, so a background tab stays fresh
    };
  };
  open();

  const pushState = () => {
    if (es.readyState === EventSource.CLOSED) open();
    return post("bridge/state", getState()).catch(() => {});
  };
  const timer = setInterval(pushState, 5000);
  pushState();

  const outbox = [];
  let flushing = false;
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (outbox.length) {
        const batch = outbox.splice(0);
        await post("bridge/reply", batch).catch(() => {});
      }
    } finally {
      flushing = false;
    }
  }

  return {
    reply(msg) {
      outbox.push(msg);
      flush();
    },
    pushState,
    close() {
      clearInterval(timer);
      es.close();
    },
  };
}
