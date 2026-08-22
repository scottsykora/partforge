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

// Round 2 review's CRITICAL finding: toCandidate's polygon-profile branch used to
// project the WHOLE MESH's vertices for every prismatic candidate, so a part with
// more than one such feature built every candidate the same full-part-bbox size.
// acceptCandidates' greedy loop then took whichever one happened to win and
// silently dropped the rest — no error, no warning, just missing from
// `volumeShare` and `suggestion.steps`. These two fixtures are the regression
// cover: a base plate with one step, and with three (deliberately non-touching
// footprints — two bosses sharing so much as one coordinate merges their
// coplanar wall surfaces into one, which is a real but separate surface-graph.js
// nuance, not what this regression is testing).
const steppedTwoBox = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [15, 10, 10], max: [40, 30, 30] }));

const steppedThreeBox = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [5, 5, 10], max: [15, 15, 18] }))
    .union(kernel.box({ min: [25, 18, 10], max: [35, 26, 22] }))
    .union(kernel.box({ min: [45, 29, 10], max: [55, 37, 16] }));

const ORIENTATIONS = [
  ["axis-aligned", (s) => s],
  ["rotated", (s) => s.rotate(29, [0, 0, 0], [1, 2, 3])],
];

test.each(ORIENTATIONS)(
  "%s: a two-step part explains BOTH prismatic features, not just one", (name, orient) => {
    const r = describeMesh(kernel, orient(steppedTwoBox()), { digest: `step2-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
    expect(prismatic.length).toBe(2);
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    const explained = new Set(r.suggestion.steps.flatMap((s) => s.explains));
    for (const f of prismatic) expect(explained.has(f.id)).toBe(true);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

test.each(ORIENTATIONS)(
  "%s: a three-step part explains EVERY prismatic feature, not just one or two", (name, orient) => {
    const r = describeMesh(kernel, orient(steppedThreeBox()), { digest: `step3-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
    expect(prismatic.length).toBe(4); // the base extrusion plus all three steps
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    const explained = new Set(r.suggestion.steps.flatMap((s) => s.explains));
    for (const f of prismatic) expect(explained.has(f.id)).toBe(true);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

// Round 3 review's finding: `mergeCoFamily` (surface-graph.js) folds two coplanar
// patches into one SURFACE whenever they fit the same plane, whether or not they
// touch — deliberately, since a plane genuinely interrupted by another feature must
// stay one surface. But that means two same-height boss tops on the same plate merge
// into one cap surface with two disjoint ISLANDS, and treating the whole surface as
// one feature built a "bridging box" spanning the gap between them — 4-5x too large,
// correctly rejected by acceptCandidates for negative gain, silently dropping the
// smaller island's entire volume with no error and no warning (score.explainedVolumeFraction
// still landed above the 0.85 LOW_COVERAGE threshold, so nothing in the report flagged
// the loss either). Fixed in `detectPrismatic` (per-island splitting, via face
// adjacency, not boundary-loop count — an annulus is one island with two loops) and in
// describe.js's own candidate builder (`faceScope`, so a WALL surface that is itself
// multi-island — two different steps sharing an x or y coordinate — is also scoped to
// just the island it actually borders). Every fixture below uses NON-identical step
// sizes so two same-key features can never collide (see prismatic.js's own key, which
// now includes each island's centroid for exactly this reason).
const twoSameHeightBosses = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [5, 5, 10], max: [15, 15, 20] }))
    .union(kernel.box({ min: [30, 20, 10], max: [40, 32, 20] }));

// Control: the SAME two-boss layout, but the second boss is 1mm taller, so its cap
// does NOT merge with the first's — this already worked before the fix, and stays a
// regression guard that the fix did not change ordinary (non-merged) behaviour.
const controlOffsetBosses = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [5, 5, 10], max: [15, 15, 20] }))
    .union(kernel.box({ min: [30, 20, 10], max: [40, 32, 21] }));

const twoSameHeightPockets = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 20] })
    .cut(kernel.box({ min: [5, 5, 10], max: [15, 15, 21] }))
    .cut(kernel.box({ min: [30, 20, 10], max: [40, 32, 21] }));

// The wall-side variant found while building round 2's own regression fixture: two
// steps whose footprints share an X coordinate (both touch x=25) put both steps' own
// walls, not just their caps, on the same plane — the identical merge, one level down.
const sideWallVariant = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [5, 5, 10], max: [25, 15, 18] }))
    .union(kernel.box({ min: [25, 20, 10], max: [45, 30, 22] }));

// The base's own top face, interrupted by two boss footprints cut into it, is ONE
// connected island (you can walk from any point on the remaining top face to any
// other without crossing either hole) despite having two boundary loops — the widening
// this fix must NOT trigger. Must still yield exactly one "extrusion" feature.
const interruptedBase = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.box({ min: [5, 5, 10], max: [15, 15, 15] }))
    .union(kernel.box({ min: [30, 20, 10], max: [40, 30, 15] }));

test.each(ORIENTATIONS)(
  "%s: two same-height bosses are reported and explained as THREE features, not two", (name, orient) => {
    const r = describeMesh(kernel, orient(twoSameHeightBosses()), { digest: `sameh-boss-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
    expect(prismatic.length).toBe(3);
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    const explained = new Set(r.suggestion.steps.flatMap((s) => s.explains));
    for (const f of prismatic) expect(explained.has(f.id)).toBe(true);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

test.each(ORIENTATIONS)(
  "%s: control — a 1mm height offset already reported three features before this fix", (name, orient) => {
    const r = describeMesh(kernel, orient(controlOffsetBosses()), { digest: `control-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
    expect(prismatic.length).toBe(3);
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

test.each(ORIENTATIONS)(
  "%s: two same-height pockets are reported and explained as THREE features, not two", (name, orient) => {
    const r = describeMesh(kernel, orient(twoSameHeightPockets()), { digest: `sameh-pocket-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "pocket");
    expect(prismatic.length).toBe(3);
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    const explained = new Set(r.suggestion.steps.flatMap((s) => s.explains));
    for (const f of prismatic) expect(explained.has(f.id)).toBe(true);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

test.each(ORIENTATIONS)(
  "%s: two steps sharing an x coordinate (merged WALLS, not just caps) still explain fully", (name, orient) => {
    const r = describeMesh(kernel, orient(sideWallVariant()), { digest: `sidewall-${name}` });
    expect(r.error).toBeUndefined();
    const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
    expect(prismatic.length).toBe(3);
    for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

test.each(ORIENTATIONS)(
  "%s: an interrupted base plane still yields exactly ONE extrusion, not a split one", (name, orient) => {
    const r = describeMesh(kernel, orient(interruptedBase()), { digest: `interrupted-${name}` });
    expect(r.error).toBeUndefined();
    expect(r.features.filter((f) => f.type === "extrusion").length).toBe(1);
    expect(r.features.filter((f) => f.type === "boss").length).toBe(2);
    expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
  });

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
