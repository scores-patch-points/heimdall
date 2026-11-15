# Heimdall bridges

**Pharos is the substrate.** One append-only log on each node, written by one hand (Penelope). It knows nothing about Matrix, databases or the fediverse.

**Heimdall is integration and sync.** He stands at each bridge between a pharos node and something else, probes it, and carries across what is waiting. He stores nothing himself: what he carries is woven into pharos, and his acts are entries there.

No node is the truth. Every holder of data (a device's log, a browser store, a database, another person's device) is a node with a partial view. Nodes approach one another by exchange, and a comparison between two of them is a measured gap, never a verdict.

There are no roles. Any node can open a network over data it holds and invite other nodes. Whoever opens a network holds its power: the opener can remove any node, and no node can remove the opener. The same two nodes, in a network the other one opened, have the opposite power.

## What is here

| bridge | what it does | code |
|---|---|---|
| network | other people's nodes share records, end-to-end encrypted with Matrix (Olm, Megolm). Records are encrypted for the network but never posted to the Matrix room; the ciphertext lives on devices. | `lib/network.mjs`, `lib/matrix.mjs`, `lib/server.mjs` |
| peer | two devices of one person merge their logs by union. Only the same person's devices, vouched for by Matrix cross-signing, may. | `lib/nodesync.mjs` |
| database | a database built from a public repo at a pinned commit. Native writes flow into pharos; entries from elsewhere flow back. SQLite today. | `lib/spawn.mjs`, `codecs/sqlite.mjs` |
| transport | everything crosses over Matrix, so no node has to be reachable by another: small payloads as encrypted to-device messages (delivered at once, or queued if the other device is offline); large ones gzipped, sharded and encrypted into the media store. Nothing is stored in a room. | `lib/transport.mjs`, `lib/courier.mjs` |
| actor | ActivityPub: follow, publish, receive, with HTTP Signatures. Only kinds a node lists as public can be published. | `federation/` |
| source | pull from an API or a public repo, with where it came from and a hash of the bytes. | `connectors/` |
| signal | install your own signaling server (Synapse or Conduit), so your nodes depend on nobody else's. | `bin/signal.mjs`, `signal/` |

Where a node keeps its records: a pharos log through Penelope (Node), an on-device server, or OPFS or IndexedDB in a browser (`lib/stores.mjs`). No home holds plaintext.

The watch over all of it is `lib/heimdall.mjs`: declare the bridges, probe each (a probe writes nothing), cross once where something is waiting, and raise what is down instead of fixing it silently.

## Run it

Needs Node 22.5 or later, Docker for a signaling server, and checkouts of [pharos](https://github.com/scores-patch-points/pharos) and [penelope](https://github.com/scores-patch-points/penelope) beside this repo (or set `HEIMDALL_PHAROS_LIB` and `PENELOPE_WEAVE_MODULE`; see `test/env.mjs`).

```
cd bridges && npm install
node bin/signal.mjs install conduit --dir ~/my-signal --name me.test --port 8461          # prints the plan, changes nothing
node bin/signal.mjs install conduit --dir ~/my-signal --name me.test --port 8461 --apply
node bin/signal.mjs verify --dir ~/my-signal
SURFACE_SIGNAL_DIR=~/my-signal npm test
```

Tests that need pharos, Penelope, a signaling server or the network skip, and say why, when those are missing.

## What is tested, and what is not

Tested against real servers (Synapse v1.120.0 and Conduit v0.10.15), a real browser for OPFS and IndexedDB, and a public sample database:

- a node opens a network, another reads and writes while in it, is removed, and can then neither read, write, nor decrypt what is written afterwards; the opener cannot be removed by anyone;
- the same two nodes reversed reverse the power;
- two devices of one person merge; a stranger's device, an unvouched device, a replayed request, a swapped body and a tampered entry are each refused;
- with no device server at all, two devices sync over Matrix, an offline device receives 208 KB as 9 encrypted shards and decrypts all of it on return, a stored shard holds nothing readable, and an altered shard is refused;
- a database's native writes reach pharos and entries from elsewhere reach the database;
- two of our own ActivityPub actors follow, publish and receive, and forged or unsigned posts are refused;
- the watch crosses a waiting bridge once and writes nothing when all is quiet.

Not tested, or not built:

- **None of this is pre-registered or independently tested.** The tests and the code have the same author.
- ActivityPub against a third-party server (GoToSocial, Mastodon).
- Two people on two separately installed signaling servers in one network (needs public names and TLS).
- Any database engine other than SQLite.
- The media store keeps ciphertext shards on the signaling server until its operator purges them; the Matrix client API cannot delete media. Purging is not built.
- A live WebRTC channel, and the whole local database encrypted under a device key.
- Erasure. Removing a node protects what is written afterwards; it cannot take back what that node already read.
- A Node device gets a new Matrix identity every time it restarts.
- The signaling server still sees who is in whose network, and when.

The design, field by field, with what each kind of database and each federated system would need, is in [CODECS.md](CODECS.md).
