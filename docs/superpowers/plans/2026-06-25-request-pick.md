# Request-a-pick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external process (e.g. a running Claude Code agent) request one or more clicks from the live partforge app and get the resulting `Selection`(s) back, via a local server + blocking CLI + on-demand browser picker.

**Architecture:** A pure `batch.js` state machine (ordered prompts → ordered picks), a Node-`http`/SSE `server.js` that wraps it plus a `requestPicks` CLI client and `formatPickResult` output helper, a framework-free browser `client.js` that arms the existing `attachPicker` on demand, two new `bin/cli.js` subcommands (`pick-serve`, `pick`), `?pickserver` mount wiring, and a built-in skill + authoring docs. No new runtime dependency (Node built-in `http` + the existing selection picker).

**Tech Stack:** Node 24, ESM, Node `http`, three.js 0.184 (only via the reused picker), Vitest 4 (+ happy-dom for DOM tests).

## Global Constraints

- **Repo:** partforge (this directory). Branch `request-pick` (already created off `main`).
- **Node:** `>=24` (`.nvmrc`); ESM only. Run tests under the pinned Node (`nvm use` first; a stale shell on Node 16 fails with a `styleText` import error).
- **No new dependencies.** Server uses Node built-in `node:http`; the browser client reuses `attachPicker` from `src/framework/selection/`.
- **License:** MIT (ships inside partforge). **No LLM/Agent-SDK logic** in this feature.
- **Network:** the server binds to **127.0.0.1 only** — never `0.0.0.0`.
- **Default port:** `4518`. **Default timeout:** `120` seconds.
- **Status vocabulary** (exact strings): batch status is one of `collecting` | `done` | `cancelled` | `timeout`; the `POST /request` response/CLI may also surface `busy` (HTTP 409). A pick is `{ prompt: string, selection: Selection }`. Results are `{ status, picks: [...] }` with picks in request order.
- **Tests:** `npm test` (full suite); single file `npx vitest run <path>`. DOM tests begin with `// @vitest-environment happy-dom`.
- **Commits:** conventional subjects; every commit message ends with the `Co-Authored-By:` and `Claude-Session:` trailers configured for this session.

---

## File structure

| File | Responsibility |
|---|---|
| `src/framework/pick-request/batch.js` (new) | Pure state machine: create/advance/cancel/timeout a batch; derive view + result. No http, no DOM. |
| `src/framework/pick-request/server.js` (new) | Node `http` + SSE server wrapping `batch.js`; `requestPicks` CLI client; `formatPickResult` output helper. |
| `src/framework/pick-request/client.js` (new) | Browser: `createPickRequestClient(...)` — banner + SSE + arms `attachPicker`. |
| `src/framework/pick-request/index.js` (new) | Surface — re-exports the browser client. |
| `bin/cli.js` (modify) | Add `pick-serve` and `pick` subcommands; refactor arg parsing to a uniform `argv.slice(3)` parse. |
| `src/framework/mount.js` (modify) | `?pickserver` opt-in mounting the client (alternative to `?pick`). |
| `skills/partforge/SKILL.md` (new) | Agent-facing skill for the request-pick workflow. |
| `docs/AUTHORING-PARTS.md` (modify) | New "Interactive clarification: request-a-pick" section. |
| `README.md` (modify) | Short pointer under the feature list. |
| `package.json` (modify) | Add `skills/partforge/SKILL.md` to `files`. |
| `test/pick-batch.test.js`, `test/pick-server.test.js`, `test/pick-cli.test.js`, `test/pick-client.test.js`, `test/pick-index.test.js` (new) | Tests per task. |

---

## Task 1: `batch.js` — pure state machine

**Files:**
- Create: `src/framework/pick-request/batch.js`
- Test: `test/pick-batch.test.js`

**Interfaces:**
- Produces:
  - `createBatch(prompts: string[]) → batch`
  - `view(batch) → { id, index, total, prompt, status }` (`prompt` is `null` when not collecting)
  - `resolve(batch, index, selection) → batch` (records a click and advances; ignores stale/duplicate index or a non-collecting batch)
  - `cancel(batch) → batch`, `timeout(batch) → batch`
  - `result(batch) → { status, picks: [{ prompt, selection }, ...] }`

