// The worker lint job. The point of this job is that it answers WITHOUT booting a
// kernel: handle() in jobs.js takes an already-booted kernel and worker.js awaits
// that boot before calling it, so lint must be intercepted ahead of both.
import { expect, test, vi } from "vitest";

const goodPart = () => ({
  meta: { title: "T" },
  defaults: { h: 10 },
  parts: { body: { views: ["main"], build: (k, p) => k.box({ size: [p.h, p.h, p.h] }) } },
  views: { main: { label: "Main" } },
});

// Install a fake WorkerGlobalScope, import runWorker, and return the captured hooks.
async function bootWorker(part) {
  const posted = [];
  const self = {
    name: "occt", // the expensive backend: proves lint never triggers its boot
    navigator: { userAgent: "node" },
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal("self", self);
  vi.stubGlobal("postMessage", self.postMessage);
  const { runWorker } = await import("../src/framework/worker.js");
  runWorker(part);
  return { self, posted };
}

test("a lint message is answered with a lint-report", async () => {
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report");
  expect(report).toBeDefined();
  expect(report.report.ok).toBe(true);
  expect(report.report.errors).toEqual([]);
});

test("the lint report carries findings for a broken part", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => k.box({ sizes: [p.h, p.h, p.h] });
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.ok).toBe(false);
  expect(report.errors.map((f) => f.rule)).toContain("invalid-op-options");
});

test("params are forwarded to lintPart", async () => {
  const part = goodPart();
  part.parts.body.build = (k, p) => {
    if (p.mode === "explode") throw new Error("exploded");
    return k.box({ size: [1, 1, 1] });
  };
  part.defaults = { mode: "ok" };
  const { self, posted } = await bootWorker(part);
  await self.onmessage({ data: { type: "lint", params: { mode: "explode" } } });
  const report = posted.find((m) => m.type === "lint-report").report;
  expect(report.errors.map((f) => f.rule)).toContain("build-throws");
});

test("lint does not boot the OCCT kernel", async () => {
  // A cold OCCT boot posts { type: "progress", phase: "loading exact kernel" }
  // before it starts. Its absence is the evidence that no boot was attempted.
  const { self, posted } = await bootWorker(goodPart());
  await self.onmessage({ data: { type: "lint" } });
  expect(posted.find((m) => m.type === "progress" && /exact kernel/.test(m.phase ?? ""))).toBeUndefined();
});

// --- the vector rules, and the two properties that gate how they are fed ------
//
// vector-size-missing and vector-unknown-shape need the part's parsed vector
// files, which the worker did not pass at all: both could only ever fire from
// the CLI, never in the hosted browser sandbox they were designed for. The
// worker now supplies them — but ONLY from bytes that are already resolved, and
// without ever initiating a fetch, because lint is instant and offline by
// construction and must stay that way.
const artworkDoc = () => new TextEncoder().encode(JSON.stringify({
  format: "partforge-vector", version: 1, units: "artwork",
  shapes: { artwork: [{ outer: { kind: "rect", center: [0, 0], width: 10, height: 10 } }] },
}));

const vectorPart = (build, source = artworkDoc()) => ({
  meta: { title: "T" },
  defaults: {},
  vectors: { badge: source },
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
});

const rulesOf = (posted) => {
  const r = posted.find((m) => m.type === "lint-report").report;
  return [...r.errors, ...r.warnings].map((f) => f.rule);
};

test("the units-aware rule fires once the vector is resolved, and not before", async () => {
  const part = vectorPart((k) => k.vector2d("badge").extrude({ h: 1 }));
  const { self, posted } = await bootWorker(part);

  // Before anything resolved these bytes, lint has no document and stays silent
  // — the designed degradation, and the evidence that lint did not go fetch one.
  self.onmessage({ data: { type: "lint" } });
  expect(rulesOf(posted)).not.toContain("vector-size-missing");

  // A build (or any resolve) puts the bytes in the shared memo; now it fires.
  const { resolveVectors } = await import("../src/framework/vectors.js");
  await resolveVectors(part.vectors);
  posted.length = 0;
  self.onmessage({ data: { type: "lint" } });
  expect(rulesOf(posted)).toContain("vector-size-missing");
});

test("the unknown-shape rule fires once the vector is resolved", async () => {
  const part = vectorPart((k) => k.vector2d("badge", { width: 10, shape: "rim" }).extrude({ h: 1 }));
  const { self, posted } = await bootWorker(part);
  const { resolveVectors } = await import("../src/framework/vectors.js");
  await resolveVectors(part.vectors);
  self.onmessage({ data: { type: "lint" } });
  expect(rulesOf(posted)).toContain("vector-unknown-shape");
});

// The handler is SYNCHRONOUS on purpose: it posts before onmessage returns. That
// is what makes the reply un-hangable and keeps replies in the order they were
// asked for, so a lint-report needs no correlation id. Every assertion below
// deliberately omits `await` on the dispatch — awaiting would hide a regression.
test("a lint reply is posted synchronously, before onmessage returns", () => {
  const part = vectorPart((k) => k.vector2d("badge", { width: 10 }).extrude({ h: 1 }));
  return bootWorker(part).then(({ self, posted }) => {
    self.onmessage({ data: { type: "lint" } });
    expect(posted.find((m) => m.type === "lint-report")).toBeDefined();
  });
});

test("a vector source that never resolves does not stall the reply", async () => {
  // A thunk that never settles stands in for a hanging URL — asset-resolve.js's
  // fetch has no timeout, so awaiting one here would wait forever.
  const { self, posted } = await bootWorker(
    vectorPart((k) => k.vector2d("badge", { width: 10 }).extrude({ h: 1 }), () => new Promise(() => {})));
  self.onmessage({ data: { type: "lint" } });
  expect(posted.find((m) => m.type === "lint-report").report.ok).toBe(true);
});

// A hostile `vectors` must mean "no documents" — the same report lintPart alone
// produces (ok, with an internal-rule-error warning) — NOT a worker-level bailout
// that declares an otherwise-fine part unlintable.
test("a throwing `vectors` getter still produces the same report lintPart would", async () => {
  const part = vectorPart((k) => k.box({ size: [1, 1, 1] }));
  Object.defineProperty(part, "vectors", { get() { throw new Error("hostile getter"); }, configurable: true });
  const { self, posted } = await bootWorker(part);
  self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report")?.report;
  expect(report).toBeDefined();
  expect(report.ok).toBe(true);
  expect(report.errors.map((f) => f.rule)).not.toContain("lint-context-error");
});

test("a `vectors` Proxy whose ownKeys trap throws still produces the same report", async () => {
  const part = vectorPart((k) => k.box({ size: [1, 1, 1] }));
  part.vectors = new Proxy({}, { ownKeys() { throw new Error("hostile ownKeys"); } });
  const { self, posted } = await bootWorker(part);
  self.onmessage({ data: { type: "lint" } });
  const report = posted.find((m) => m.type === "lint-report")?.report;
  expect(report).toBeDefined();
  expect(report.ok).toBe(true);
  expect(report.errors.map((f) => f.rule)).not.toContain("lint-context-error");
});

test("a part with no vectors at all still lints, and still boots no kernel", async () => {
  const { self, posted } = await bootWorker(goodPart());
  self.onmessage({ data: { type: "lint" } });
  expect(posted.find((m) => m.type === "lint-report").report.ok).toBe(true);
  expect(posted.find((m) => m.type === "progress" && /exact kernel/.test(m.phase ?? ""))).toBeUndefined();
});
