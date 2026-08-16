import { expect, test } from "vitest";
import { createBackendPolicy, detectBackend } from "../src/framework/backend-select.js";

const view = { v: { label: "V" } };
const plain = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } } };
const fillets = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0.1) } } };
const conditional = {
  defaults: { round: 0 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => p.round > 0 ? k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(p.round) : k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } },
};

test("a part using fillet routes to occt", () => { expect(detectBackend(fillets)).toBe("occt"); });
test("a plain part routes to manifold", () => { expect(detectBackend(plain)).toBe("manifold"); });
test("meta.backend overrides detection", () => { expect(detectBackend({ ...plain, meta: { backend: "occt" } })).toBe("occt"); });
test("a conditional fillet is detected only when its param enables it", () => {
  expect(detectBackend(conditional)).toBe("manifold");
  expect(detectBackend(conditional, { round: 1 })).toBe("occt");
});

test("a part using shell routes to occt", () => {
  const shelled = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).shell({ t: 1, open: { dir: "Z" } }) } } };
  expect(detectBackend(shelled)).toBe("occt");
});

test("Shape2D.fillet does not route to OCCT (shared pure-JS implementation)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(2).extrude({ h: 3 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("Solid.fillet after a Shape2D chain still routes to OCCT", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).extrude({ h: 3 }).fillet(1) } } };
  expect(detectBackend(part)).toBe("occt");
});

test("a text2d chain (Shape2D handle) does not route to OCCT", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.text2d("Hi", { size: 10 }).chamfer(0.5).extrude({ h: 2 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("Shape2D.fillet on one sub-part does not mask Solid.fillet on another", () => {
  const part = { defaults: {}, views: view, parts: {
    a: { views: ["v"], build: (k) => k.shape2d([[0, 0], [1, 0], [1, 1]]).fillet(0.1).extrude({ h: 1 }) },
    b: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0.1) },
  } };
  expect(detectBackend(part)).toBe("occt");
});

test("label() chains on the probe kernel and does not force OCCT", () => {
  const part = {
    defaults: { a: 5 },
    parts: { p: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.a, p.a, p.a] }).label("Body") } },
    views: { v: {} },
  };
  expect(detectBackend(part)).toBe("manifold");
});

// Zero-magnitude fillet/chamfer are the identity, so an UNGUARDED `.fillet(p.r)`
// with the radius param driven to 0 must fall back to Manifold — the automatic
// backend reversion the docs promise, without requiring an `if (r > 0)` guard.
const unguarded = {
  defaults: { r: 2 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).fillet(p.r) } },
};

test("an unguarded fillet at radius 0 routes back to manifold", () => {
  expect(detectBackend(unguarded)).toBe("occt");
  expect(detectBackend(unguarded, { r: 0 })).toBe("manifold");
});

test("options-form fillet({r: 0}) and chamfer({d: 0}) route to manifold", () => {
  const f = { defaults: { r: 0 }, views: view, parts: { a: { views: ["v"], build: (k, p) =>
    k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet({ r: p.r, edges: { dir: "Z" } }) } } };
  const c = { defaults: { d: 0 }, views: view, parts: { a: { views: ["v"], build: (k, p) =>
    k.box({ min: [0, 0, 0], max: [1, 1, 1] }).chamfer({ d: p.d }) } } };
  expect(detectBackend(f)).toBe("manifold");
  expect(detectBackend(c)).toBe("manifold");
  expect(detectBackend(f, { r: 1 })).toBe("occt");
  expect(detectBackend(c, { d: 1 })).toBe("occt");
});

test("a zero-magnitude call does not mask a nonzero one elsewhere in the build", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0).chamfer(0.5) } } };
  expect(detectBackend(part)).toBe("occt");
});

test("shell is never treated as a zero no-op (t: 0 is degenerate, not identity)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.box({ min: [0, 0, 0], max: [10, 10, 10] }).shell({ t: 0, open: { dir: "Z" } }) } } };
  expect(detectBackend(part)).toBe("occt");
});

test("a non-numeric magnitude routes to occt (conservative when unprovable)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(undefined) } } };
  expect(detectBackend(part)).toBe("occt");
});

// createBackendPolicy: the runtime needs-occt backstop must not latch OCCT forever.
// It pins OCCT only for the exact params that failed on Manifold; any param change
// re-consults the probe, so removing the OCCT-only feature reverts to Manifold.
test("backend policy re-probes after needs-occt once params change", () => {
  const policy = createBackendPolicy(conditional);
  // Probe miss scenario: pretend { round: 0 } needed OCCT at runtime.
  expect(policy.backendFor({ round: 0 })).toBe("manifold");
  policy.noteNeedsOcct({ round: 0 });
  expect(policy.backendFor({ round: 0 })).toBe("occt");     // same params: stick to occt, no retry loop
  expect(policy.backendFor({ round: 1 })).toBe("occt");     // probe says occt on its own
  expect(policy.backendFor({ round: 0.0001 })).toBe("occt"); // changed params, probe decides (occt here)
  const guarded = { ...conditional };
  const p2 = createBackendPolicy(guarded);
  p2.noteNeedsOcct({ round: 2 });
  expect(p2.backendFor({ round: 0 })).toBe("manifold");     // feature off → reverts to manifold
});

test("backend policy: a forced backend wins over both latch and probe", () => {
  const policy = createBackendPolicy(conditional, { forced: "manifold" });
  policy.noteNeedsOcct({ round: 1 });
  expect(policy.backendFor({ round: 1 })).toBe("manifold");
});