- [ ] **Step 1: Write the failing test**

```js
// test/pick-batch.test.js
import { expect, test } from "vitest";
import { createBatch, view, resolve, cancel, timeout, result } from "../src/framework/pick-request/batch.js";

const sel = (n) => ({ subPart: n, point: [0, 0, 0], normal: [0, 0, 1], params: {} });

test("createBatch starts collecting at index 0", () => {
  const b = createBatch(["click A", "click B"]);
  expect(view(b)).toMatchObject({ index: 0, total: 2, prompt: "click A", status: "collecting" });
  expect(typeof b.id).toBe("string");
});

test("resolving in order advances, then completes with ordered picks echoing prompts", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 0, sel("a"));
  expect(view(b)).toMatchObject({ index: 1, prompt: "click B", status: "collecting" });
  resolve(b, 1, sel("b"));
  expect(view(b).status).toBe("done");
  expect(result(b)).toEqual({
    status: "done",
    picks: [{ prompt: "click A", selection: sel("a") }, { prompt: "click B", selection: sel("b") }],
  });
});

test("a stale/duplicate index is ignored", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 1, sel("x")); // not the current index (0)
  expect(view(b).index).toBe(0);
  resolve(b, 0, sel("a"));
  resolve(b, 0, sel("a-again")); // index already advanced past 0
  expect(view(b).index).toBe(1);
});

test("cancel and timeout freeze with partial picks", () => {
  const b = createBatch(["click A", "click B"]);
  resolve(b, 0, sel("a"));
  cancel(b);
  expect(result(b)).toEqual({ status: "cancelled", picks: [{ prompt: "click A", selection: sel("a") }] });
  expect(view(b)).toMatchObject({ status: "cancelled", prompt: null });

  const c = createBatch(["click A"]);
  timeout(c);
  expect(result(c).status).toBe("timeout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pick-batch.test.js`
Expected: FAIL — cannot resolve `batch.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/pick-request/batch.js
// Pure state machine for one batch of click requests: ordered prompts in,
// ordered picks out. No http, no DOM, no timers (the server owns the clock).
import { randomUUID } from "node:crypto";

export function createBatch(prompts) {
  return { id: randomUUID(), prompts: [...prompts], picks: [], index: 0, status: "collecting" };
}

export function view(batch) {
  const collecting = batch.status === "collecting";
  return {
    id: batch.id,
    index: batch.index,
    total: batch.prompts.length,
    prompt: collecting ? batch.prompts[batch.index] : null,
    status: batch.status,
  };
}

// Record a click for the current step. Ignores a non-collecting batch or an index
// that isn't the one we're waiting on (stale/duplicate click guard).
export function resolve(batch, index, selection) {
  if (batch.status !== "collecting" || index !== batch.index) return batch;
  batch.picks.push({ prompt: batch.prompts[batch.index], selection });
  batch.index += 1;
  if (batch.index >= batch.prompts.length) batch.status = "done";
  return batch;
}

export function cancel(batch) {
  if (batch.status === "collecting") batch.status = "cancelled";
  return batch;
}

export function timeout(batch) {
  if (batch.status === "collecting") batch.status = "timeout";
  return batch;
}

export function result(batch) {
  return { status: batch.status, picks: batch.picks };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pick-batch.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/pick-request/batch.js test/pick-batch.test.js
git commit -m "feat: add pick-request batch state machine"
```

---

## Task 2: `server.js` — pick-server, CLI client, output formatter

**Files:**
- Create: `src/framework/pick-request/server.js`
- Test: `test/pick-server.test.js`

**Interfaces:**
- Consumes: `batch.js` (Task 1); `formatSelection` from `../selection/format.js`.
- Produces:
  - `createPickServer({ port?, timeoutMs? }) → { start() → Promise<{port}>, stop() → Promise<void> }` (binds 127.0.0.1; one active batch; `POST /request` held open until terminal; `GET /events` SSE replays current prompt then streams; `POST /resolve`; `POST /cancel`; `409 {status:"busy"}` when a batch is active).
  - `requestPicks({ port?, host?, prompts }) → Promise<{ status, picks }>` (POSTs `/request`, awaits the held response).
  - `formatPickResult({ status, picks }) → string` (human summary lines + raw JSON).

