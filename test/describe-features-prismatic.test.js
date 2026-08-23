import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { surfaceGraph } from "../src/framework/oracle/describe/surface-graph.js";
import { detectPrismatic } from "../src/framework/oracle/describe/features/prismatic.js";
import { detectSweeps } from "../src/framework/oracle/describe/features/sweeps.js";
import {
  boxMesh, cylinderMesh, annulusPlate, cupMesh,
  boxWithPocket, boxWithPad, hollowBoxMesh, openTrayMesh, cubeMesh, barMesh,
  plateWithDistractor, rotateMesh,
} from "./helpers/mesh-fixtures.js";

// Same arbitrary, unremarkable tilt describe-surface-graph.test.js, describe-segment.test.js
// and describe-ransac.test.js already use. `rotateMesh(mesh, [rx, ry, rz])` takes radians
// packed in one array (see mesh-fixtures.js).
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];
const ORIENTATIONS = [["axis-aligned", (m) => m], ["rotated", (m) => rotateMesh(m, TILT)]];

const ctx = (mesh) => { const t = buildTopology(mesh); return { t, g: surfaceGraph(t, segment(t).patches) }; };

test("a plain box is one extrusion, not a pocket or a boss", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const f = detectPrismatic(g);
  expect(f.map((x) => x.type)).toEqual(["extrusion"]);
});

// Guards ruling R10 from the prismatic side: a washer's cap arcs are a MIX of convex
// (both rims) and concave (nothing) — a rule that counted them to decide pocket-vs-boss
// would classify by noise. The base extrusion must win regardless.
test("a washer's base extrusion is not misread as a pocket or a boss", () => {
  const { g } = ctx(annulusPlate(10, 4, 3, 48));
  expect(detectPrismatic(g).map((x) => x.type)).toEqual(["extrusion"]);
});

test("the box extrusion recovers a rectangular profile and its depth", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("polygon");
  expect(ex.depth).toBeCloseTo(5, 2);
});

test("a cylinder is an extrusion with a circular profile", () => {
  const { g } = ctx(cylinderMesh(4, 10, 48));
  const [ex] = detectPrismatic(g);
  expect(ex.profile.kind).toBe("circle");
  // `profile.radius` comes from the cap's boundary ARC (surface-graph.js's `arcKind`),
  // which measures the mean distance of EDGE MIDPOINTS to their own centroid, not the
  // wall's own least-squares vertex fit — deliberately (`profile` is a proposal for a
  // sketch, not a measurement; see this file's header). On a 48-gon inscribed in a true
  // radius-4 circle, that midpoint radius is exactly `4*cos(pi/48)`, not merely "close
  // to 4" — asserting the DERIVABLE quantity (rather than a loosened `toBeCloseTo(4, 1)`,
  // which would keep passing even if this computation regressed to some other nearby
  // value) is what makes this a real guard on `arcKind` rather than a tolerance wide
  // enough to stop checking it.
  expect(ex.profile.radius).toBeCloseTo(4 * Math.cos(Math.PI / 48), 4);
  expect(ex.depth).toBeCloseTo(10, 2);
});

test("a washer is recognised as axisymmetric (a revolve candidate)", () => {
  const { t, g } = ctx(annulusPlate(10, 4, 3, 48));
  const rev = detectSweeps(g, t).find((f) => f.type === "revolve");
  expect(rev).toBeDefined();
  expect(Math.abs(rev.axis.direction[2])).toBeCloseTo(1, 3);
});

// Arbitrary orientation, per the Global Constraints. `sweepDirection` and the revolve
// axis vote both come out of eigen-decompositions of normal fields, which have no reason
// to prefer world axes — but the depth fallback compares plane OFFSETS, which do.
test.each(ORIENTATIONS)(
  "%s: a box is one extrusion of the same depth", (_n, orient) => {
    const { g } = ctx(orient(boxMesh(10, 20, 5)));
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion"]);
    expect(f[0].depth).toBeCloseTo(5, 2);
  });

test.each(ORIENTATIONS)(
  "%s: the washer is still recognised as axisymmetric", (_n, orient) => {
    const { t, g } = ctx(orient(annulusPlate(10, 4, 3, 48)));
    expect(detectSweeps(g, t).some((f) => f.type === "revolve")).toBe(true);
  });

// The mouth-vs-floor ambiguity: `cupMesh`'s blind bore has a wide mouth ANNULUS (the
// rim around the hole) and a narrow floor DISK, and both border the same bore wall.
// Processing pockets/bosses largest-area-first (the same order used to find the base)
// would let the bigger annulus claim that wall before the genuine floor gets a turn,
// misreporting the feature backwards or dropping it. Smallest-first is what fixes that
// (see this file's header) — this is the regression test for it, using the same
// fixture describe-features-holes.test.js already uses for the equivalent blind-hole
// case. A DEEP NARROW pocket (small footprint relative to its own wall area) — kept
// here alongside the wide-shallow cases below so the dominant-convexity fix is a
// widening of what's detected, not a swap of which proportion works.
test.each(ORIENTATIONS)(
  "%s: a blind-hole cup is a base extrusion plus one pocket, not a boss or a mouth-first misread",
  (_n, orient) => {
    const { g } = ctx(orient(cupMesh(10, 4, 8, 3, 48)));
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion", "pocket"]);
    const pocket = f.find((x) => x.type === "pocket");
    expect(pocket.depth).toBeCloseTo(5, 1);
  });

