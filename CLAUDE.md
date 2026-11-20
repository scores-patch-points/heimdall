# heimdall: distributed local inference

> Generated from the nexus manifest (`scores-patch-points/nexus`). Do not edit by hand: change `nexus/nexus.json` or `nexus/cards/heimdall.md` in the map repo and regenerate; the map's tests catch drift.

You are in one repo of the **nexus** (`scores-patch-points`): an interconnected body with **no wrong door**. Whichever repo you enter, you can learn the whole from it. The map: https://github.com/scores-patch-points/scores-patch-points.

## What this repo is
Level `L2-satellite`. Default branch `main`.

*pkg `heimdall` · `scores-patch-points/heimdall`*

- **Does:** turns any phone or laptop into a managed compute node — a link,
  **Accept**, the device runs a small model in-browser and streams answers back;
  Matrix for signaling, WebRTC for data, WebLLM for local inference; the gate
  (typed admission), the fleet, the ledger.
- **Doesn't include:** any central datastore (no data on a central server); content
  reasoning/generation; the corpus or the reader.
- **Finds at:** `README.md`; `ACTIVITIES.md` (the whole map: doors, gate, the
  degradation ladder, executors, the test/security truth).

## Doors, gate, siblings
- Doors:
  - TYPED GAP: no door is declared for this repo yet. Say so; do not guess one.
- Gate (run it before you finish): `npm test`
- Siblings: none declared

## Rules in every repo of the nexus
1. Respect the boundary. If a repo's "Doesn't include" names your thing, it belongs in another holon: put it in the smallest holon whose boundary includes it.
2. A typed gap beats a guess. An unknown repo, door, gate, prior or dataset is stated as a gap. A missing sibling or prior is a refusal that says how to get it, never a silent degrade.
3. Start from the default branch of origin, not a stale branch, and say which commit you read.
4. Read and write through the repo's declared door. Do not build a second reader or a second door beside it.
5. Do not push, merge or change user-level configuration without the owner's yes. Commit only paths you can name.
6. Quote every number with its split (dev, fresh, held-out, reused, exploratory) and its stamp. A measure that changed is a new row or a recorded pin, never the same number under the same name.
7. A negative result is a finding: record it with its falsifier.
8. Language is read by the reader, never by a pattern: a sentence, a question, a name or a relation goes through the reader's rows (its UD codec) to marks in EOT, and matching and reasoning happen on those marks, never on surface strings; a language with no codec is a typed gap, never English by default. Carry the text-regex ratchet (the count of regex applications may not grow); a pattern on a path, hash, id or file format is declared `// regex-ok: <why it is not language>`.

## Before you start
- `git fetch`; work from `origin/main` and name the commit you read.
- The research rules and what is already established: https://raw.githubusercontent.com/scores-patch-points/penelope/main/BRIEF.md.