- [ ] **Step 1: Write the failing test**

```js
// test/pick-server.test.js
import { afterEach, expect, test } from "vitest";
import { createPickServer, requestPicks, formatPickResult } from "../src/framework/pick-request/server.js";

let srv;
afterEach(async () => { await srv?.stop(); srv = null; });

// Minimal SSE reader: resolves with the first event whose `event:` matches `name`.
async function nextEvent(port, name) {
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const ev = f.match(/^event: (.+)$/m)?.[1];
      const data = f.match(/^data: (.+)$/m)?.[1];
      if (ev === name) { reader.cancel(); return JSON.parse(data); }
    }
  }
}

test("binds to 127.0.0.1", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  expect(res.ok).toBe(true);
  res.body.cancel();
});

test("a two-prompt batch resolves in order and returns ordered picks", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();
  const done = requestPicks({ port, prompts: ["click A", "click B"] }); // holds open

  const p0 = await nextEvent(port, "prompt");
  expect(p0).toMatchObject({ index: 0, total: 2, prompt: "click A" });
  await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: p0.id, index: 0, selection: { subPart: "a" } }),
  });
  const p1 = await nextEvent(port, "prompt");
  expect(p1).toMatchObject({ index: 1, prompt: "click B" });
  await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: p1.id, index: 1, selection: { subPart: "b" } }),
  });

  const out = await done;
  expect(out.status).toBe("done");
  expect(out.picks.map((p) => p.prompt)).toEqual(["click A", "click B"]);
  expect(out.picks.map((p) => p.selection.subPart)).toEqual(["a", "b"]);
});

test("a second request while busy gets 409 busy", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();
  requestPicks({ port, prompts: ["click A"] }); // holds the slot open
  await nextEvent(port, "prompt");
  const res = await fetch(`http://127.0.0.1:${port}/request`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: ["other"] }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).status).toBe("busy");
});

test("server timeout returns status timeout with partial picks", async () => {
  srv = createPickServer({ port: 0, timeoutMs: 60 });
  const { port } = await srv.start();
  const out = await requestPicks({ port, prompts: ["click A", "click B"] });
  expect(out.status).toBe("timeout");
  expect(out.picks).toEqual([]);
});

test("formatPickResult prints a summary line per pick plus JSON", () => {
  const r = {
    status: "done",
    picks: [{ prompt: "click A", selection: { subPart: "spacer", point: [0,0,5.2], normal: [1,0,0], params: { bore: 3.4 } } }],
  };
  const s = formatPickResult(r);
  expect(s).toContain("click A");
  expect(s).toContain("spacer");
  expect(s).toContain('"status": "done"'); // raw JSON included
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pick-server.test.js`
Expected: FAIL — cannot resolve `server.js`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/framework/pick-request/server.js
// The Node side of request-a-pick: an http+SSE server holding one active batch,
// a blocking CLI client (requestPicks), and CLI output formatting. 127.0.0.1 only.
import { createServer, request as httpRequest } from "node:http";
import { createBatch, view, resolve, cancel, timeout, result } from "./batch.js";
import { formatSelection } from "../selection/format.js";

const json = (res, code, obj, origin) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": origin || "*" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve_) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve_(b ? JSON.parse(b) : {}));
});

export function createPickServer({ port = 4518, timeoutMs = 120000 } = {}) {
  let batch = null;        // the one active batch (or null)
  let pending = null;      // { res, timer } — the held POST /request response
  const sseClients = new Set();

  const sse = (event, data) => {
    for (const res of sseClients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = () => {                 // resolve the held /request with the result
    if (pending) {
      clearTimeout(pending.timer);
      json(pending.res, 200, result(batch));
      pending = null;
    }
    sse("cleared", {});
    batch = null;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin || "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    const url = req.url.split("?")[0];

    if (req.method === "POST" && url === "/request") {
      if (batch) return json(res, 409, { status: "busy" }, origin);
      const { prompts } = await readBody(req);
      batch = createBatch(prompts || []);
      pending = { res, timer: setTimeout(() => { timeout(batch); finish(); }, timeoutMs) };
      sse("prompt", view(batch));
      return; // held open until finish()
    }
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
        "access-control-allow-origin": origin || "*",
      });
      sseClients.add(res);
      if (batch) res.write(`event: prompt\ndata: ${JSON.stringify(view(batch))}\n\n`); // replay current
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && url === "/resolve") {
      const { id, index, selection } = await readBody(req);
      if (batch && id === batch.id) {
        resolve(batch, index, selection);
        if (view(batch).status === "collecting") sse("prompt", view(batch));
        else finish();
      }
      return json(res, 200, { ok: true }, origin);
    }
    if (req.method === "POST" && url === "/cancel") {
      const { id } = await readBody(req);
      if (batch && id === batch.id) { cancel(batch); finish(); }
      return json(res, 200, { ok: true }, origin);
    }
    return json(res, 404, { error: "not found" }, origin);
  });

  return {
    start: () => new Promise((res_) => server.listen(port, "127.0.0.1", () => res_({ port: server.address().port }))),
    stop: () => new Promise((res_) => { for (const c of sseClients) c.end(); server.close(() => res_()); }),
  };
}

// CLI client: POST the prompts and await the held response (blocks until the batch
// reaches a terminal status server-side). Fails fast with a hint if nothing answers.
export function requestPicks({ port = 4518, host = "127.0.0.1", prompts }) {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify({ prompts });
    const req = httpRequest(
      { host, port, path: "/request", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve_(JSON.parse(b))); },
    );
    req.on("error", (e) => reject(new Error(`could not reach pick-server on ${host}:${port} (is the app open and \`partforge pick-serve\` running?) — ${e.message}`)));
    req.end(payload);
  });
}

