import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { describe as describeMesh, describeMemo, DESCRIBE_ERRORS } from "../src/framework/oracle/describe.js";
import { compactDescribe } from "../src/framework/oracle/describe/report.js";

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

// --- fix round 2, IMPORTANT 2: volumeShareReason distinguishes null-share cases ---
//
// A washer (outer cylinder, bored, with its own rounded rim — the SAME solid
// test/describe-job.test.js's fixture STL encodes, built directly here since
// describe() takes a live Solid): three feature types in one part, one per reason.
const washerSolid = () =>
  kernel.cylinder({ r: 10, h: 3 }).cut(kernel.cylinder({ r: 4, h: 9 }).translate([0, 0, -3]));

test("a starved budget marks the un-reached candidate `budget`, not `rejected`", () => {
  const r = describeMesh(kernel, washerSolid(), { digest: "washer-tight", budget: 1 });
  expect(r.warning).toBe("budget-exceeded");
  const hole = r.features.find((f) => f.type === "throughHole");
  expect(hole.volumeShare).toBeNull();
  expect(hole.volumeShareReason).toBe("budget");
});

test("a generous budget resolves the SAME feature to a real share — `budget` really " +
     "meant starved, not permanently unreconstructable", () => {
  const r = describeMesh(kernel, washerSolid(), { digest: "washer-wide", budget: 100 });
  expect(r.warning).toBeUndefined();
  const hole = r.features.find((f) => f.type === "throughHole");
  expect(hole.volumeShare).toBeGreaterThan(0);
  expect(hole.volumeShareReason).toBeNull();
});

test("a feature type toCandidate never proposes reports `not-proposed`, at ANY budget", () => {
  for (const budget of [1, 100]) {
    const r = describeMesh(kernel, washerSolid(), { digest: `washer-np-${budget}`, budget });
    const revolve = r.features.find((f) => f.type === "revolve");
    expect(revolve.volumeShare).toBeNull();
    expect(revolve.volumeShareReason).toBe("not-proposed");
  }
});

