# ACTIVITIES — everything heimdall does, and what happens when it breaks

Written 2026-10-04 against the current tree, after reading every file in
`src/` and running the whole test suite. Every activity below descends to a
real path; where a claim is unproven it is marked, never dressed up. The
project's own rule: a "wired" claim is checked against the code, and a
feature with no test and no live traffic is reported as wired-but-unproven.

## The one law: degradation, not failure

Heimdall's work nests in layers, and each layer's job is either **possibility**
(the layer always exists, no matter what breaks above it) or **probability**
(the layer makes the good path the usual path). A higher layer that breaks
never kills the work: the request **steps down** to the next layer that can
serve it, and the record shows the drop. The work continues, just not as well.

The ladder, by power, then by fallback:

```
1  frontier   a sealed external provider (groq/anthropic/openai/…)   probability
2  native     a linked native app host (LAN/Tailscale, real GPU)     probability
3  fleet      browser-tab horses (WebLLM/WebGPU + WASM fallback)     probability
4  upstream   this machine's own Ollama (the guaranteed floor)       possibility
5  in-tab     the page's own WebLLM when the bridge is gone         possibility
```

`runOnGiver` (`src/bridge-server.mjs`) walks rungs 1→3 in order: a rung that
fails **before its first token** steps down to the next; a rung that dies
mid-stream never steps down (the caller already holds partial output). When
the ladder is exhausted the bridge's callers answer from rung 4 (`upstream`).
The drop is never silent: `stats.fellThrough` counts it once per request, and
when a lower rung inside the ladder serves, the dispatch ledger records
`reason: "fell-through"` with the lane that **actually** served — so the
meter's "exact external tokens" can never be inflated by a frontier that
failed.

## The layers, what each does, and its test truth

### L1 — The doors (heimdall as a part of The Fold)

The wire shapes the surfaces speak; heimdall executes none of them:

| Door | Route | Goes to | Live |
|---|---|---|---|
| Ollama wire | `POST /api/chat`, `/api/generate` | the ladder → rung 4 | yes (tested) |
| OpenAI wire | `POST /v1/chat/completions` | the ladder → rung 4 | yes (tested) |
| Anthropic wire | `POST /v1/messages` | the ladder → rung 4 | yes (tested) |
| Machine door | `POST /api/code` | a local `opencode serve` (`src/opencode-lane.js`) | configured, idle |
| Read door | `POST /api/read` | the khora's model-free reader | configured, live seam |
| Generation door | `POST /api/weave` | penelope's weave | configured, no consumer yet |
| Keys | `POST /api/providers/keys` | `~/.heimdall/state.json` (loopback socket check) | yes (tested) |
| Links | `/link/*` | `~/.heimdall/hosts.json` | yes (untested at the bridge) |
| Controller | `/bridge/events`, `/bridge/state`, `/bridge/reply` | the open SSE controller tab | wired, unauthenticated |
| Accounting | `/api/ledger`, `/api/meter`, `/api/frontier`, `/status` | the dispatch ledger + stats | yes (tested) |

### L2 — The gate (admission)

Who and what may cross, before any routing:

- **Loopback bind** — the bridge listens on 127.0.0.1 (`src/bridge-server.mjs`).
- **Origin wall** — a request with an `Origin` header is refused unless it is
  the bridge's own page, any loopback page, or an explicit `allowedOrigins` /
  `HEIMDALL_ALLOWED_ORIGINS` entry. Never `*`.
- **The sealed frontier gate** — a frontier model is reached only when the
  body carries `heimdall_privacy: "sealed-external"` (the Fold's privacy
  mode). This is the Fold's trust boundary for outside models.
  **Honest limit:** the label is caller-asserted — the gate cannot tell
  whether the bytes under it really are a sealed projection. It stops
  accidents, not a malicious caller.
- **Key store** — provider keys live server-side only, written beside the
  CLI's state, never echoed to a client, never sent to a horse.

Tested: the frontier gate (refusal without the label, keyed dispatch, meter
exactness), origin reflection/refusal, key store round-trip. Untested: the
controller endpoints (`/bridge/*`) have no automated test and no
authentication — any local process can read prompts, forge replies, or
rewrite fleet state through them. That is the known hole.

### L3 — The router (the degradation ladder)

One decision, in one place: `runOnGiver` (`src/bridge-server.mjs`). Ladder
rungs 1→3, step-down on before-first-token failure, ledger records the drop.
A job naming a model only ever lands on a giver that holds that exact model
(`resolveLink`, `answers`, and the frontier map); `any`/`fleet` unpins.

