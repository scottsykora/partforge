# Request-a-pick: agent-initiated click clarification — design

**Date:** 2026-06-25
**Status:** Approved (design); pending implementation plan
**Builds on:** the `selection` module (click-to-select, partforge ≥0.4.0) — reuses
`attachPicker(viewer, { onPick })` and `formatSelection(selection, { style })`. Reuses
the existing `bin/cli.js` for new subcommands.

## Motivation

click-to-select lets a user *push* a selection to an LLM. This is the inverse, and
it's the simpler, ship-sooner half of the agent story: an LLM agent already running in
Claude Code — which started the local pick-server — can *pull* a clarification
mid-task. "I'm not sure which face you mean — check your browser and click it." The
browser arms the picker with that prompt, the user clicks, and the `Selection` flows
straight back into the agent's turn so it keeps working.

It contains **no LLM logic**: a local server holds pending click requests, a blocking
CLI prints the resulting `Selection`(s) as JSON, and a browser client arms the existing
picker on demand. Anything that can run a shell command (a Claude agent, a script) can
use it. That makes it generic click-routing infrastructure — the open part — so it
lives in partforge itself, not the `partforge-agent` harness. It adds **no new runtime
dependency** (Node's built-in `http`, plus the picker that already exists).

(The richer chat-bridge harness — spawning/continuing Claude sessions via the Agent
SDK — stays in the separate `partforge-agent` repo and is on hold.)

## Scope

In scope (v1):
- A local **pick-server** (started by the agent) holding **one active batch** of click
  requests at a time.
- **Batch picks:** the agent requests N labeled prompts in one call; the browser walks
  them one at a time; all results return together.
- A blocking **CLI** (`partforge pick …`) that prints the ordered `Selection` array.
- A **browser client** that arms the existing picker on demand with a prompt banner +
  cancel.
- **Built-in skill + authoring docs** defining the workflow.

Deferred (YAGNI for v1):
- Multiple concurrent batches / a request queue beyond one active batch.
- Non-localhost exposure, auth, multi-user.
- Any model/LLM logic (that's `partforge-agent`).

## Architecture

```
agent (Claude Code)                         browser (partforge app, ?pickserver)
  $ partforge pick-serve &  (once)             client connects to the pick-server
  $ partforge pick \                           SSE: armed only when a batch is active
      "click the mounting hole" \
      "click the face to fillet"
        │ POST /request {prompts:[…]}            ┌────────────────────────────────┐
        ▼          (blocks)                      │ banner: "🤖 click (1 of 2):     │
   pick-server ──SSE prompt{index,total}──▶ client│  click the mounting hole" + [x]│
        │                                        │ arms picker (setActive true)    │
        │ ◀──POST /resolve {id,index,selection}──┘ on click → next prompt / done   │
        │                                        └────────────────────────────────┘
        ▼ responds {status:"done", picks:[{prompt, selection}, …]}
   CLI prints the array to stdout → agent reads it → continues
```

Three units, each independently testable, none knowing the others' internals — only
the HTTP/SSE contract:

```
src/framework/pick-request/
  batch.js     # pure state machine: create/advance/cancel/timeout a batch. No http, no DOM.
  server.js    # Node http + SSE wrapping batch.js (createPickServer({port}) → {start,stop})
  client.js    # browser: createPickRequestClient({serverUrl, viewer}) → {detach}
  index.js     # surface
bin/cli.js     # + `pick-serve` (start server) and `pick <prompts…>` (blocking request)
```

## Component: batch state machine (`batch.js`)

Pure, transport-free — the heart of the feature, fully unit-testable.

```js
// createBatch(prompts) → batch
// resolve(batch, index, selection) → batch         (records a click, advances)
// cancel(batch) / timeout(batch) → batch
// view(batch) → { id, index, total, prompt, status } // status: collecting|done|cancelled|timeout
// result(batch) → { status, picks: [{ prompt, selection }, …] }  // picks collected so far
```

- One active batch. `index` is the current prompt; `resolve` appends `{prompt,
  selection}` and advances; when `index === total`, status → `done`.
- `cancel`/`timeout` freeze the batch with whatever was collected, so a partial result
  is still returned (the agent adapts rather than hanging).
- Ordered `prompts` in → ordered `picks` out, each echoing its prompt so the caller
  maps results to asks. (A future `--label` can add keys; ordering suffices for v1.)

## Component: pick-server (`server.js`)

Node built-in `http`, **127.0.0.1 only**. Wraps `batch.js`.

- `POST /request` `{ prompts: [string, …] }` → if a batch is already active, respond
  `409 {status:"busy"}`; else create the batch and **hold the response open** until the
  batch reaches a terminal status (`done`/`cancelled`/`timeout`) or the server-side
  timeout fires, then respond `{ status, picks }`. (One blocking call from the CLI's
  view.)
- `GET /events` → **SSE** to the browser. On connect, replays the current prompt if a
  batch is active (no missed-event race); emits `prompt {id,index,total,prompt}` on each
  advance, and `cleared` on terminal status.
- `POST /resolve` `{ id, index, selection }` → `batch.resolve(...)`; ignored if `id`/
  `index` don't match the active step (stale click guard).
- `POST /cancel` `{ id }` → `batch.cancel(...)` (the browser's "Can't find it" button).
- CLI/flags via `bin`: `--port` (default 4518), `--timeout` (default 120 s).

## Component: CLI (`bin/cli.js` additions)

- `partforge pick-serve [--port 4518]` — start the pick-server (the agent runs this
  once, typically backgrounded). Prints the URL it's listening on.
- `partforge pick "<prompt>" ["<prompt>" …] [--port 4518] [--timeout 120]` — POST the
  prompts, **block** until the batch resolves, then print to stdout:
  - a short human summary (one `formatSelection(…, {style:"prompt"})` line per pick), and
  - the raw JSON `{ status, picks:[{prompt, selection}, …] }`,

  so the agent reads it naturally and can parse it. Exit non-zero on
  `cancelled`/`timeout`/`busy` (with the JSON still printed) so the agent branches.

## Component: browser client (`client.js`)

`createPickRequestClient({ serverUrl, viewer }) → { detach }`. Framework-free,
self-created DOM (same approach as the pick toast). Inert during normal use; opt-in via
a `?pickserver` flag (or `mount(part,{pickServer:url})`), mirroring `?pick`.

It owns its **own** `attachPicker` instance (its `onPick` resolves the active request),
kept disarmed except while a prompt is pending. `?pickserver` and the clipboard-mode
`?pick` are **alternative** modes — when `?pickserver` is on, mount does not also attach
the clipboard picker, so only one click listener is ever live.

- Subscribes to `GET /events`. On `prompt`: show a banner
  **"🤖 Claude needs you to click (2 of 3): *click the face to fillet*"** with a
  **"Can't find it / cancel"** button, and `picker.setActive(true)`.
- On the next click: `POST /resolve {id,index,selection}`; the server's next `prompt`
  (or `cleared`) drives the banner forward. On the final pick: "✓ sent 3 picks to
  Claude", disarm.
- On cancel button: `POST /cancel {id}`; banner clears.
- Bridge offline / SSE drop: a small "agent pick-server not reachable" note; retries the
  SSE connection.

## Error handling

- **No click in time** → server `timeout`; CLI exits non-zero with partial `picks`;
  banner auto-clears.
- **Busy** (a batch already active) → `409`; CLI prints `{status:"busy"}` and exits
  non-zero so the agent waits/retries.
- **Stale/duplicate click** (index mismatch) → server ignores it.
- **Browser closed / server down** → CLI fails fast with a hint to open the app and
  start `partforge pick-serve`.

## Safety

- **127.0.0.1 only**, single active batch.
- The primitive only *reads* clicks — no file writes, no shell, no model calls. Minimal
  blast radius.

## Documentation & built-in skill

The workflow ships as first-class, discoverable documentation:

1. **`skills/partforge/SKILL.md`** (new; added to `package.json` `files` so it ships
   with the package) — *agent-facing*. Covers: when to request a pick (ambiguity over
   which face/edge/part the user means), the etiquette ("tell the user to check their
   browser"), how to start `partforge pick-serve`, how to call `partforge pick` with one
   or many prompts, how to read the ordered result array, and how to handle
   `timeout`/`cancelled`/`busy`.
2. **`docs/AUTHORING-PARTS.md`** — a new section **"Interactive clarification:
   request-a-pick"** describing the workflow and the `?pickserver` opt-in for app
   authors, alongside the existing `?pick` documentation.
3. **`README.md`** — a short mention + pointer under the existing feature list.

These are part of the deliverable, not an afterthought: the implementation plan
includes doc/skill tasks with the same review gate as code.

## Testing

- **`batch.js`** — pure unit tests: create → resolve in order → `done`; partial on
  `cancel`/`timeout`; stale-index resolve ignored; ordered prompts → ordered picks with
  prompts echoed.
- **`server.js`** — with a real `batch.js` over loopback: `POST /request` holds open and
  returns `{status,picks}` once resolves arrive; `GET /events` replays the active prompt
  on connect and streams advances; `409` when busy; binds to 127.0.0.1.
- **`bin` `pick`** — against a stubbed/looped server: blocks, prints summary + JSON,
  non-zero exit on timeout/cancel/busy.
- **`client.js`** — happy-dom + mocked `EventSource`/`fetch`: `prompt` shows the banner
  (with index/total) and arms the picker; click POSTs `/resolve`; cancel POSTs
  `/cancel`; offline note path.
- **Docs/skill** — reviewed for accuracy against the shipped CLI/flags (a doc task in
  the plan), not automated.
- **End-to-end** (real agent runs `partforge pick`, real clicks, real return) —
  documented manual check.

## Out of scope

- Concurrent batches / a queue beyond one active batch.
- Labels/keys on prompts (ordering suffices for v1; easy later extension).
- Auth, non-localhost exposure, multi-user.
- Any LLM/agent-loop logic — that's `partforge-agent` (the chat bridge).
- Changes to the `selection` module itself — this consumes it unchanged.
