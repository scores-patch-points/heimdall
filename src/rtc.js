const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

/**
 * One RTC connection to one remote device. Signaling (offer/answer/ICE)
 * travels over Matrix encrypted to-device messages via the `signal`
 * callback; the actual data goes over an ordered, reliable DataChannel.
 */
// ICE `disconnected` is often transient (wifi blip, NAT rebind): the browser
// goes back to `connected` by itself. Wait this long for that before telling
// the controller the link closed; `failed`/`closed` are immediate.
export const DISCONNECT_GRACE_MS = 8000;

export class RtcPeer {
  constructor({ signal, onOpen, onClose, onMessage, disconnectGraceMs = DISCONNECT_GRACE_MS }) {
    this.disconnectGraceMs = disconnectGraceMs;
    this._graceTimer = null;
    this._closeSent = false;
    this.signal = signal; // (label, data) => void  -> sent over Matrix to the far end
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.onMessage = onMessage || (() => {});
    this.pc = null;
    this.dc = null;
    this.opened = false;
    this._create();
  }

  _create() {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.ondatachannel = (e) => this._bind(e.channel);
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signal("ice", e.candidate);
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === "connected") {
        this._clearGrace(); // it came back by itself: never announced closed
        this._announceOpen();
      } else if (st === "disconnected") {
        this._armGrace();
      } else if (st === "failed" || st === "closed") {
        this._announceClose();
      }
    };
  }

  _bind(dc) {
    this.dc = dc;
    dc.onopen = () => this._announceOpen();
    dc.onclose = () => this._announceClose();
    dc.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
  }

  _armGrace() {
    if (this._graceTimer != null) return;
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (this.pc?.connectionState === "connected") return;
      this._announceClose();
    }, this.disconnectGraceMs);
  }

  _clearGrace() {
    if (this._graceTimer != null) clearTimeout(this._graceTimer);
    this._graceTimer = null;
  }

  _announceOpen() {
    if (this.opened) return;
    this.opened = true;
    this._closeSent = false; // a later close is news again
    this.onOpen();
  }

  _announceClose() {
    this._clearGrace();
    if (this._closeSent) return; // dc.onclose + connection state both report one death
    this._closeSent = true;
    this.opened = false;
    this.onClose();
  }

  /** Controller side: create the data channel and send an offer. */
  async offer() {
    const dc = this.pc.createDataChannel("heimdall", { ordered: true });
    this._bind(dc);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signal("offer", this.pc.localDescription);
  }

  /** Both sides: handle a signaling message from the far end. */
  async handleSignal(label, data) {
    if (label === "offer") {
      await this.pc.setRemoteDescription(data);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.signal("answer", this.pc.localDescription);
    } else if (label === "answer") {
      await this.pc.setRemoteDescription(data);
    } else if (label === "ice") {
      try {
        await this.pc.addIceCandidate(data);
      } catch {
        /* raced with renegotiation; fine */
      }
    }
  }

  send(msg) {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(msg));
    }
  }

  close() {
    this._clearGrace();
    try {
      this.dc?.close();
    } catch {}
    try {
      this.pc?.close();
    } catch {}
  }
}
/**
 * The same surface as RtcPeer, carried over Matrix to-device messages
 * instead of a DataChannel — for when a direct link cannot open (a phone on
 * a carrier NAT, and no TURN server). Slower, but it goes wherever the
 * pairing already went. Tokens are batched; everything else is sent at
 * once; batches leave in order.
 */
export class RelayPeer {
  constructor({ send, onMessage, batchMs = 250 }) {
    this.sendBatch = send; // (msgs[]) => Promise
    this.onMessage = onMessage || (() => {});
    this.batchMs = batchMs;
    this.opened = true;
    this.relay = true;
    this.queue = [];
    this.timer = null;
    this.chain = Promise.resolve();
  }

  send(msg) {
    if (!this.opened) return;
    this.queue.push(msg);
    if (msg.type === "token") {
      if (!this.timer) this.timer = setTimeout(() => this.flush(), this.batchMs);
    } else {
      this.flush();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length) return;
    const msgs = this.queue.splice(0);
    this.chain = this.chain.then(() => this.sendBatch(msgs)).catch(() => {});
  }

  /** Messages that arrived from the far end. */
  deliver(msgs) {
    if (!this.opened) return;
    for (const m of Array.isArray(msgs) ? msgs : []) this.onMessage(m);
  }

  close() {
    this.flush();
    this.opened = false;
  }
}