// Fix round 1 (Critical 3): a WIDE SHALLOW pocket (its own floor bigger than its own
// side walls, the opposite proportion from the deep-narrow case above) was reporting
// depth 20 instead of 3, with `floorFace` bound to a 24mm^2 SIDE WALL rather than the
// real 80mm^2 floor — pass two (smallest-cap-first) reached that small wall before the
// floor, and it passed every check that existed at the time (see prismatic.js's own
// `dominantConvexityFraction` comment for the exact numbers this fixture exposed).
// Reproduced here at both orientations, asserting type, depth AND which surface is the
// floor, so a regression that merely gets the number right by accident is still caught.
test.each(ORIENTATIONS)(
  "%s: a wide shallow pocket is one pocket of the right depth, not a swapped side wall",
  (_n, orient) => {
    const mesh = orient(boxWithPocket(30, 20, 8, 10, 6, 10, 8, 3));
    const { g } = ctx(mesh);
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion", "pocket"]);
    const pocket = f.find((x) => x.type === "pocket");
    expect(pocket.depth).toBeCloseTo(3, 1);
    // The floor is the pocket's own 10x8=80mm^2 face, not one of its 24 or 30mm^2 walls.
    const floor = g.surfaces.find((s) => s.id === pocket.floorFace);
    expect(floor.area).toBeCloseTo(80, 0);
  });

// The raised twin of the same fixture and same proportions: a coin-flip bug that only
// showed up on one proportion (or only swapped the type and not the depth) would slip
// past a suite that tested just the pocket above.
test.each(ORIENTATIONS)(
  "%s: a raised pad of the same proportions is one boss, not a pocket", (_n, orient) => {
    const mesh = orient(boxWithPad(30, 20, 8, 10, 6, 10, 8, 3));
    const { g } = ctx(mesh);
    const f = detectPrismatic(g);
    expect(f.map((x) => x.type)).toEqual(["extrusion", "boss"]);
    const boss = f.find((x) => x.type === "boss");
    expect(boss.depth).toBeCloseTo(3, 1);
    const top = g.surfaces.find((s) => s.id === boss.floorFace);
    expect(top.area).toBeCloseTo(80, 0);
  });

// R57 (CRITICAL, prismatic.js commit d0718e0): the pre-fix pocket/boss rule read
// `allCaps.find(c => dot(c.fit.normal, cap.fit.normal) > 0.98)` — the largest-area
// co-oriented plane ANYWHERE on the part, no adjacency check — instead of a plane the
// feature's own walls actually meet. filletedBox's own compound fillet corners were
// the bug's original real-world reproduction, but that fixture's own segmentation-order
// noise (documented in describe-roundtrip.test.js) forced its per-rotation "dominant
// boss stays a boss" test to be dropped later, and REPLACED with "an ordinary
// boss-and-pocket plate stays correctly classified across rotation" (same file) —
// which was verified, by restoring the pre-fix `findSurround` into a scratch copy of
// this file and running that replacement test against it, to PASS on the broken code.
// A single-base-plate part never gives the old search a co-oriented plane bigger than
// the plate's own top face to wrongly latch onto, so it finds the true partner by pure
// luck of area order — R57 itself was left with no test that could actually fail on
// it. This test supplies the precondition the old rule needed to get it wrong:
// `plateWithDistractor`'s own "distractor" pad is co-oriented with both the boss and
// the pocket but adjacent to neither, and its footprint eats enough of the plate's own
// top face that what's LEFT of the plate top (474mm^2) is smaller than the
// distractor's own top (1008mm^2) — so the old rule's largest-first, no-adjacency
// search reaches the distractor before it ever reaches the boss's or the pocket's own
// true, adjacent partner (the plate).
//
// Verified directly against that scratch copy: at every rotation below (flat, and
// three mixed tilts running through 29, 90 and 73 degrees — the angles fix round 2's
// own report named as the worst pre-fix swaps), the boss comes back typed POCKET at
// depth 87 (its own 13mm cap read against the distractor's 100mm offset) — R57's exact
// failure mode, a rebuilding agent told to CUT where it should ADD — and the pocket
// keeps its own type by coincidence (its displacement against the distractor is
// negative either way) but reports depth 93 instead of 3. Both numbers are bit-
// identical across every rotation tried: unlike filletedBox's own compound corners,
// this is a structural defect in WHICH plane wins the search, not a tessellation/
// segmentation-order artefact, so it does not need rotation to manifest at all — the
// rotations here prove the FIX itself is not orientation-dependent, not to provoke
// the bug. `boss`/`pocket` below are picked by their cap's OWN offset (13 / 7mm,
// rotation-invariant — a plane's offset along its own fitted normal does not change
// under a rotation about the origin), not by `type`, so the selection cannot itself be
// fooled by the very type-swap bug this test exists to catch.
test.each([
  ["flat", [0, 0, 0]],
  ["29deg-mixed", [29, 58, 87]],
  ["90deg-x", [90, 0, 0]],
  ["73deg-mixed", [73, 37, 11]],
])(
  "%s: a boss and a pocket keep their type and depth despite a bigger unrelated " +
  "co-oriented plane elsewhere on the part",
  (_label, [rx, ry, rz]) => {
    const flatMesh = plateWithDistractor(
      30, 50, 10, 5, 10,   // plate 30x50x10, boss band [0,5], pocket band [5,10]
      2, 1, 3, 3,          // boss: 3x3 footprint, 3mm proud (own cap offset 13)
      10, 6, 3, 3,         // pocket: 3x3 footprint, 3mm deep (own cap offset 7)
      1, 12, 28, 36, 90,   // distractor: 28x36=1008mm^2 footprint (> the plate's own
                           // 474mm^2 remainder), 90mm proud, own cap offset 100
    );
    const mesh = rotateMesh(flatMesh, [rx, ry, rz].map((d) => (d * Math.PI) / 180));
    const { g } = ctx(mesh);
    const f = detectPrismatic(g);
    const surfaceOf = (feat) => g.surfaces.find((s) => s.id === feat.floorFace);

    const boss = f.find((x) => Math.abs(surfaceOf(x).fit.offset - 13) < 0.5);
    const pocket = f.find((x) => Math.abs(surfaceOf(x).fit.offset - 7) < 0.5);
    expect(boss).toBeDefined();
    expect(pocket).toBeDefined();
    expect(boss.type).toBe("boss");
    expect(pocket.type).toBe("pocket");
    // Depth too, not just type: the pre-R57 code's pocket keeps its own type by
    // coincidence but still reports the wrong number — a type-only assertion would
    // miss that half of the regression.
    expect(boss.depth).toBeCloseTo(3, 1);
    expect(pocket.depth).toBeCloseTo(3, 1);
  });

