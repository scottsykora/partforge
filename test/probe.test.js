import { expect, test } from "vitest";
import { createBackendPolicy, detectBackend } from "../src/framework/backend-select.js";

const view = { v: { label: "V" } };
const plain = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } } };
const shellOn = (k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }).shell({ t: 1, open: { dir: "Z" } });
const shelled = { defaults: {}, views: view, parts: { a: { views: ["v"], build: shellOn } } };
const conditional = {
  defaults: { hollow: 0 }, views: view,
  parts: { a: { views: ["v"], build: (k, p) => p.hollow > 0 ? shellOn(k) : k.box({ min: [0, 0, 0], max: [1, 1, 1] }) } },
};

// fillet/chamfer are implemented natively on the mesh backend (mesh-fillet.js),
// so the probe no longer routes them anywhere — at ANY magnitude. Only edge
// classes the mesh backend can't blend reroute, at runtime, via the NEEDS_OCCT
// latch (exercised further down). `shell` remains probe-routed.
test("a part using fillet stays on manifold", () => {
  const fillets = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).fillet(0.1) } } };
  expect(detectBackend(fillets)).toBe("manifold");
});
test("a part using chamfer stays on manifold", () => {
  const c = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).chamfer({ d: 0.2 }) } } };
  expect(detectBackend(c)).toBe("manifold");
});
test("a plain part routes to manifold", () => { expect(detectBackend(plain)).toBe("manifold"); });
test("meta.backend overrides detection", () => { expect(detectBackend({ ...plain, meta: { backend: "occt" } })).toBe("occt"); });

test("a part using shell routes to occt", () => { expect(detectBackend(shelled)).toBe("occt"); });

test("a conditional shell is detected only when its param enables it", () => {
  expect(detectBackend(conditional)).toBe("manifold");
  expect(detectBackend(conditional, { hollow: 1 })).toBe("occt");
});

test("Shape2D.fillet does not route to OCCT (shared pure-JS implementation)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.shape2d([[0, 0], [10, 0], [10, 10], [0, 10]]).fillet(2).extrude({ h: 3 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("a text2d chain (Shape2D handle) does not route to OCCT", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.text2d("Hi", { size: 10 }).chamfer(0.5).extrude({ h: 2 }) } } };
  expect(detectBackend(part)).toBe("manifold");
});

test("label() chains on the probe kernel and does not force OCCT", () => {
  const part = {
    defaults: { a: 5 },
    parts: { p: { views: ["v"], build: (k, p) => k.box({ min: [0, 0, 0], max: [p.a, p.a, p.a] }).label("Body") } },
    views: { v: {} },
  };
  expect(detectBackend(part)).toBe("manifold");
});

test("shell is never treated as a zero no-op (t: 0 is degenerate, not identity)", () => {
  const part = { defaults: {}, views: view, parts: { a: { views: ["v"], build: (k) =>
    k.box({ min: [0, 0, 0], max: [10, 10, 10] }).shell({ t: 0, open: { dir: "Z" } }) } } };
  expect(detectBackend(part)).toBe("occt");
});

// createBackendPolicy: the runtime needs-occt backstop must not latch OCCT forever.
// It pins OCCT only for the exact params that failed on Manifold; any param change
// re-consults the probe, so removing the OCCT-only feature reverts to Manifold.
// This latch is also how an unsupported FILLET edge class (helical edge, …) lands
// on OCCT now that the probe no longer routes fillet statically.
test("backend policy re-probes after needs-occt once params change", () => {
  const policy = createBackendPolicy(conditional);
  // Probe miss scenario: pretend { hollow: 0 } needed OCCT at runtime.
  expect(policy.backendFor({ hollow: 0 })).toBe("manifold");
  policy.noteNeedsOcct({ hollow: 0 });
  expect(policy.backendFor({ hollow: 0 })).toBe("occt");     // same params: stick to occt, no retry loop
  expect(policy.backendFor({ hollow: 1 })).toBe("occt");     // probe says occt on its own
  expect(policy.backendFor({ hollow: 0.0001 })).toBe("occt"); // changed params, probe decides (occt here)
  const p2 = createBackendPolicy(conditional);
  p2.noteNeedsOcct({ hollow: 2 });
  expect(p2.backendFor({ hollow: 0 })).toBe("manifold");     // feature off → reverts to manifold
});

