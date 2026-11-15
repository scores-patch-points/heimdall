# Bridges and codecs: how Heimdall carries between pharos and everything else

First written 2026-11-14. **Pharos is the substrate**: one append-only log on each node, written by one hand (Penelope). **Heimdall is integration and sync**: he stands at each bridge between a pharos node and something else, probes it, and carries across what is waiting. Section 1 says what runs and was tested. Everything after that is design, and says so where it is not built.

## 0. The frame: no node is the truth

The rule this is built on:

So every holder of data is a **node**: a device's pharos log, a browser's OPFS or IndexedDB, a spawned database, another person's device. Each node:

- holds a partial view and keeps moving;
- approaches the others only by **exchange**, which is a union of what each holds (nothing is overwritten, nothing is deleted);
- is never overruled by another node.

A database is not "a projection of the true log". It is a node that speaks another shape. A codec is how two nodes of different shapes exchange.

What follows from that rule:

- **No "canonical" anywhere.** Penelope is the one hand that weaves on each node that has a pharos log. She is a writer, not an arbiter.
- **A gap is measured, and never certified.** `measureGap` compares two nodes at two stated frontiers and reports what only A holds, what only B holds, and which values differ. It is woven as `gap-measured` (EVA·Pattern). A zero gap means "no difference found between these two nodes, at these frontiers, by this comparison", and the next exchange can reopen it.
- **Contradictions are kept as "both".** Two nodes that disagree about an address keep both entries. The fold reports the conflict (pharos SPEC), as the "One Log, Many Projections" doc requires.

## 1. What runs now (tested 2026-11-14)

| piece | file | tested how |
|---|---|---|
| Matrix: accounts, network rooms, E2EE, sync | `lib/matrix.mjs` | real Synapse v1.120.0 in Docker on 127.0.0.1:8448 |
| Network (a node holds it) / Link (a node joined it) | `lib/network.mjs` | `test/network.e2e.test.mjs`, 10 steps plus the reversal, pass |
| on-device server (records, submit, local pairing) | `lib/server.mjs` | same test, plus the browser run |
| stores: penelope, remote, OPFS, IndexedDB, memory | `lib/stores.mjs` | Node tests plus headless Chrome (OPFS and IDB real) |
| key store at rest (Node) | `lib/keystore.mjs` | test step 10 |
| write door (Penelope only) and read door | `lib/door.mjs` | every woven entry has `by: penelope` |
| HTTP connector | `connectors/http.mjs` | pulled a GitHub API response into pharos |
| public-repo link (read-only, pinned commit) | `connectors/github.mjs` | Chinook at `7f677725…`, file sha256 recorded |
| SQLite codec (down, up, ids, capture triggers) | `codecs/sqlite.mjs` | `test/db.test.mjs`, pass |
| spawner and gap measure | `lib/spawn.mjs`, `lib/codec.mjs` | same test |
| node-to-node merge (own devices, Matrix cross-signing) | `lib/nodesync.mjs`, server `/v1/node/*` | `test/nodes.e2e.test.mjs`, pass |
| Penelope's merge route (`mergeEntries`, `POST /v1/weave/merge`) | the penelope repo (merged to her main as pull request 15) | two tests in her `organs/weave-mark.test.mjs` on real pharos, pass |

**The merge run (phone and laptop of one person, added the same day):**

- The phone bootstrapped cross-signing and vouched for the laptop's device.
- Each node wrote a record while apart.
- The laptop pulled the phone's entries and Penelope merged them. Then it pushed its own, and the phone's Penelope merged those.
- Every request and response is signed with the device's Matrix ed25519 key, and is accepted only from the same user's device cross-signed by the owner.
- Both nodes then held, and could decrypt, both records.
- Refused, each with its own reason:
  - another person's device (`not_own_user`);
  - a third login of the same person that nobody vouched for (`device_not_cross_signed`);
  - a replayed request (`replayed`);
  - a body swapped under a valid signature (`body_mismatch`);
  - an entry altered inside a correctly signed push. Penelope refused it (`id_mismatch`) and let the rest in.
