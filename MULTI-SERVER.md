# The pass: keeping the horses running across many servers

Written 2026-09-21 against `60b7337` after reading every line of `src/` and
the eoreader7 side (`eoreader7/heimdall.mjs`, `heimdall-fleet.mjs`,
`native/docs/HEIMDALL-FLEET.md`, the 2026-09-21 traffic-jam post-mortem).
Each claim below names the line it stands on. "Landed" means shipped in this
pass; "next" is ordered, and each item states the control that would prove
it wrong.

## What "a horse" is, and who keeps it running

A horse is one device that accepted duty: a browser tab holding a WebLLM
model, reached over a WebRTC DataChannel whose offer/answer/ICE rode Matrix
to-device events. The room is a directory only (`src/matrix.js` header). The
controller — one browser tab — is the only thing that keeps a horse linked:
`reconcile()` every 15 s offers a link to every device of every member
(`main.js` `reconcile`), the worker pings every 15 s
(`acceptDuty` interval), and the lease is 12 h by the worker's own hand.

## Why it was "OK, not great" — the five holes, and what landed

1. **Silence was invisible.** The controller only learned a horse was gone
   when the DataChannel closed (`ensureWorkerLink` `onClose`). A suspended
   phone, a sleeping laptop, a NAT that dropped the path — the channel lingers
   for minutes, the list read *ready*, and the router (`route.js`
   `isEligible`) kept sending it work that timed out at 120 s.
   **Landed:** `src/liveness.js`. Standing is derived from the last ping,
   never the channel: ready → stale (3 missed pings, shown, not routable) →
   dead (6 missed, link torn down and re-offered). `isEligible` consults it.
   Tested in `liveness.test.mjs` (10 cases). The bound the-fold already
   proved for its own mouths — "never convict on absence alone" — is kept:
   a record never heard from is *linking*, not dead.

2. **A horse that came back was ignored.** The worker re-announces `ready`
   every 20 s, but the controller's handler only called `reconcile()`, which
   skips any key already in `app.workers` — so a stale record blocked the
   relink forever. **Landed:** a `ready` from a device whose record is not
   ready/linking drops the husk and re-offers.

3. **Two reconcile loops.** `createRoom` and `rejoin` each started their own
   `setInterval`; a page that did both offered every horse twice as often.
   **Landed:** `startReconcile()`, one loop per page.

4. **The close-timer could reap a relinked horse.** `onClose` deleted by key
   after 5 s, even if a new record already sat under that key.
   **Landed:** it now reaps only its own record.

5. **The model pin compared against the picker, not the weights.**
   `onWorkerRtcMessage` refused on `app.modelId` (the `<select>`) while the
   hello/ping reported `engine.modelId`. **Landed:** both read the engine.

## Removing a device via Matrix (landed)

There was no way to remove a horse. A kicked worker would also have kept its
`heimdall.verified.<room>` flag and skipped the pairing proof on return — and
the controller linked every room member regardless of pairing, so the proof
only ever gated the worker's own willingness.

Removal is now three acts, each enforced by a different body
(`main.js` `removeWorker`):

| Act | Body that enforces it | Mechanism |
|---|---|---|
| Room | the homeserver, for every surface | `kick` (leave now) or `ban` (out until unban) — `MatrixPeer.kick/ban/unban` |
| Account | every controller signed into the account | `org.heimdall.revoked` account data (`invite.js` `revokeDevice`); `reconcile` consults `isRevoked` before offering a link; the pairing is forgotten (`forgetPairedKey`) so a return must prove its code again |
| Link | the worker itself, at once | a `revoked` to-device notice + the channel closed; the worker stands down (`onRemoved`): lease cleared, verified flag cleared, every infer refused |

The worker trusts two signals: its own membership moving to `leave`/`ban`
(`RoomEvent.MyMembership`, which no forged to-device message can fake) and a
`revoked` notice from the room creator only. Restore is explicit
(`restoreDevice`: unrevoke + unban) and still requires re-pairing — restoring
trust is never silent either. The fleet card shows every removed device with
its reason and a *restore* button, read from the account so a removal made
on the CLI or the fold shows here too.

