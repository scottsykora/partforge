import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { describe as describeMesh, describeMemo, DESCRIBE_ERRORS } from "../src/framework/oracle/describe.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// kernel.box/kernel.cylinder take OPTIONS OBJECTS ({min,max}/{size} and {r,h}) — see
// AGENTS.md and kernel.js's own JSDoc. The positional legacy forms are silently
// accepted by the front-end but resolve to a DIFFERENT signature (box(min,max);
// cylinder(rBottom,rTop,h)) and hand back a zero-volume solid rather than erroring.
// `kernel.cut`/`kernel.intersect` likewise do not exist as free kernel functions —
// they are Solid methods (`a.cut(b)`) — only `kernel.union` has an n-ary free form.
const plateSolid = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 12] })
    .cut(kernel.cylinder({ r: 2.65, h: 40 }).translate([30, 20, -14]));

test("a plate with a bore reports a through hole", () => {
  const r = describeMesh(kernel, plateSolid(), { name: "plate", digest: "d1" });
  expect(r.features.some((f) => f.type === "throughHole")).toBe(true);
});

test("the report explains nearly all of the surface area", () => {
  const r = describeMesh(kernel, plateSolid(), { name: "plate", digest: "d2" });
  expect(r.score.explainedArea).toBeGreaterThan(0.9);
});

test("features are numbered f0..fN in a stable order", () => {
  const a = describeMesh(kernel, plateSolid(), { digest: "d3" });
  const b = describeMesh(kernel, plateSolid(), { digest: "d4" });
  expect(a.features.map((f) => f.id)).toEqual(b.features.map((f) => f.id));
  expect(a.features[0].id).toBe("f0");
});

test("the memo returns the identical object for the same digest", () => {
  const memo = describeMemo();
  const a = describeMesh(kernel, plateSolid(), { digest: "same", memo });
  const b = describeMesh(kernel, plateSolid(), { digest: "same", memo });
  expect(b).toBe(a);
});

test("a different digest misses the memo", () => {
  const memo = describeMemo();
  const a = describeMesh(kernel, plateSolid(), { digest: "one", memo });
  const b = describeMesh(kernel, plateSolid(), { digest: "two", memo });
  expect(b).not.toBe(a);
});

test("an empty solid returns the `empty` error rather than throwing", () => {
  const empty = kernel.box({ min: [0, 0, 0], max: [1, 1, 1] })
    .cut(kernel.box({ min: [-2, -2, -2], max: [2, 2, 2] }));
  const r = describeMesh(kernel, empty, { digest: "e" });
  expect(r.error).toBe("empty");
  expect(DESCRIBE_ERRORS).toContain("empty");
});

// The whole pipeline, end to end, at an arbitrary orientation. Every stage below this
// reads normals, cross products or eigenvectors, and three separate defects in this plan
// were orientation-dependent while passing an axis-aligned suite. A rigid rotation cannot
// change what a part IS, so the feature set must be identical and the measurements must
// match to fit tolerance — only positions and directions may differ.
test("describe is invariant under rigid rotation of the input", () => {
  const flat = describeMesh(kernel, plateSolid(), { digest: "inv-a" });
  const spun = describeMesh(kernel, plateSolid().rotate(29, [0, 0, 0], [1, 2, 3]), { digest: "inv-b" });
  expect(spun.features.map((f) => f.type).sort()).toEqual(flat.features.map((f) => f.type).sort());
  // Fitted diameters, never compared with exact equality (global constraint): a
  // rotation is a floating-point transform, so the SAME 5.3mm bore re-fitted from a
  // rotated vertex set lands a few ulps off (observed: 5.299999879205153 flat vs
  // 5.300000000745992 spun, a ~1.2e-7 relative difference) — real float noise from
  // re-tessellating a rotated mesh, not a describe defect, and `toEqual`'s bit-exact
  // comparison would fail on it forever.
  const dia = (r) => r.features.filter((f) => f.type === "throughHole").map((f) => f.diameter);
  const diaFlat = dia(flat), diaSpun = dia(spun);
  expect(diaSpun.length).toBe(diaFlat.length);
  diaSpun.forEach((d, i) => expect(d).toBeCloseTo(diaFlat[i], 4));
  expect(spun.score.explainedArea).toBeCloseTo(flat.score.explainedArea, 2);
});

test("a closed-set error carries the structured diagnostic triple", () => {
  const empty = kernel.box({ min: [0, 0, 0], max: [1, 1, 1] })
    .cut(kernel.box({ min: [-2, -2, -2], max: [2, 2, 2] }));
  const d = describeMesh(kernel, empty, { name: "scan", digest: "e2" }).diagnostic;
  expect(d.cause).toBeTruthy();
  expect(d.location).toMatch(/scan/);
  expect(d.correctiveAction).toMatch(/ERROR-PATTERNS/);
});

test("the closed error set is exactly the documented five", () => {
  expect([...DESCRIBE_ERRORS].sort()).toEqual(
    ["budget-exceeded", "empty", "not-manifold", "too-large", "unreadable"]);
});