- **Gap:** before the first sync, 7 entries were only on the laptop and 9 only on the phone. After it, the content gap was 0 and **1 entry was still apart**. That entry is the phone's own `merged` record of the push it had just taken in.
- A second sync starts with content gap 0 and ends one exchange-record apart again. That is the no-final-truth rule showing up in the data: **every exchange writes a record of itself, so two nodes that keep exchanging never become identical.** They converge on everything else. The measure reports `contentGap` and `exchangeRecordsApart` separately. Which kinds count as exchange records (`merged`, `gap-measured`) is a declared choice in `lib/nodesync.mjs`, not a fact about the nodes.

**No roles.** Pharos knows nodes and networks, never kinds of people. Any node can open a network over data it holds (a Matrix room) and invite other nodes. Whoever opens a network holds its power; every other node has none in it. The "patient removes the doctor, never the reverse" case is one instance: the patient's node opened the network over the patient's data. The same two nodes reversed (the doctor's node opens a network over its own notes) reverse the power, and a test shows it.

**The network test (node A opens, node B joins) passed all 10 steps against the real homeserver:**

1. A wrote a record. It was Megolm-encrypted on A's device and woven by Penelope into that device's pharos log.
2. A invited B and granted access with history.
3. B read the record written before B joined.
4. B wrote a record. It went to A's device directly, never through the room. A's device decrypted it, checked the sender, and wove it.
5. The network's room holds no non-state events at all.
6. B's attempts to kick and to ban A were both refused with 403.
7. A removed B. That kicked B on the homeserver, rotated the Megolm session, and wove `revoke` and `epoch` entries.
8. After removal, B's read was refused (`not_a_member`), their write was refused, and they held no key for the record written after removal.
9. The pharos log held no plaintext, and every entry was by Penelope.
10. The key store opened with the right passphrase and refused a wrong one. The file on disk holds no key material in the clear.

**The browser run** (real Chrome, headless, with a throwaway profile):

- Matrix crypto ran in the page, with its state in IndexedDB.
- One record was written to OPFS and another to IndexedDB, and both decrypted in the page.
- No plaintext was at rest in either store.
- Both stores exchanged in both directions with the device server.
- The same person's Node device then decrypted both browser-written records. Matrix had shared the room key to that person's other device, which is the "sync between my own devices" case.

**The database run:**

- A SQLite node was built from `lerocha/chinook-database` at a pinned commit. Its 305 rows (Genre, MediaType, Artist) were woven as `row` entries, and the gap against a fresh node rebuilt from the log alone was zero.
- Four native SQL writes flowed up through Penelope. The UPDATE became a new entry that names the one it supersedes in `of`, and the DELETE became `row-cut`.
- An entry arriving from another node flowed down into the engine.
- A second exchange moved nothing.
- A write that had not been exchanged yet showed up as a measured gap of 1.

**What these tests are not:**

- **Not pre-registered and not independent.** The tests and the code were written together, by the same author.
- **No scale, no adversary, no second homeserver.**
- **Not from anyone's real data.** These are test accounts and a public sample database.

## 2. What a codec must carry, field by field

A weft is `{v, cell, kind, addr, body, of, basis, seen, by, at, id}`.

| field | down (log to engine) | up (engine to log) | what breaks if it is dropped |
|---|---|---|---|
| `id` | kept beside each row (`_pharos_held`) so the node can say which entries it holds | assigned by pharos when Penelope weaves; the engine records it on ack | no gap can be measured; re-exchange duplicates |
| `addr` | the engine key (`db:<name>/<table>/<pk>`) | built from the primary key; must never carry personal content (header fields are inside the entry id and can never be blanked); a keyed hash where it would | rows cannot be matched across nodes |
| `of` | not stored as data; used for order | an UPDATE names the entry it supersedes; a row imported from a node names the `database` entry | erase cannot ripple; supersession and derivation are confused |
| `cell`, `kind` | choose the engine operation (`row` upsert, `row-cut` delete) | chosen by the codec from the native operation | the fold cannot tell a cut from an erase from a value |
| `body` | the row values (ciphertext stays ciphertext unless this node holds keys) | the row as the engine returns it | n/a |
| `basis.witness` | n/a | how the codec knows: trigger name, outbox sequence, engine, database | provenance is lost; an audit has nothing to check |
| `seen` | ignored | computed by pharos; never by the engine | causal order would come from the engine's clock |
| `at` | informational | the engine's commit time goes in witness; `at` is weave time | clock order would masquerade as causal order |
| `by` | never used to decide | always `penelope` in this build; the asker is in `basis.asked_by` | n/a |

Echo suppression: when the codec applies entries down, it sets `_pharos_ctl.applying = 1`, and the capture triggers fire only while it is 0. Without this, every exchange would bounce its own writes back as new entries.

The outbox is a queue, never a store of record. An outbox row is deleted only after Penelope has woven its mark (`ack`). If Penelope is down, the mark stays in the outbox, and in the door's `pending.jsonl`, and is counted.

## 3. Cells for Heimdall's kinds

These are proposals. The 27 cells are pharos's, and the final placement is decided there.

| kind | cell | reading |
|---|---|---|
| `sealed-record` | INS·Figure | a record comes into being; the body is ciphertext |
| `grant` | CON·Figure | a node is connected to the network's room keys |
| `revoke` | SEG·Figure | the node is cut; `of` names its grants |
| `epoch` | REC·Pattern | the key frame is restructured: a new Megolm session |
| `database` | DEF·Pattern | declares a node of another shape, and the repo that defines it |
| `gap-measured` | EVA·Pattern | an evaluation between two nodes, revisable |
| `row` | INS·Figure | a value at an address |
| `row-cut` | SEG·Figure | a deletion in the engine is a cut, never an erase |
| `pulled` | INS·Figure | bytes from outside, with source and sha256 |

Erase is DEF×VOID (leave a tombstone, ripple down `of`) and **is not built here**. It waits on the design being accepted where the write door and the cells are decided.

## 4. Engine families: what each codec has to do

Every family needs the same four calls: `down`, `up`, `ids`, and `holds`. What differs is how changes are captured, what an address is, what the engine's time means, and what is lost.

**Identity, time and absence are the database's own ground.** They are what the design doc calls a ground: identity, dependency, time regime, absence, sufficiency and baseline. A codec must *declare* the engine's ground as a bylined entry, never assume pharos's own. This is **not built yet**: the `database` entry has no ground fields.

| family | down | up (capture) | address | loses / watch for | status |
|---|---|---|---|---|---|
| **SQLite** | upsert/delete per entry | triggers into `_pharos_outbox` | table + primary key | types beyond JSON (BLOB as base64), constraints and indexes (they live in the repo schema), rowid-only tables refused | **built, tested** |
| **Postgres** | upsert in a transaction, with `session_replication_role` or an applying flag for echo | logical replication (`pgoutput` or `wal2json`); slot position = frontier B | schema.table + pk | TOAST and large values, sequences, DDL (needs its own kinds), transaction grouping (one tx = one entry with `of` links between its parts?) | design |
| **MySQL / MariaDB** | same | binlog (row format), GTID as frontier | db.table + pk | same as Postgres; binlog retention bounds how far a node can fall behind | design |
| **MongoDB** | replace or delete by `_id` | change streams; resume token = frontier | collection + `_id` | nested documents are one value or many addresses (a ground choice); `$inc` style ops are lost as values unless captured as ops | design |
| **Redis / KV** | SET/DEL | keyspace notifications are lossy; use Streams or a write-through wrapper | key | TTL expiry is an absence with no writer (must be typed as its own hole kind, never `row-cut`) | design |
| **Graph (Neo4j etc.)** | MERGE nodes and edges | CDC or transaction event handlers | node id, edge (from, type, to) | edges are CON entries whose `of` names both endpoints; deleting a node implies cutting its edges (ripple by `of`) | design |
| **Vector store** | write the embedding with its source entry id | none: embeddings are derived, never authored | source entry id + model | an embedding is content (an erase must void it); it is meaningless without the model version in `basis`; rebuilt, never patched | design |
| **Time series** | write the points | the line protocol or a write hook | series + timestamp | engine time IS the identity; downsampling is a derived node with `of` | design |
| **Search index** | index documents | none (down only) | doc id | a pure read node; must be registered so a revoke or erase rebuilds it | design |
| **DuckDB / Parquet** | write files per frontier | diff of files (no native CDC) | file + row | analytical copies multiply plaintext; keep `holds` honest | design |
| **IndexedDB / OPFS** | marks as-is | the node writes marks directly | mark hash | no Penelope in the browser, so marks wait for a loom | **built, tested** |
| **CRDT stores (Automerge, Yjs)** | apply as ops | the op log *is* entries | doc + op id | closest in spirit (union, no truth); worth a spike before Postgres | idea |
| **SaaS over API (Sheets, Airtable, Notion)** | API writes | webhooks plus a pull connector with ETags | the API's record id | rate limits; their history is not ours; their deletes are opaque | design (pull side built) |

Before any of these is built, run the spike against the real failure first, using the mature engine's own CDC: the "proven piping, not from scratch" rule. Postgres logical replication and Mongo change streams are the proven pipes. Do not write a poller.

## 5. Cross-node exchange: what is still missing

- **Two pharos logs** (the phone's and a laptop's): **built.** They use pharos `merge`, a union of entries by id, through Penelope's new merge route. Re-weaving marks would have been wrong: `of` ids from the other node are unknown here, and Penelope refuses them (`UNKNOWN_OF`). Merge is only between devices of the same user, cross-signed by the owner. The browser stores still exchange marks rather than entries, because they hold no pharos entries.
- **Penelope's merge route** is on her main branch. It checks ids, refuses a kind redeclared at another cell, leaves SIG entries out, and lists every byline that came in, because a merge is the one place an entry bylined as anyone could be written.
- **Conflicts:** two nodes write the same address concurrently, so both entries stay and the fold reports them. The SQLite engine can hold only one row per key, so its `down` keeps whichever comes last in causal order, and the gap measure shows the other. Write that down in the database's ground as its sufficiency rule. Do not hide it.
- **Frontiers:** A's frontier is pharos's heads. B's is engine-specific: an outbox sequence, an LSN, a resume token or a GTID. Every `gap-measured` entry carries both, so "approaching" can be plotted over exchanges.

## 6. Encryption and custody: what kicking someone out does and does not do

Encryption is Matrix's own: vodozemac through `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0, Olm and Megolm.

- **Where records live.** A record is Megolm-encrypted "for" the network's room on the device that writes it, and it is **never sent to the room**. The ciphertext lives on devices: the patient's pharos log, OPFS, IDB, or a member's submission in transit.
- **What Matrix carries.** Room keys travel as Olm to-device messages, which the homeserver deletes once delivered. History keys travel the same way, and only when the subject chooses (`grant(..., { history: true })`).
- **Who can remove whom.** The node that opens a network creates its room at power 100, and every other node sits at 0. Kick, ban, invite, state changes and any room event need 100. No other node can remove the opener, and the homeserver enforces that.
- **What removal does.** Kick, then `invalidateGroupSession`, so the next record starts a new Megolm session shared only with the nodes still in the network. From then on, the opener's device serves records and accepts submissions only from nodes still in the network, checked against the homeserver on every request.
- **What removal cannot do.** It cannot take back what a node already decrypted or copied while it was in the network. Rotation protects the future, not the past. Any system that says otherwise is overclaiming.
- **Holds levels.** A database node of network data that `holds: 'plaintext'` may exist only on a device holding the keys. It must be declared, so that a revoke or erase can find it and rebuild it. The SQLite node above holds public data.

**Keys at rest:**

- In a browser, the crypto machine keeps its state in IndexedDB, encrypted under its passphrase.
- In Node, the machine is in memory, and room keys are exported into `keys/keystore.sealed.json` (scrypt + AES-256-GCM, mode 0600), kept apart from the log.
- In Node, the device identity is not persisted across restarts yet, so a restart is a new Matrix device. **Gap to fix:** persist the Olm account, or use the wasm crate's store when one exists for Node.

**Metadata the homeserver still sees:**

- which nodes are in whose network, and when they joined or were removed;
- device lists;
- the timing and size of to-device messages;
- the sender's Matrix id and Megolm sender key, which sit in the clear in each record's body, so erasing a node's identity will need a pseudonym map.

The answer to the first three is for each person to run their own homeserver, or one they trust. Federation is off in the test server.

**Account trust:** cross-signing is exercised by the merge test (a person's own devices), but not yet required between different people's nodes, and decryption runs at `TrustRequirement.Untrusted` in v0. Next: require cross-signed devices for members, so a homeserver cannot slip in a device.

**Requests between nodes:** every request to another node's device is signed with the asking device's Matrix ed25519 key and checked against the key that user's homeserver publishes, with a timestamp, a nonce and the body's hash. This replaced OpenID tokens, which depend on a homeserver's federation API and failed on Conduit.

## 7. Public repos

A database node is **linked** to a public repo by:

- a full commit sha;
- a path;
- the sha256 of the file at that commit;

all recorded in its `database` entry. The link is read-only: no token, nothing pushed.

Creating a public repo per database is **not done**.

## 8. Work ahead, in order

1. **Device identity in Node:** persist the Olm account, and test a restart.
2. ~~Pharos merge between two pharos nodes~~ (built 2026-11-14). Still open: offer the merge route to Penelope's owner; send only the entries the other side lacks, by frontier, not the whole log every time; three or more nodes; a node that was offline for a long time.
3. **Ground fields** on the `database` entry (identity, time regime, absence, sufficiency, baseline), bylined.
4. **A Postgres codec** on logical replication, spiked against a real failure: a node behind by more than the slot retains.
5. **Require cross-signed devices** for nodes in a network, and a test where a forged device is refused.
6. **A pseudonym map** for node ids in record bodies, so erasing an identity is one act.
7. **Erase (DEF×VOID)**, once the design is accepted: shred keys, void entries, rebuild every registered node whose cone held them.
8. **Isomorphic pharos core,** so a browser node weaves its own pharos entries. This is a change to pharos itself, and that is its owner's call.
9. **Pre-register these claims and have someone else write the tests,** as every other pharos claim has been.

## 9. Run it

```
# a signaling server: node bin/signal.mjs install conduit --dir <folder> --name <name> --port <port> --apply
#   then SURFACE_SIGNAL_DIR=<folder> selects it for the tests (or see matrix/README.md for the local Synapse)
node --test test/network.e2e.test.mjs  # Matrix end to end (needs the homeserver)
node --test test/db.test.mjs           # database node from a public repo (needs network)
node --test test/nodes.e2e.test.mjs    # phone and laptop merge (homeserver, pharos and Penelope)
node bin/demo.mjs --port 8790          # device server + browser page at /app/web/index.html
```

## 10. Signaling: install your own, depend on nobody's

Nobody's nodes should have to ride on someone else's server or account. `bin/signal.mjs` installs a signaling server for one person, in the same shape as pharos's doors: `install` prints a plan and changes nothing without `--apply`; `verify` exits 0 only if the server answers and the owner can log in; `status`; `undo` removes the container it made and keeps the data unless `--purge`. Everything it creates is recorded in `<dir>/instance.json`. It binds 127.0.0.1 only: giving a server a public name and TLS is a separate, deliberate step it does not take.

| engine | image (pinned) | status |
|---|---|---|
| Synapse | `matrixdotorg/synapse:v1.120.0` | network, merge, database and watch tests pass |
| Conduit | `matrixconduit/matrix-conduit:v0.10.15` | installed by the tool; network and merge tests pass |

Two things Conduit taught, both now handled for every server:

- **Room version 12:** the creator holds power implicitly, above every level, and must not be listed in the power-levels `users`. Earlier versions list the creator at 100.
- **No OpenID:** requests between nodes are signed with Matrix device keys instead (section 6).

What any signaling engine must give for a network to work:

1. **accounts**: a user id, devices under it, and a way for another device to prove "I am that user";
2. **networks**: a shared space whose opener alone can remove others, enforced by the server;
3. **key delivery**: device-to-device messages, end-to-end encrypted, deleted once delivered;
4. **sync**: membership and device-list changes pushed to each device;
5. **federation**: nodes on different servers can share one network.

Matrix homeservers give all five. Dendrite, Tuwunel and Continuwuity should work through the same adapter; none is tested. Not done: two people on two separately installed servers in one network (Matrix federation needs reachable names and TLS).

## 11. Federated systems: ActivityPub built, the rest mapped

A federated protocol is one more bridge: activities that arrive become marks, and entries a node **chooses** to publish go out. Sealed records never leave: only kinds a node lists as public can be published.

**ActivityPub** (`federation/activitypub.mjs`, `federation/ap-server.mjs`): an actor document, webfinger, inbox and outbox; HTTP Signatures (draft-cavage, rsa-sha256, with the body digest); follow, accept, publish, undo. Tested between two of our own actors over real HTTP: a follow is accepted, a published note arrives with its signature verified and is woven by Penelope, and an unsigned post, a tampered body, a signer who is not the activity's actor, and an attempt to publish a sealed record are each refused. **Not tested against a third-party server** (GoToSocial, Mastodon); that is the next check, and until it passes interoperability is a claim, not a result.

The verb-to-cell map is a declared codec choice, open to revision:

| activity | cell | reading |
|---|---|---|
| Create | INS·Figure | a thing comes into being |
| Update | DEF·Figure | its value is set again |
| Delete, Undo | SEG·Figure | a cut; the tombstone stays, nothing is erased |
| Follow | CON·Figure | a connection |
| Accept, Reject, Like, Flag | EVA·Figure | an evaluation |
| Announce | SIG·Figure | attention pointed at a thing |
| Block, Remove | SEG·Pattern | a cut in the frame |
| Add | CON·Pattern | a connection in the frame |
| Move | REC·Pattern | the frame is restructured |
| anything else | NUL·Figure | held as received, not interpreted |

Other federated systems, by what each can carry (design only, none built):

| system | accounts | opener-held power | E2EE key delivery | what it could be here |
|---|---|---|---|---|
| Matrix | yes | yes (power levels) | yes (Olm, Megolm) | the full network bridge (built) |
| ActivityPub | yes (actors, HTTP Signatures) | no (each server moderates itself) | no | public publishing and following (built) |
| Nostr | keys only, no server account | no | partial (gift-wrapped DMs) | a public bridge like ActivityPub; relays are interchangeable, which fits "no node is the truth" |
| AT Protocol | yes (DIDs) | no | no (public by design) | a public bridge; its repos are signed logs, the closest in shape to pharos |
| XMPP | yes | partial (MUC affiliations) | yes (OMEMO) | a possible second network bridge; untested whether MUC ownership is as strict as Matrix power levels |
| Email (SMTP, IMAP) | yes | no | optional (PGP, S/MIME) | a source and a destination, never a network |
| IPFS, Hypercore | keys | no | no | a place to carry ciphertext between nodes, never accounts |

A bare WebRTC signaling server, ntfy or a webhook relay gives only delivery; it cannot hold a network on its own.

## 12. Heimdall's watch

`lib/heimdall.mjs`. The loop is the same one the older Heimdall (the watcher of a local model's surfaces) uses, applied to bridges:

- **DEF**: every bridge watched is declared by name. A bridge nobody declared is not crossed.
- **EVA**: probe the bridge. A probe writes nothing.
- **REC**: only where the probe found something waiting, cross once, then probe again.

His walls: no cross without a probe that found something; one cross per bridge per tick, and a bridge still open afterwards is a finding, never a loop; a bridge that is down is raised with its reason, never restarted silently. One `watch` entry (EVA·Pattern) is woven per tick that crossed or raised anything; a quiet tick writes nothing.

Bridges ready today: `databaseBridge` (engine changes up, log entries down), `peerBridge` (another node of the same person; open only on a content gap, since exchange records always differ), `signalBridge` (is the signaling server answering). Tested: a quiet tick weaves nothing, a waiting database bridge is crossed once, a stuck bridge is crossed once and reported, a dead signaling server is raised.

## 13. Transport: everything crosses over Matrix, nothing is stored in a room

`lib/transport.mjs`, `lib/courier.mjs`. No node has to be reachable by another. The direct device-to-device call (sections 1 and 6) is now an optional fast path, not a requirement.

**Where data lives:** in each device's own store, as ciphertext. Matrix carries it; it does not keep it in rooms.

**The ladder:**

| rung | when | how |
|---|---|---|
| to-device | the gzipped payload is under 24 KB | one Olm-encrypted to-device message. If the other device is online it arrives at once; if not, the homeserver queues it and deletes it on delivery. |
| media store | anything larger | gzip, cut into shards, encrypt each shard with Matrix's own encrypted-attachment scheme (AES-256-CTR, sha256 of the ciphertext), upload, and send the manifest (addresses and keys) as a to-device message. The other device fetches the shards when it is next online, checks each hash, decrypts, joins, gunzips. |

- **Order:** gzip first, because ciphertext does not compress; then shard; then encrypt each shard, so each is verifiable and retriable alone.
- **Sharding** is for the server's upload limit. It adds no secrecy.
- **Online or offline is the same code path.** A to-device message is delivered immediately to a device that is syncing and queued for one that is not.

**The CRDT is the log itself.** A pharos log is a grow-only set of entries, and union by id is the merge. So syncing two of a person's devices is: one says which ids it holds (`peer.offer`), the other sends what is lacking and its own ids (`peer.entries`), the first sends what the other lacks. Only what is lacking travels. A library such as Yjs or Automerge would be for live co-editing of one document, which is not built.

**Between different people's nodes:** `net.want` asks the holder for a network's records and gets `net.records` or `net.refused`; `net.submit` hands in a record and gets `net.ack`. Membership is asked of the homeserver when the holder handles the message, so a node removed while the holder was offline is refused even for a request it sent while still a member.

**Tested on Synapse and Conduit** (`test/carry.e2e.test.mjs`), with no device server running:

- two devices of one person sync small data through to-device messages only, and only what the other lacked is sent;
- with one device offline, 40 records (208 KB, 138 KB gzipped) cross as 9 encrypted shards, and the device merges and decrypts all 40 when it returns;
- a stored shard is not gzip and contains no entry structure, record text or user id;
- another account on the same server receives no manifest;
- a shard altered by one bit is refused;
- another person's offer to merge is refused (`not_own_user`);
- a second person reads and writes a network over Matrix alone, and after removal a request sent earlier is refused.

**What this costs, said plainly:**

- **The media store does hold ciphertext on the homeserver.** The Matrix client API has no way to delete media; only the server's operator can purge it or set retention. On a server you installed that is in your hands. On someone else's server the shards outlive the exchange. Every upload's address is returned to the sender so it can be recorded and purged where that is possible; the purge itself is not built.
- **The homeserver sees** sizes, timing and who sent to whom, for both rungs.
- **A to-device queue is not unlimited.** Servers cap how much they hold for an offline device. Large or long-offline cases belong on the media rung; where the cap is has not been measured.
- **Not built:** a live WebRTC channel for fast traffic when both are online; presence (the ladder chooses by size, never by guessing who is online); resuming a partly fetched payload; sending in several payloads when one manifest would itself exceed a message.

**The encrypted database on the device** is two different things, and both are wanted:

1. each record encrypted under its network's keys (built: this is what is shared and what removal acts on);
2. the whole local database encrypted under a device key, for querying on the device (not built; it would be a local, rebuildable copy, never the thing that is shared).