test("a candidate that IS proposed, reached, and evaluated — but never wins — reports " +
     "`rejected`, distinct from both `budget` and `not-proposed`", () => {
  // A 300x300x50mm block with a 3mm-diameter through-hole: the hole's own volume
  // (~353mm3) sits well under accept.js's MIN_GAIN_FRACTION threshold (1e-4 of the
  // ~4.5M mm3 block), so its candidate is built and evaluated (only 2 candidates
  // total; the default budget is nowhere close to exhausted) but never the best of a
  // round.
  const tinyHoleInBigBlock = kernel.box({ min: [0, 0, 0], max: [300, 300, 50] })
    .cut(kernel.cylinder({ r: 1.5, h: 60 }).translate([150, 150, -5]));
  const r = describeMesh(kernel, tinyHoleInBigBlock, { digest: "rejected-fixture" });
  expect(r.warning).toBeUndefined(); // not a budget story
  const hole = r.features.find((f) => f.type === "throughHole");
  expect(hole.volumeShare).toBeNull();
  expect(hole.volumeShareReason).toBe("rejected");
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

// Round 4 review's IMPORTANT finding: prismatic.js's `faceScope` — internal plumbing
// for THIS file's own candidate builder, a feature's floor/wall surfaces reduced to
// per-triangle index arrays — was spreading straight into `report.features` on every
// prismatic feature, uncapped and unstripped by either `buildReport` or
// `compactDescribe`. Measured on a 476-triangle box-plus-cylindrical-boss part: ONE
// feature's `faceScope` was 1465 of the compact report's 4430 characters (33%) —
// exactly the bulk `compactDescribe`'s whole job is to elide, smuggled through instead
// of capped. `describe.js` now strips `faceScope` at its only egress point (building
// `report.features`), so `candidates`, built from the pre-strip array, still gets it.
const boxPlusCylBoss = () =>
  kernel.box({ min: [0, 0, 0], max: [60, 40, 10] })
    .union(kernel.cylinder({ r: 12, h: 20 }).translate([30, 20, 10]));

// A per-triangle index array reads as a long array of small non-negative integers —
// nothing legitimate in a report is that shape: bounds/axes/centroids are 3 numbers,
// pitches and counts are a handful. 50 is comfortably above every genuine array this
// report ever emits and comfortably below what even a modest mesh's own face list is.
const RAW_INDEX_ARRAY_BOUND = 50;
function findRawIndexArrays(value, path, out) {
  if (Array.isArray(value)) {
    if (value.length > RAW_INDEX_ARRAY_BOUND && value.every((v) => Number.isInteger(v) && v >= 0)) {
      out.push({ path, length: value.length });
    }
    value.forEach((v, i) => findRawIndexArrays(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) findRawIndexArrays(v, `${path}.${k}`, out);
  }
}

test("the compact report carries no per-triangle index arrays", () => {
  const r = describeMesh(kernel, boxPlusCylBoss(), { digest: "leak-check" });
  const compact = compactDescribe(r);
  const offenders = [];
  findRawIndexArrays(compact, "compact", offenders);
  expect(offenders, JSON.stringify(offenders)).toEqual([]);
  // Not present at all, not just short — `faceScope` specifically must never reach
  // a feature a model reads.
  for (const f of compact.features) expect("faceScope" in f).toBe(false);
});

test("stripping faceScope from the report does not starve the candidate builder", () => {
  const r = describeMesh(kernel, boxPlusCylBoss(), { digest: "leak-check-2" });
  const prismatic = r.features.filter((f) => f.type === "extrusion" || f.type === "boss");
  expect(prismatic.length).toBe(2);
  for (const f of prismatic) expect(f.volumeShare).toBeGreaterThan(0);
  expect(r.score.explainedVolumeFraction).toBeGreaterThan(0.99);
});

// A concrete ceiling, not just "no huge arrays": a future leak of a DIFFERENT shape
// (not a bare index array — e.g. an object per triangle) would slip past
// `findRawIndexArrays` above but would still show up here as a number. Picked well
// above the current ~2900 chars (headroom for legitimate report growth) and well
// below the ~4430 chars this exact fixture measured before the fix.
test("the compact report for a known fixture stays within its size budget", () => {
  const r = describeMesh(kernel, boxPlusCylBoss(), { digest: "leak-check-3" });
  const json = JSON.stringify(compactDescribe(r));
  expect(json.length).toBeLessThan(3500);
});

// --- fix round 3, IMPORTANT 2: a genuine mirror plane must not disappear at 45deg ---
//
// patterns.js's canonicalPlane picked its sign-defining normal component with a bare
// `>`; when a plane's normal has two components equal in magnitude — exactly the case
// at a 45deg rotation — two independently-computed proposing pairs for the SAME plane
// can disagree on which component is "larger" purely from float noise, canonicalizing
// to opposite-sign normals that then bucket separately and each fail
// SYMMETRY_EVIDENCE_MIN alone. This needs REAL, independent noise across proposers to
// reproduce — a synthetic fixture built from one shared rotation function never
// disagrees with itself (every proposer's normal comes out bit-identical) — so this
// builds an actual plate through the Manifold kernel and runs the whole describeMesh()
// pipeline, the same path measure/verify report through. Traced directly: at this
// exact rotation, two proposing pairs for the SAME plane come out normal
// (0.7071067699044177, -0.7071067924686772, 0) and (0.7071067824204295,
// -0.7071067799526655, 0) — about 2.5e-8 apart on the component that decides the sign
// flip, comfortably clearing a too-small epsilon (an earlier draft of this fix tried
// a bare `1e-9`, which still let this exact pair flip) but well inside the
// TOL_FRAC-based margin the shipped fix uses.
const holeGridPlate = (angleDeg) => {
  let s = kernel.box({ min: [0, 0, 0], max: [60, 40, 12] });
  for (const [x, y] of [[15, 10], [45, 10], [15, 30], [45, 30]]) {
    s = s.cut(kernel.cylinder({ r: 3, h: 40 }).translate([x, y, -14]));
  }
  return angleDeg ? s.rotateZ(angleDeg) : s;
};

test("a real meshed 2x2-hole plate rotated exactly 45deg about Z still reports both " +
     "mirror planes", () => {
  const r = describeMesh(kernel, holeGridPlate(45), { digest: "symmetry-45" });
  const mirrors = (r.symmetry ?? []).filter((s) => s.type === "mirror");
  expect(mirrors.length).toBe(2);
});

// The same plate at angles with no equal-magnitude-component tie must keep reporting
// both planes too — this is a 45deg-specific bug, not a general regression.
test.each([0, 15, 30, 60, 90])(
  "the same hole-grid plate at %ideg (no 45deg tie) reports both mirror planes", (angle) => {
    const r = describeMesh(kernel, holeGridPlate(angle), { digest: `symmetry-${angle}` });
    const mirrors = (r.symmetry ?? []).filter((s) => s.type === "mirror");
    expect(mirrors.length).toBe(2);
  });
