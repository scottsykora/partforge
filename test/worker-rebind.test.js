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

// Same shape as partA, but every build() invocation is counted. A build that never
// ran is the only direct evidence that a job was skipped rather than started and
// then aborted — the posted messages alone cannot tell those two apart.
function countedPart({ rb = 1 } = {}) {
  const stats = { a: 0, b: 0, get total() { return this.a + this.b; } };
  const part = { defaults: {}, views: { main: { label: "Main" } }, parts: {
    a: { views: ["main"], build: (k) => { stats.a++; return k.cylinder({ r: 5, h: 10 }).cut(k.cylinder({ r: 2, h: 12 })); } },
    b: { views: ["main"], build: (k) => { stats.b++; return k.cylinder({ r: 3, h: 6 }).cut(k.cylinder({ r: rb, h: 8 })); } },
  } };
  return { part, stats };
}

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
    const { part, stats } = countedPart();
    runWorker(part);
    await waitFor("ready");
    send(generate); send(generate); send(generate); // same sync tick: all queue
    await waitFor("meshes");
    // Job 1 was already dequeued and running when jobs 2 and 3 arrived, so it
    // stops at its sub-part boundary — that is Task 3's isStale, and it costs one
    // build of sub-part a and posts one "superseded". Job 2, still in the queue,
    // must be dropped by the queue's stale check BEFORE it starts: silently, with
    // no build and no post. Job 3 then builds both sub-parts.
    // Without that skip job 2 would start, build sub-part a, and abort at the same
    // boundary — a second "superseded" and a third build of a. Both counts pin it.
    expect(posts.filter((m) => m.type === "superseded")).toHaveLength(1);
    expect(posts.filter((m) => m.type === "meshes")).toHaveLength(1);
    expect(stats.a).toBe(2);
    expect(stats.total).toBe(3);
  });

  it("setPart cancels a generate already in flight — it never posts meshes", async () => {
    // The cancellation half of the rebind contract: without setPart's epoch bump the
    // in-flight build runs the OLD part to completion and posts its meshes, and the
    // host would render geometry for a part it no longer has mounted.
    const { part, stats } = countedPart();
    const { part: other } = countedPart({ rb: 2 });
    const handle = runWorker(part);
    await waitFor("ready");
    send(generate);
    // Land the rebind inside the generate's between-sub-parts yield. Deterministic,
    // not a race: this timer is registered now, while jobs.js only schedules its own
    // 0 ms yield after sub-part a builds — which happens later, once the pump's
    // microtasks drain (nothing on that path awaits a timer). Same-delay timers fire
    // in registration order, so setPart runs first, and the resumed job sees the
    // bumped epoch at its boundary check.
    setTimeout(() => handle.setPart(other), 0);
    // Wait for whichever outcome the job reaches — an uncancelled build posts
    // meshes, so this fails in milliseconds rather than timing out.
    await vi.waitFor(() => {
      expect(posts.some((m) => m.type === "superseded" || m.type === "meshes")).toBe(true);
    }, { timeout: 30_000 });
    expect(posts.filter((m) => m.type === "superseded")).toHaveLength(1);
    expect(posts.filter((m) => m.type === "meshes")).toHaveLength(0);
    expect(stats.a).toBe(1); // sub-part a had already been built when the rebind landed
    expect(stats.b).toBe(0); // ...and b never was — the build stopped at the boundary
  });

  it("setPart re-posts ready", async () => {
    const handle = runWorker(partA);
    await waitFor("ready");
    handle.setPart(partA2);
    expect(posts.filter((m) => m.type === "ready")).toHaveLength(2);
  });
});