test("backend policy: a forced backend wins over both latch and probe", () => {
  const policy = createBackendPolicy(conditional, { forced: "manifold" });
  policy.noteNeedsOcct({ hollow: 1 });
  expect(policy.backendFor({ hollow: 1 })).toBe("manifold");
});

// --- per-sub-part routing ---------------------------------------------------
// detectBackends maps each sub-part to its own backend, so a mixed part previews
// its plain sub-parts on fast Manifold while only the shelled ones pay for OCCT.
import { detectBackends } from "../src/framework/backend-select.js";

const mixed = {
  defaults: { t: 1 }, views: view,
  parts: {
    body: { views: ["v"], build: (k, p) => p.t > 0
      ? k.box({ min: [0, 0, 0], max: [20, 20, 10] }).shell({ t: p.t, open: { dir: "Z" } })
      : k.box({ min: [0, 0, 0], max: [20, 20, 10] }) },
    lid:  { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [20, 20, 2] }) },
  },
};

test("detectBackends routes each sub-part independently", () => {
  expect(detectBackends(mixed)).toEqual({ body: "occt", lid: "manifold" });
});

test("detectBackends follows live params per sub-part (shell dialed off)", () => {
  expect(detectBackends(mixed, { t: 0 })).toEqual({ body: "manifold", lid: "manifold" });
});

test("meta.backend forces every sub-part", () => {
  expect(detectBackends({ ...mixed, meta: { backend: "occt" } })).toEqual({ body: "occt", lid: "occt" });
});

test("detectBackend agrees with the max over detectBackends (export routing)", () => {
  expect(detectBackend(mixed)).toBe("occt");
  expect(detectBackend(mixed, { t: 0 })).toBe("manifold");
});

test("policy.backendsFor applies the needs-occt latch per sub-part", () => {
  const policy = createBackendPolicy(mixed, { forced: null });
  expect(policy.backendsFor({ t: 0 })).toEqual({ body: "manifold", lid: "manifold" });
  policy.noteNeedsOcct({ t: 0 }, ["body"]); // runtime says body needed OCCT at t: 0
  expect(policy.backendsFor({ t: 0 })).toEqual({ body: "occt", lid: "manifold" });
  expect(policy.backendsFor({ t: 0.5 })).toEqual({ body: "occt", lid: "manifold" }); // probe's own call
  policy.noteNeedsOcct({ t: 0.5 }, ["lid"]);
  expect(policy.backendsFor({ t: 0.5 })).toEqual({ body: "occt", lid: "occt" });
  // Single-snapshot latch: the newer one replaces the older, so t:0 falls back to
  // the probe (body retries Manifold; if it still needs OCCT the backstop simply
  // re-latches — one cheap failed dispatch, self-correcting).
  expect(policy.backendsFor({ t: 0 })).toEqual({ body: "manifold", lid: "manifold" });
});

test("noteNeedsOcct without subparts latches the whole part (export fallback)", () => {
  const policy = createBackendPolicy(mixed);
  policy.noteNeedsOcct({ t: 0 });
  expect(policy.backendsFor({ t: 0 })).toEqual({ body: "occt", lid: "occt" });
  expect(policy.backendFor({ t: 0 })).toBe("occt");
  expect(policy.backendsFor({ t: 2 })).toEqual({ body: "occt", lid: "manifold" }); // params moved on → probe decides
});

test("policy.backendFor is the max over backendsFor, latch included", () => {
  const policy = createBackendPolicy(mixed);
  expect(policy.backendFor({ t: 0 })).toBe("manifold");
  policy.noteNeedsOcct({ t: 0 }, ["lid"]);
  expect(policy.backendFor({ t: 0 })).toBe("occt");
});