// Human-readable CLI output: one summary line per pick, then the raw JSON to parse.
export function formatPickResult({ status, picks }) {
  const lines = [`status: ${status} (${picks.length} pick${picks.length === 1 ? "" : "s"})`];
  for (const { prompt, selection } of picks) {
    lines.push(`• "${prompt}" → ${formatSelection(selection, { style: "prompt" })}`);
  }
  lines.push("", JSON.stringify({ status, picks }, null, 2));
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pick-server.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/pick-request/server.js test/pick-server.test.js
git commit -m "feat: add pick-request http/SSE server, CLI client, output formatter"
```

---

## Task 3: `bin/cli.js` — `pick-serve` and `pick` subcommands

**Files:**
- Modify: `bin/cli.js`
- Test: `test/pick-cli.test.js`

**Interfaces:**
- Consumes: `createPickServer`, `requestPicks`, `formatPickResult` from `../src/framework/pick-request/server.js`.
- Produces: CLI commands `partforge pick-serve [--port N] [--timeout S]` and `partforge pick "<prompt>" ["<prompt>" …] [--port N]`.

- [ ] **Step 1: Write the failing test**

```js
// test/pick-cli.test.js
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";

const run = (args) => execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8" });

test("`pick` with no prompts prints usage and exits non-zero", () => {
  expect(() => run(["pick"])).toThrow(); // non-zero exit
});

test("an unknown command still prints usage (dispatch intact)", () => {
  let err;
  try { run(["bogus"]); } catch (e) { err = e; }
  expect(err).toBeTruthy();
  expect(`${err.stderr}`).toMatch(/usage: partforge/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pick-cli.test.js`
Expected: FAIL — `pick` is currently rejected differently / usage text lacks the new commands; the first test may pass incidentally, the second asserts the refactored usage.

- [ ] **Step 3: Refactor arg parsing and add the subcommands**

Replace the argument-parsing preamble in `bin/cli.js`. Change:

```js
const [, , cmd, partPath, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    flags[key] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  } else positional.push(rest[i]);
}
const view = positional[0];

if (!["measure", "render"].includes(cmd)) die("usage: partforge <measure|render> <part-module> [view] [flags]");
if (!partPath) die(`usage: partforge ${cmd} <part-module> [view]`);
```

to (uniform parse over everything after the command; new commands handled before the part/kernel path):

```js
import { createPickServer, requestPicks, formatPickResult } from "../src/framework/pick-request/server.js";

const [, , cmd, ...args] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  } else positional.push(args[i]);
}

const USAGE = "usage: partforge <measure|render|pick-serve|pick> …";

// --- pick-serve / pick: no part module, no kernel boot --------------------------
if (cmd === "pick-serve") {
  const port = Number(flags.port) || 4518;
  const timeoutMs = (Number(flags.timeout) || 120) * 1000;
  const { port: bound } = await createPickServer({ port, timeoutMs }).start();
  console.log(`partforge pick-server listening on http://127.0.0.1:${bound}`);
  // keep the process alive serving requests
} else if (cmd === "pick") {
  if (positional.length === 0) die('usage: partforge pick "<prompt>" ["<prompt>" …] [--port N]');
  const port = Number(flags.port) || 4518;
  const out = await requestPicks({ port, prompts: positional }).catch((e) => die(e.message));
  console.log(formatPickResult(out));
  process.exit(out.status === "done" ? 0 : 1);
} else if (!["measure", "render"].includes(cmd)) {
  die(USAGE);
}

const partPath = positional[0];
const view = positional[1];
if (["measure", "render"].includes(cmd) && !partPath) die(`usage: partforge ${cmd} <part-module> [view]`);
```

Leave the rest of the file (kernel boot, measure/render) unchanged — it now reads `partPath`/`view` from the uniform parse, and only runs when `cmd` is `measure`/`render`. Wrap the existing kernel-boot + `try { … }` block so it executes only for measure/render (it already `die`s for other commands above, so the pick branches `process.exit`/return before reaching it — `pick-serve` intentionally falls through to keep the event loop alive only if nothing else runs; ensure the kernel boot is guarded by `if (["measure","render"].includes(cmd))` so `pick-serve` does not boot a kernel).

Concretely, guard the kernel boot:

```js
if (["measure", "render"].includes(cmd)) {
  let kernel;
  if (detectBackend(part) === "occt") {
    // … existing kernel boot + try/catch measure|render block, unchanged …
  }
}
```

(Move the existing `const mod = await import(...)` part-loading line inside this guard too, since `pick-serve`/`pick` have no part module.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pick-cli.test.js test/cli.test.js`
Expected: PASS — new pick CLI tests pass AND the existing `cli.test.js` (measure/render) still passes (no dispatch regression).

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/pick-cli.test.js
git commit -m "feat: add pick-serve and pick CLI subcommands"
```

---

## Task 4: `client.js` + `index.js` — browser client

**Files:**
- Create: `src/framework/pick-request/client.js`, `src/framework/pick-request/index.js`
- Test: `test/pick-client.test.js`, `test/pick-index.test.js`

**Interfaces:**
- Consumes: `attachPicker` from `../selection/pick.js`; the browser `EventSource`/`fetch`.
- Produces: `createPickRequestClient({ serverUrl?, viewer, part, getContext }) → { detach() }`. (Needs `part` + `getContext` because its internal `attachPicker` must turn a click into a `Selection` via `resolveSelection`.)

- [ ] **Step 1: Write the failing tests**

```js
// test/pick-client.test.js
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Stub the picker so we can drive onPick directly without a real raycast.
let captured;
vi.mock("../src/framework/selection/pick.js", () => ({
  attachPicker: (viewer, opts) => { captured = opts; return { setActive: vi.fn(), detach: vi.fn() }; },
}));

// Controllable mock EventSource.
class MockES {
  constructor(url) { this.url = url; this.listeners = {}; MockES.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}

let client;
beforeEach(() => { globalThis.EventSource = MockES; globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => ({}) })); });
afterEach(() => { client?.detach(); document.body.innerHTML = ""; captured = undefined; });