**Falsifying control:** ban a device, close the controller tab, open the
controller on a second surface (CLI-minted invite, same account): the banned
device must never appear under Workers. If it does, the registry read failed
open — `refreshRevoked` must keep the last list on error (it does) and the
room ban must hold (the homeserver's).

## Multiple servers — what exists, what is missing, in order

"Server" here means three different things, and the fleet handles them
unequally.

### A. Many controllers (heimdalls) on one fleet — exists, with one wall

`swarm.js`: same-account siblings share load snapshots; allied accounts
announce, heartbeat, and migrate work one hop over controller-to-controller
DataChannels. Verified by `swarm.test.mjs`, `scripts/stress-route.mjs`.

The wall: **a worker answers only the room creator's devices**
(`onSignal` worker branch: `senderUserId !== app.creatorId → return`). So a
second server that did not create the room is an *ally* — it can lend and
accept forwards, but can never link a horse. Two servers cannot both keep the
same horses running; if the creator's tab closes, the horses have no one.

**Next 1 — delegated controllers as room state.** The creator writes
`org.heimdall.controller` state events (state_key = `userId|deviceId`) for
each server it trusts; a worker answers any sender whose device key is in
that state, and kick/ban of a delegate is the same state event with
`{}` content. Room state is what the homeserver already replicates and
authenticates, so this needs no new trust machinery. This is the single
change that turns "one tab keeps the horses" into "any server on the roster
keeps the horses". Control: kill the creator tab; a delegate server must
relink every horse within one dead bound (90 s).

### B. A controller that is a server, not a tab — missing

Every controller today is a browser tab (`main.js` is DOM-bound; the CLI only
mints invites). There is no always-on process; horses die at the tab's
sleep. eoreader7 already has the seam for the other direction: the
`roomMouths` registry (`heimdall.mjs` ~3080, `upsertRoomMouth`,
`roomPathsFor`) so a *remote* mouth ranks beside a local horse in huginn's
prioritizer — but nothing calls it; the-fold's `matrix-client.js` never
registers a mouth.

**Next 2 — a headless controller.** Extract the controller core from
`main.js` (reconcile, link, route, relay, removal — everything that is not
`el(...)`) into `src/controller.js` with the DOM as one subscriber. Run it
in Node with `node-datachannel` for WebRTC (or, for server↔server links on
the same LAN, skip WebRTC and carry `infer`/`token` over Matrix to-device
directly — the payloads are small and Olm-sealed). Serve the same
`GET /heimdall` shape eoreader7's `fleet.mjs` already probes, so the box
fleet watches the browser fleet as one more peer. Then wire
`upsertRoomMouth` from that process: each horse becomes a `room:@who:hs
<model>` path the proxy can route to. Control: `npm run benchmark:heimdall`
in eoreader7 must list the headless controller in the mesh.

### C. Many homeservers — partly there, fragile

The share link pins `hs=` and the worker registers a throwaway account on
*that* server (`ensureMatrix` → `registerAuto`). One homeserver
(hyphae.social) is therefore the single point of failure for signaling: if
it is down, no relink, no removal, no new horse — existing DataChannels keep
streaming (WebRTC needs Matrix only to set up), which is why an outage looks
like "the horses are fine until one drops".

**Next 3 — federation-safe joins.** Let the worker sign in on its own
homeserver (the login card exists) and join the room federated:
`joinRoom(roomId, { viaServers })` with the creator's server in the link
(`&via=`). Room state and to-device events then replicate; a worker on
server B keeps working through B when A is down, and a delegate controller
(Next 1) on B keeps the horses linked. Control: stop A; horses homed on B
must relink through the B-homed delegate.

**Next 4 — TURN.** STUN-only (`rtc.js` `RTC_CONFIG`) means two servers on
different NATs may never connect. A server-side controller (Next 2) can run
coturn and publish its TURN credentials in the same controller state event.

### D. Liveness across servers — landed here, one thing owed

The stale/dead bounds are per controller. With Next 1, two servers will each
derive standing independently and may disagree for up to one dead bound.
That is correct (each measures its own path) and matches how eoreader7's
fleet lets N heimdalls disagree and raise — but the lease is still the
worker's 12 h hand-renewal, so an unattended horse stops at 12 h by design.
**Owed:** an *auto-renew while this tab is open* consent, off by default,
shown on the accept card — the worker still consents once, by hand, and the
renewal is theirs. Not built: it changes the consent design the README
states, so it is the operator's call.

## Chorus, one line each

- **Never convict on absence alone** — `linking` for the never-heard; stale
  before dead; a ping resets everything. Tested.
- **Never remove silently** — three bodies, the worker told, the reason kept
  on the account, restore explicit.
- **Reachability is not health** — the channel open is not the horse
  running; the ping is.
- **Out of the sandbox** — the controller tab is the sandbox today; Next 2 is
  the watcher outside it.

## Verify

```
node --test src/*.test.mjs      # 29 cases (19 prior + 10 liveness/revocation)
npm run build                   # vite, unchanged chunking
```
