import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runWorker } from "../src/framework/worker.js";

let posts;
beforeEach(() => {
  posts = [];
  // navigator is part of the real WorkerGlobalScope; paper-core (pulled in by the
  // manifold backend) reads self.navigator.userAgent at import time and throws
  // without it — same stub shape as test/lint-worker.test.js.
  vi.stubGlobal("self", { name: "manifold", navigator: { userAgent: "node" }, onmessage: null });
  vi.stubGlobal("postMessage", (m) => posts.push(m));
});
afterEach(() => vi.unstubAllGlobals());

const send = (data) => self.onmessage({ data });
const waitFor = (type, from = 0) =>
  vi.waitFor(() => {
    const i = posts.findIndex((m, idx) => idx >= from && m.type === type);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
  }, { timeout: 30_000 });

// Two-sub-part fixtures; A2 changes only sub-part b, so a's ops must hit.
// Each build ends in a boundary op (cut) — primitives are not cached, only
// boundary ops route through the solid cache (see solid-cache.js).
const partA = { defaults: {}, views: { main: { label: "Main" } }, parts: {
  a: { views: ["main"], build: (k) => k.cylinder({ r: 5, h: 10 }).cut(k.cylinder({ r: 2, h: 12 })) },
  b: { views: ["main"], build: (k) => k.cylinder({ r: 3, h: 6 }).cut(k.cylinder({ r: 1, h: 8 })) },
} };
const partA2 = { defaults: {}, views: { main: { label: "Main" } }, parts: {
  a: { views: ["main"], build: (k) => k.cylinder({ r: 5, h: 10 }).cut(k.cylinder({ r: 2, h: 12 })) }, // identical to partA.a
  b: { views: ["main"], build: (k) => k.cylinder({ r: 4, h: 6 }).cut(k.cylinder({ r: 1, h: 8 })) },   // differs
} };
const generate = { type: "generate", subparts: ["a", "b"], view: "main", params: {} };

describe("runWorker rebind contract", () => {
  it("setPart keeps the solid cache warm: unchanged ops hit on the next build", async () => {
    const handle = runWorker(partA);
    await waitFor("ready");
    send(generate);
    const first = await waitFor("meshes");
    handle.setPart(partA2);
    send(generate);
    const second = await waitFor("meshes", first + 1);
    const stats = posts[second].cache;
    expect(stats.hits).toBeGreaterThan(0);   // sub-part a reused
    expect(stats.misses).toBeGreaterThan(0); // sub-part b rebuilt
  });

  it("a queued generate superseded before it starts never builds", async () => {
    runWorker(partA);
    await waitFor("ready");
    send(generate); send(generate); send(generate); // same sync tick: all queue
    await waitFor("meshes");
    await new Promise((r) => setTimeout(r, 50));    // let any extra (wrong) builds land
    expect(posts.filter((m) => m.type === "meshes")).toHaveLength(1);
  });

  it("setPart re-posts ready", async () => {
    const handle = runWorker(partA);
    await waitFor("ready");
    handle.setPart(partA2);
    expect(posts.filter((m) => m.type === "ready")).toHaveLength(2);
  });
});