const { createPickRequestClient } = await import("../src/framework/pick-request/client.js");

test("a prompt event shows the banner with index/total and arms the picker", () => {
  client = createPickRequestClient({ serverUrl: "http://127.0.0.1:4518", viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 1, total: 3, prompt: "click the face to fillet" });
  expect(document.body.textContent).toContain("2 of 3");
  expect(document.body.textContent).toContain("click the face to fillet");
  expect(captured.onPick).toBeTypeOf("function");
});

test("a pick POSTs /resolve with the active id+index and the selection", async () => {
  client = createPickRequestClient({ serverUrl: "http://127.0.0.1:4518", viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  const selection = { subPart: "spacer" };
  captured.onPick(selection);
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:4518/resolve",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "x", index: 0, selection }) }),
  );
});

test("the cancel button POSTs /cancel for the active id", () => {
  client = createPickRequestClient({ serverUrl: "http://127.0.0.1:4518", viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  document.querySelector("#pf-pick-cancel").click();
  expect(fetch).toHaveBeenCalledWith(
    "http://127.0.0.1:4518/cancel",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "x" }) }),
  );
});

test("a cleared event hides the banner", () => {
  client = createPickRequestClient({ serverUrl: "http://127.0.0.1:4518", viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  MockES.last.emit("cleared", {});
  expect(document.querySelector("#pf-pick-banner").style.display).toBe("none");
});
```

```js
// test/pick-index.test.js
import { expect, test } from "vitest";
import * as pr from "../src/framework/pick-request/index.js";
test("re-exports the browser client", () => {
  expect(typeof pr.createPickRequestClient).toBe("function");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/pick-client.test.js test/pick-index.test.js`
Expected: FAIL — cannot resolve `client.js` / `index.js`.

- [ ] **Step 3: Write the implementation**

```js
// src/framework/pick-request/client.js
// Browser side of request-a-pick: subscribe to the pick-server, show a prompt banner,
// arm the existing picker on demand, and POST each click back. Self-created DOM.
import { attachPicker } from "../selection/pick.js";

export function createPickRequestClient({ serverUrl = "http://127.0.0.1:4518", viewer, part, getContext }) {
  let active = null; // { id, index } of the prompt we're waiting on

  const banner = document.createElement("div");
  banner.id = "pf-pick-banner";
  Object.assign(banner.style, {
    position: "fixed", left: "12px", bottom: "12px", zIndex: 9999, maxWidth: "60ch",
    font: "13px system-ui, sans-serif", padding: "8px 12px", borderRadius: "6px",
    background: "rgba(20,24,29,0.94)", color: "#e7edf5", display: "none",
  });
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.id = "pf-pick-cancel";
  cancel.textContent = "Can't find it / cancel";
  Object.assign(cancel.style, { marginLeft: "10px", font: "12px system-ui", cursor: "pointer" });
  banner.append(text, cancel);
  document.body.appendChild(banner);

  const picker = attachPicker(viewer, {
    part, getContext,
    onPick: (selection) => {
      if (!active) return;
      fetch(`${serverUrl}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: active.id, index: active.index, selection }),
      });
    },
  });

  cancel.addEventListener("click", () => {
    if (active) fetch(`${serverUrl}/cancel`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: active.id }),
    });
  });

  const es = new EventSource(`${serverUrl}/events`);
  es.addEventListener("prompt", (e) => {
    const v = JSON.parse(e.data);
    active = { id: v.id, index: v.index };
    text.textContent = `🤖 Claude needs you to click (${v.index + 1} of ${v.total}): ${v.prompt}`;
    banner.style.display = "block";
    picker.setActive(true);
  });
  es.addEventListener("cleared", () => {
    active = null;
    banner.style.display = "none";
    picker.setActive(false);
  });
  es.onerror = () => { text.textContent = "⚠ agent pick-server not reachable"; banner.style.display = "block"; };

  return {
    detach: () => { es.close(); picker.detach(); banner.remove(); },
  };
}
```

```js
// src/framework/pick-request/index.js
export { createPickRequestClient } from "./client.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/pick-client.test.js test/pick-index.test.js`
Expected: PASS (4 + 1 tests).

- [ ] **Step 5: Commit**

```bash
git add src/framework/pick-request/client.js src/framework/pick-request/index.js test/pick-client.test.js test/pick-index.test.js
git commit -m "feat: add pick-request browser client + surface"
```

---

## Task 5: `?pickserver` mount wiring

**Files:**
- Modify: `src/framework/mount.js`

**Interfaces:**
- Consumes: `createPickRequestClient` from `./pick-request/index.js`; the existing in-scope `viewer`, `part`, `view`, `params`, and `qs`.

This modifies the browser bootstrap; it is verified by `npm test` (no regressions) + `npm run build` (clean), not a unit test.

- [ ] **Step 1: Add the import**

Next to `import { attachPicker, formatSelection } from "./selection/index.js";` add:

```js
import { createPickRequestClient } from "./pick-request/index.js";
```

- [ ] **Step 2: Make `?pickserver` an alternative to `?pick`**

Find the existing `if (qs.has("pick")) { … }` block (the click-to-select toggle, around line 74). Change its opening `if` to `if (qs.has("pick")) {` → keep as-is, and append an `else if` branch after that block closes:

```js
} else if (qs.has("pickserver")) {
  // Agent-driven mode: arm the picker only when the local pick-server asks for a
  // click. Mutually exclusive with the clipboard ?pick toggle (else-if), so only one
  // click listener is ever live. `?pickserver` or `?pickserver=http://host:port`.
  const serverUrl = typeof qs.get("pickserver") === "string" && qs.get("pickserver")
    ? qs.get("pickserver") : "http://127.0.0.1:4518";
  createPickRequestClient({
    serverUrl,
    viewer,
    part,
    getContext: () => ({ view, params, derived: part.derive ? part.derive({ ...part.defaults, ...params }) : {} }),
  });
}
```

> Confirm `qs` is a `URLSearchParams` (it is — used as `qs.has("debug")`). If `viewer`/`part`/`view`/`params` are not all in scope at this point, place the `else if` where they are (the existing `?pick` block already uses all of them, so appending directly after it is in scope).

- [ ] **Step 3: Verify the suite and a clean build**

Run: `npm test`
Expected: PASS (full suite, including all new pick-request tests).

Run: `npm run build`
Expected: build completes with no errors.

(Manual, optional: `npm run dev`; in one terminal `node bin/cli.js pick-serve`; open `/demo.html?pickserver`; run `node bin/cli.js pick "click the spacer"`; confirm the banner appears, a click clears it, and the CLI prints the Selection JSON. Without `?pickserver`, confirm no banner.)

- [ ] **Step 4: Commit**

```bash
git add src/framework/mount.js
git commit -m "feat: wire ?pickserver to mount the request-pick client"
```

---

## Task 6: built-in skill + authoring docs

**Files:**
- Create: `skills/partforge/SKILL.md`
- Modify: `docs/AUTHORING-PARTS.md`, `README.md`, `package.json`

This task ships documentation; it is verified by `npm pack --dry-run` (the skill is included in the package) and a read-through for accuracy against the shipped CLI flags.

- [ ] **Step 1: Write the agent-facing skill**

Create `skills/partforge/SKILL.md`:

```markdown
---
name: partforge-request-pick
description: Use when editing a partforge part for a user who has the live app open and you need them to point at geometry — ask for one or more clicks and get the Selection(s) back.
---

# partforge: request-a-pick

When you're editing a partforge part and you're unsure *which* face, edge, hole, or
sub-part the user means, don't guess — ask them to click it in the live app. Their
click comes back to you as a structured `Selection` (sub-part, local CAD point,
surface normal, the parameters they were viewing).

## When to use

- The user's request is geometrically ambiguous ("make this thicker", "fillet that
  edge", "move the hole") and more than one feature could match.
- You need a concrete location/normal to drive an edit.

## One-time setup (per session)

Start the pick-server (it bridges the app and this CLI). The user must have the app
open with `?pickserver` (e.g. `http://localhost:5173/?pickserver`).

```bash
partforge pick-serve &     # default http://127.0.0.1:4518
```

## Requesting clicks

Ask for one or many — they're collected in order and returned together:

```bash
partforge pick "click the face you want filleted"
partforge pick "click the mounting hole" "click the top edge" "click the boss"
```

Tell the user out loud to check their browser ("I've put a prompt in your browser —
click the face you want filleted"). The command **blocks** until they click (or
timeout), then prints a summary plus JSON:

```json
{ "status": "done", "picks": [ { "prompt": "...", "selection": { "subPart": "...", "point": [...], "normal": [...], "params": {...} } } ] }
```

Picks come back **in request order**, each echoing its prompt, so you can map them.

## Handling outcomes

- `done` — proceed with the returned `selection`(s).
- `timeout` — the user didn't click in time; `picks` holds any collected so far. Ask
  again or fall back to asking in words.
- `cancelled` — the user clicked "Can't find it"; reconsider what you're asking for.
- `busy` (exit non-zero) — a request is already in flight; wait and retry.

## Notes

- This only *reads* a click — it never edits files. You make the edits yourself after.
- The server is localhost-only and holds one request at a time.
```

- [ ] **Step 2: Add the authoring-guide section**

In `docs/AUTHORING-PARTS.md`, after the section that documents `?pick` (search for `?pick`), add:

```markdown
## Interactive clarification: request-a-pick

An external tool (e.g. an AI agent editing your part) can ask the *user* to click
geometry and receive the `Selection` back, closing the loop in the other direction
from `?pick`.

- Serve your app with **`?pickserver`** (or `?pickserver=http://host:port`) to enable
  it. While idle nothing changes; when the local pick-server requests a click, a banner
  appears ("🤖 Claude needs you to click …") and the picker arms for one click.
- The agent side runs `partforge pick-serve` once, then `partforge pick "<prompt>" …`
  for one or more clicks (collected in order, returned together). The CLI blocks until
  the user clicks, then prints the `Selection`(s) as JSON.

See the bundled skill `skills/partforge/SKILL.md` for the agent workflow. This is plain
click-routing — no LLM logic lives in partforge.
```

- [ ] **Step 3: Add a README pointer**

In `README.md`, under the feature/usage area, add a bullet:

```markdown
- **Agent clarification (`request-a-pick`):** an external tool can ask the user to click
  geometry and get the `Selection` back — serve with `?pickserver`, drive with
  `partforge pick-serve` + `partforge pick "<prompt>" …`. See
  `skills/partforge/SKILL.md` and the authoring guide.
```

- [ ] **Step 4: Ship the skill in the package**

In `package.json`, add the skill to `files` so it's published:

```json
  "files": [
    "src",
    "bin",
    "skills/partforge/SKILL.md",
    "docs/AUTHORING-PARTS.md",
    "README.md"
  ],
```

- [ ] **Step 5: Verify the skill ships and docs are accurate**

Run: `npm pack --dry-run 2>&1 | grep -i "skills/partforge/SKILL.md"`
Expected: the line appears (the skill is included in the package tarball).

Read-through: confirm every command/flag in `SKILL.md` and `AUTHORING-PARTS.md`
(`pick-serve`, `pick`, `--port`, `?pickserver`, default `4518`) matches the implemented
CLI (Tasks 3, 5).

- [ ] **Step 6: Commit**

```bash
git add skills/partforge/SKILL.md docs/AUTHORING-PARTS.md README.md package.json
git commit -m "docs: add request-a-pick skill, authoring section, README pointer"
```

---

## Self-review notes

- **Spec coverage:** batch state machine w/ ordered prompts→picks + partial on cancel/timeout (Task 1) ✓; 127.0.0.1 server, held `POST /request`, SSE `prompt`/`cleared` w/ replay, `/resolve`, `/cancel`, `409 busy` (Task 2) ✓; blocking CLI printing summary+JSON + exit codes, `pick-serve` (Tasks 2,3) ✓; browser client banner+index/total, arms existing picker, cancel button, offline note (Task 4) ✓; `?pickserver` opt-in mutually exclusive with `?pick` (Task 5) ✓; built-in skill + authoring section + README + package `files` (Task 6) ✓; no new deps / no LLM logic / loopback-only / status vocabulary / port 4518 / timeout 120s (Global Constraints, enforced across tasks) ✓.
- **Out of scope (correctly absent):** concurrent batches/queue, prompt labels, auth/remote, Agent-SDK/chat-bridge, changes to the selection module.
- **Type consistency:** `batch`/`view`/`result` shapes, `{status, picks:[{prompt, selection}]}`, the `prompt`/`cleared` SSE events, and `createPickRequestClient({serverUrl, viewer, part, getContext})` are identical across batch→server→client→mount. Default port `4518` and status strings match everywhere.
- **Placeholders:** none — every code step is complete.
- **Note:** the spec's client signature was `{serverUrl, viewer}`; the plan refines it to `{serverUrl, viewer, part, getContext}` because the client's internal picker needs `part`+`getContext` to build a `Selection` (same shape `?pick` already passes to `attachPicker`).
```