**Honest truth about the registry:** `src/executors.js` (the "ONE
inventory" of remote providers + horses with `E[T_accepted]` scoring) is
fully tested as a pure module but is **not wired into the running bridge** —
its only production caller is `src/code-fix.js`, which only its own test
imports. The README's registry story describes a design and a test path,
not the live path. The live path is the ladder above.

**The cheap route (2026-10).** `POST /api/job` (`src/job-lane.js` →
`src/escalation.js`) resolves a job to a route and judges every proposal with
the job's own local `acceptance` checks. A job that sets `routing: "cheapest"`
(or `objective: "batch"`) minimizes expected cost per accepted answer,
`E[$_accepted] = C / P`, instead of time — so a free local/device route is
tried and checked before any paid route is paid for, and a failing proposal
escalates rather than being kept. On the final attempt (when no budget is left
to recover) cost stops mattering and the pick maximizes the measured accept
probability. This is live on the bridge (`POST /api/job`), tested in
`src/escalation.test.mjs` (10 cases) and shown in `scripts/route-sim.mjs`
scenario 6.

**Falsifying the cheap route (2026-10).** `scripts/falsify-cheapest.mjs` runs
identical jobs under `cheapest` and `fastest` with per-(job,route) deterministic
model behaviour, so only the routing differs. Result, stated honestly:
- it holds where the free lane is adequate (benign world: same accepted rate,
  ~8× cheaper) and never accepts materially fewer jobs than fastest in any
  world tried;
- the first version **failed** the adversarial world (more bad free lanes than
  the attempt budget → `cheapest` accepted **0%** vs `fastest` **100%**, because
  a free lane's expected cost is `0/P = 0` for any pass rate). The last-attempt
  reservation above is the fix; the flood world now accepts 100%;
- a **bounded residual** remains (tight budget, everything unmeasured: ~0.6% of
  jobs gambled on a cheap lane and lost, while still costing less) — the price
  of exploring cheap lanes, no longer a 0%-vs-100% cliff;
- with a **weak acceptance check** it is worse: a schema-only gate let
  `cheapest` keep wrong answers 72% of the time vs `fastest` 9% — because a
  cheaper model is used more often. The mode is only ever as strong as the
  job's own `acceptance`; a job that cannot define a good answer ahead of time
  must not use it (the reason `qualityFloor` exists and stays unread here).

**The void loop + learning who is good at what (2026-10).** `src/void.js` makes
the job lane the Fold's own void recursion: **DEF** the void from the job's
`acceptance` closure (a job with no acceptance defines no void — a typed
`no-closure` gap, never a fillable one); **EVA** the *satisfaction* of each
proposal (satisfied / refuted / gap, three-valued); **REC** onto the next giver
on a refutation, and a **wall** (disclosed) when no giver fills it. It is built
on `escalation.runJob`, so eligibility, disclosure and deadlines are unchanged.
Every EVA also **teaches** the competence table (`competence.js`), keyed by the
giver's **model × taskClass × size bucket** — "who is good at what" — and the
void's routing P is read back from that table when it has evidence, so what was
measured is what routes next. `/api/job` runs this loop and persists the table
(`~/.heimdall/competence.json`). Tested in `src/void.test.mjs` (7 cases), and
falsified in `scripts/falsify-void.mjs`: **0 false satisfactions** over 300
voids (never reports the void filled without the check holding, re-verified
independently); learning moves selection (a fast-but-bad model's share of first
picks 35% → 0% over 120 voids); an unsatisfiable void walls (never a silent
fill); and a **model pin (the received floor) is honored over learning**. Honest
limits: the competence table is only as good as the EVAs that feed it (a weak
gate teaches the wrong lesson); a table cell needs trials before it can move a
decision; and a refuted model is not retried on the same void, but may return on
a later one as fresh evidence accrues.

**Pulling a job apart: tool-calling vs generation, merged by the system
(2026-10).** `src/compose.js` makes a job a set of **parts** — declared
(`job.parts`) or inferred mechanically from `requires`/`protocols` (never
drawn): a part needing `native-tools` becomes `mechanical.tool`, the rest stay
the job's own class. Each part is its own void (chased with `void.js`), so the
competence table learns **who is good at tool calling** separately from
generation; the tool part can only reach a model that advertises tools. The part
proposals are **merged by the system** (`assemble` — a pure function, zero model
calls), and the **whole** is EVA'd after assembly (the cut sees the whole stack:
completeness ↔ Gebser, exclusivity ↔ Houdini). A cut that overlaps a capability
or fails to cover the job is refused with a typed gap (`not-exclusive` /
`not-complete`), never run. `/api/job` runs this (a job with no `parts` and no
tool need stays a single void). Tested in `src/compose.test.mjs` (8 cases) and
falsified in `scripts/falsify-compose.mjs`, all PASS: the merge makes **no model
call**; a tool part only ever reaches a tool-advertising model (and is never
faked on a non-tool model when none exists); a composite is **never accepted
when the whole check failed after assembly**; bad cuts are refused; and
tool-calling competence stays distinct from generation competence. Honest
limits: per-part learning needs a per-part `acceptance` (a part with none is
drawn and judged only in the whole, teaching nothing); the inferred split
carries no part checks by default, so callers wanting per-capability learning
declare the parts; and the merge is by `id`/`text` (or `fields`), so a job that
needs a richer join declares a merge rule.

### L4 — The executors (the acts)

| Executor | Transport | Wired | Tested | Live |
|---|---|---|---|---|
| Upstream Ollama (rung 4) | `pipeUpstream`, loopback | yes | yes (bridge) | yes — today's only traffic |
| Frontier providers (rung 1) | `src/remote.js` wires, TLS, keys | yes | best-tested lane | probed, zero real dispatches |
| Linked native apps (rung 2) | LAN/Tailscale HTTP (`src/links.mjs`) | yes | untested at the bridge | no links live |
| Browser-tab horses (rung 3) | Matrix + WebRTC DataChannel | yes | **no automated test** | no horses live |
| In-tab WebLLM / WASM | `src/llm.js`, `src/llm-worker.js` | yes | **no automated test** (browser-only) | dormant |
| LM Studio / llama.cpp / LocalAI / vLLM | `src/discovery.js` records | **discovered only — never routed to** | — | no |
| Puter.js | `src/remote.js` wire | wire-complete | tested | **no live route selects it** |
| Transformers.js lane | declared in the catalog | declared | — | only via the WASM fallback |

The frontier, native, and fleet rungs each normalize to one contract
(`{ text, ms, tokens }`, reject with `beforeFirstToken`), which is what makes
the ladder one code path.

### L5 — The record (accounting)

- **The dispatch ledger** (`src/dispatch.js` + the bridge) — every frontier
  choice and every fell-through step-down, with the reason, the actual
  tokens, and the lane that served. Append-only, written only by the bridge
  process (an executor can never forge it). **Honest limits:** memory-only
  (lost on restart), fleet dispatches that do NOT step down are not ledgered,
  and "tokens" are chunk counts from the SSE stream, not provider usage
  figures.
- **The meter** (`/api/meter`) — exact external tokens per lane, with the
  frontier-everything and raw-context figures marked as estimates, never
  passed off as measured.
- **The credit ledger** (controller tab) — pairwise give/take between
  fleet members, enforced at the router. **Honest limit:** results are
  unsigned, so a malicious horse can forge answers and mint credit.

## What is live today, end to end

A `heimdall up` run with no controller tab, no links, no configured frontier
is rung 4 alone: every chat request walks the ladder, finds only the fleet
rung (no tab → step down), and is answered by upstream Ollama, counted as a
passthrough. That is the guaranteed floor, and it is the reason the ladder
is honest rather than aspirational.

## Security posture, stated plainly

- **Holds:** the frontier gate structurally (no request reaches a frontier
  model without the label check); keys never reach horses and no API returns
  key values; the ledger cannot be forged by an executor; the worker-side
  creator wall (a stranger cannot make a horse serve them).
- **Does not hold:** the sealed label is unverifiable; the controller
  endpoints and `/api/code` are unauthenticated against local processes and
  loopback pages; a linked native host outranks the fleet and `/link/host`
  has no socket check (an SSRF + lane-hijack); horse results are unsigned
  and model claims self-reported; a stranger controller can receive
  forwarded prompts; `~/.heimdall/*.json` is written 0644 with real keys;
  `/status` returns native-host keys.
- The fixes are structural, not patches: authenticate the person (a
  per-bridge capability), split the bridge's surfaces by trust boundary,
  tier executors by byte-destination rather than model-kind, and make the
  record cover every off-machine byte.

## Test truth (2026-10-04, `node --test src/*.test.mjs`)

- 114 tests, all green. Covers: the frontier gate, the ladder (4), the
  remote wires, keyless-auth taxonomy, the registry as a pure module, the
  dispatch ledger, key store, origins.
- **Not covered by any automated test:** `matrix.js`, `rtc.js`,
  `route.js`, `liveness.js`, `llm.js` (browser), the two-tab fleet path,
  native links, the `/bridge/*` controller endpoints, the `/api/code` route.
- The docs once claimed `liveness.test.mjs` (10 cases) and
  `falsify-route.mjs` (8000 picks); neither file exists. This document is
  the honest replacement.