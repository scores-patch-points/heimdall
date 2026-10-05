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