test("prismatic features carry stable keys and null ids", () => {
  const { g } = ctx(boxMesh(10, 20, 5));
  const a = detectPrismatic(g)[0], b = detectPrismatic(g)[0];
  expect(a.key).toBe(b.key);
  expect(a.id).toBeNull();
});

// --- shell (fix round 1: Criticals 1 and 2) ---------------------------------------
//
// A first version paired every anti-parallel plane and gated on the SPREAD of the
// resulting gaps. That was wrong in both directions, reproduced here as permanent
// negative/positive pairs: a solid CUBE has three anti-parallel pairs that happen to
// share one gap (its three equal dimensions), which the pairing test could not tell
// apart from a genuine uniform wall — a false positive. And a genuine hollow box's 12
// planes pair into not just the 6 correct wall-thickness gaps but also the outer
// envelope's own 3 gaps and the inner cavity's own 3 gaps, which blows the spread past
// any reasonable threshold — a false negative on the only shape the rule exists to
// catch. The raycast-based rule replacing it is proven on both directions below.

test.each(ORIENTATIONS)("%s: a solid cube is not reported as a shell", (_n, orient) => {
  const { t, g } = ctx(orient(cubeMesh(10)));
  expect(detectSweeps(g, t).some((f) => f.type === "shell")).toBe(false);
});

test.each(ORIENTATIONS)("%s: a square bar is not reported as a shell", (_n, orient) => {
  const { t, g } = ctx(orient(barMesh(10, 10, 30)));
  expect(detectSweeps(g, t).some((f) => f.type === "shell")).toBe(false);
});

test.each(ORIENTATIONS)("%s: a solid box is not reported as a shell", (_n, orient) => {
  const { t, g } = ctx(orient(boxMesh(10, 20, 5)));
  expect(detectSweeps(g, t).some((f) => f.type === "shell")).toBe(false);
});

test.each(ORIENTATIONS)("%s: a hollow box is reported as a shell of the right thickness", (_n, orient) => {
  const { t, g } = ctx(orient(hollowBoxMesh(20, 20, 20, 2)));
  const shell = detectSweeps(g, t).find((f) => f.type === "shell");
  expect(shell).toBeDefined();
  expect(shell.thickness).toBeCloseTo(2, 1);
});

// The open tray: no anti-parallel partner for the missing top face at all (the old
// pairing approach could not have found this one even with a perfect spread gate), and
// one dissenting reading (the rim — its own normal points along the wall's run, not
// across its thickness) that the rule must tolerate as a minority, not choke on.
test.each(ORIENTATIONS)("%s: an open tray is reported as a shell of the right thickness", (_n, orient) => {
  const { t, g } = ctx(orient(openTrayMesh(20, 20, 10, 2)));
  const shell = detectSweeps(g, t).find((f) => f.type === "shell");
  expect(shell).toBeDefined();
  expect(shell.thickness).toBeCloseTo(2, 1);
});
