// heimdall.mjs: the watch over the bridges.
//
// PHAROS IS THE SUBSTRATE: the log on each node, written by one hand (Penelope). It knows nothing of
// Matrix, ActivityPub, databases or APIs. HEIMDALL IS INTEGRATION AND SYNC: he stands at each bridge
// between a pharos node and something else, watches it, and carries what is waiting across. He stores
// nothing of his own; what he carries is woven into pharos by Penelope, and his acts are entries there.
//
// A BRIDGE is anything a node exchanges with:
//   peer      another pharos node of the same person      (lib/nodesync.mjs, Matrix cross-signing)
//   network   other people's nodes in a network           (lib/network.mjs, Matrix E2EE)
//   database  an engine that speaks another shape         (lib/spawn.mjs + codecs/)
//   actor     the fediverse                               (federation/activitypub.mjs)
//   signal    the signaling server the node depends on    (signal/install.mjs)
//   source    an outside API or public repo               (connectors/)
//
// The loop is khora's Heimdall's own (khora heimdall.mjs, the watcher of the model's surfaces), applied
// to bridges instead of proxies:
//   DEF  declare: every bridge watched is named; a bridge nobody declared is not crossed.
//   EVA  evaluate: PROBE the bridge. A probe writes nothing (attention alone leaves no lasting entry).
//   REC  re-zero: only when the probe found something waiting, CROSS once, then probe again.
// His walls, kept:
//   - EVA never acts on a suspicion: no cross without a probe that found something.
//   - REC is bounded: one cross per bridge per tick. Still open afterwards is a FINDING, reported, never a loop.
//   - Nothing is restarted or removed silently: a bridge that is down is RAISED, with the reason.
//   - No node is the truth: a closed bridge means "nothing found waiting at this probe", and the next
//     tick may find otherwise.
// One entry is woven per tick that crossed or raised anything (`watch`, EVA·Pattern). A quiet tick writes nothing.
import { pendingOf, exchange } from './spawn.mjs';
import { peerGap, syncWithNode } from './nodesync.mjs';

export const WATCH_KIND = { kind: 'watch', cell: 'EVA·Pattern', why: 'Heimdall probed the declared bridges, crossed those with something waiting, and reports what is still open or down' };

export class Heimdall {
  constructor({ store, node = 'node' }) { Object.assign(this, { store, node }); this.bridges = new Map(); }

  // bridge: { kind, probe: async () => ({ open: boolean, down?: boolean, ...detail }), cross?: async () => detail }
  declare(name, bridge) {
    if (!/^[A-Za-z0-9._:-]+$/.test(name)) throw new Error('a bridge name is a plain token');
    if (typeof bridge?.probe !== 'function') throw new Error('a bridge must be probe-able');
    this.bridges.set(name, bridge);
    return this;
  }

  async tick() {
    const report = [];
    for (const [name, b] of this.bridges) {
      const row = { bridge: name, kind: b.kind };
      try {
        row.before = await b.probe();
        if (row.before.down) row.state = 'raised';
        else if (!row.before.open) row.state = 'quiet';
        else if (!b.cross) row.state = 'open-no-crossing';
        else {
          row.crossed = await b.cross();
          row.after = await b.probe();
          row.state = row.after.open ? 'still-open' : 'crossed';
        }
      } catch (e) { row.state = 'raised'; row.error = String(e?.message ?? e).slice(0, 200); }
      report.push(row);
    }
    const acted = report.filter((r) => r.state !== 'quiet');
    let id = null;
    if (acted.length) {
      const w = await this.store.append({
        kind: WATCH_KIND.kind, cell: WATCH_KIND.cell, addr: `watch:${this.node}`, of: [],
        body: { node: this.node, bridges: report.map((r) => ({ bridge: r.bridge, kind: r.kind, state: r.state, ...(r.error ? { error: r.error } : {}) })) },
        witness: { how: `probed ${report.length} declared bridges; crossed ${report.filter((r) => r.crossed).length}` }, declare: { why: WATCH_KIND.why },
      });
      id = w.id ?? null;
    }
    return { report, id, quiet: !acted.length };
  }
}

// ---- ready-made bridges ----

export const databaseBridge = (dbNode) => ({ kind: 'database', probe: () => pendingOf(dbNode), cross: () => exchange(dbNode) });

// Exchange records apart are expected after every exchange (each exchange records itself), so the peer
// bridge is open only on a CONTENT gap.
export const peerBridge = ({ mx, store, url, here, there }) => ({
  kind: 'peer',
  probe: async () => { const g = await peerGap({ mx, store, url }); return g.reachable ? { open: g.contentGap > 0, contentGap: g.contentGap, exchangeRecordsApart: g.exchangeRecordsApart } : { open: false, down: true, reason: g.reason }; },
  cross: async () => { const r = await syncWithNode({ mx, store, url, here, there }); return { pulled: r.pulled, pushed: r.pushed }; },
});

export const signalBridge = (hs) => ({
  kind: 'signal',
  probe: async () => { const up = await fetch(hs.replace(/\/$/, '') + '/_matrix/client/versions').then((r) => r.ok, () => false); return up ? { open: false } : { open: false, down: true, reason: 'signaling server does not answer' }; },
});
