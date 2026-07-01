// test/pick-server.test.js
import { afterEach, expect, test } from "vitest";
import { createServer, request as httpRequest } from "node:http";
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

test("malformed JSON body returns 400 and server stays alive", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();
  // Send a malformed body — should get 400, not a crash
  const bad = await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid JSON");
  // Server must still handle a subsequent valid request
  const ok = await fetch(`http://127.0.0.1:${port}/events`);
  expect(ok.ok).toBe(true);
  ok.body.cancel();
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

// Fix #1: formatPickResult with missing picks (e.g. 409 busy response)
test("formatPickResult does not throw and shows busy when picks is undefined", () => {
  let s;
  expect(() => { s = formatPickResult({ status: "busy" }); }).not.toThrow();
  expect(s).toContain("busy");
});

// Fix #2: requestPicks rejects with friendly message on non-JSON response
test("requestPicks rejects with pick-server message on non-JSON response", async () => {
  const stub = createServer((_req, res) => { res.writeHead(200); res.end("not json"); });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address();
  try {
    await expect(requestPicks({ port, host: "127.0.0.1", prompts: ["x"] })).rejects.toThrow("pick-server");
  } finally {
    await new Promise((r) => stub.close(r));
  }
});

// Fix #3: empty prompts returns 400 and does not wedge the batch slot
test("POST /request with empty prompts array returns 400 and slot is not wedged", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();

  const bad = await fetch(`http://127.0.0.1:${port}/request`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: [] }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("non-empty");

  // Slot should not be wedged — a valid follow-up request should work
  const validDone = requestPicks({ port, prompts: ["click A"] });
  const p0 = await nextEvent(port, "prompt");
  await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: p0.id, index: 0, selection: { subPart: "ok" } }),
  });
  const out = await validDone;
  expect(out.status).toBe("done");
});

test("POST /request with non-array prompts returns 400", async () => {
  srv = createPickServer({ port: 0 });
  const { port } = await srv.start();
  const bad = await fetch(`http://127.0.0.1:${port}/request`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: "click A" }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain("non-empty");
});

// Fix #6: a Ctrl-C'd CLI client (dropped /request socket) must cancel the batch and
// free the slot immediately — not leave every new request 409-busy until timeoutMs.
test("client disconnect mid-batch cancels the batch and frees the slot", async () => {
  srv = createPickServer({ port: 0 }); // default 120 s timeout — a wedge would outlive the test
  const { port } = await srv.start();

  // Open /request by hand so we can drop the socket like a Ctrl-C'd CLI.
  const req = httpRequest({ host: "127.0.0.1", port, path: "/request", method: "POST",
                            headers: { "content-type": "application/json" } });
  req.on("error", () => {}); // destroy() surfaces ECONNRESET locally — expected
  req.end(JSON.stringify({ prompts: ["click A"] }));
  await nextEvent(port, "prompt"); // batch is active server-side
  req.destroy();
  await new Promise((r) => setTimeout(r, 100)); // let the server observe the close

  // The slot must be free: a follow-up batch runs to completion instead of 409 busy.
  const done = requestPicks({ port, prompts: ["click B"] });
  const p = await nextEvent(port, "prompt");
  expect(p.prompt).toBe("click B"); // a wedged server replays the dead batch's "click A"
  await fetch(`http://127.0.0.1:${port}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: p.id, index: 0, selection: { subPart: "ok" } }),
  });
  const out = await done;
  expect(out.status).toBe("done");
});

// Fix #5: formatPickResult with malformed selection (missing point/normal/params)
test("formatPickResult does not throw and includes subPart for malformed selection", () => {
  const r = { status: "done", picks: [{ prompt: "p", selection: { subPart: "spacer" } }] };
  let s;
  expect(() => { s = formatPickResult(r); }).not.toThrow();
  expect(s).toContain("spacer");
});
