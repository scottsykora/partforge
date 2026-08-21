import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, annulusPlate, rotateMesh } from "./helpers/mesh-fixtures.js";

const run = (mesh) => segment(buildTopology(mesh));

// A realistic facet count, not the inflated 240 an earlier pass on this file
// needed. That 240 was working around a real bug (region growth used the same
// ascending-DOF fit as its final classification, so it could never escape
// classifying a growing cylinder patch as a "plane" once one had grown far
// enough to fail — see the growthFit/bestFit split and the dihedral-gated
// adaptive tolerance below). With both of those fixed, growth no longer needs
// an artificially fine mesh to bootstrap past its own first step, and the
// N-sweep test below confirms recovery holds all the way down to N = 16 — so
// 48 here is just an unremarkable, realistic CAD facet count again, not a
// crutch. Leaving it as a value distinct from the sweep's own list keeps this
// test from silently depending on the sweep test asserting the same thing.
const CYL_SEGS = 48;

test("a box segments into exactly six planes", () => {
  const { patches, unassigned } = run(boxMesh(10, 20, 5));
  expect(patches.length).toBe(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
  expect(unassigned.length).toBe(0);
});

test("box patches carry both triangles of their quad", () => {
  const { patches } = run(boxMesh(10, 20, 5));
  for (const p of patches) expect(p.faces.length).toBe(2);
});

test("a cylinder segments into two planes and one cylinder", () => {
  const { patches } = run(cylinderMesh(4, 10, CYL_SEGS));
  const types = patches.map((p) => p.fit.type).sort();
  expect(types).toEqual(["cylinder", "plane", "plane"]);
});

test("the recovered cylinder radius matches the fixture", () => {
  const { patches } = run(cylinderMesh(4, 10, CYL_SEGS));
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius).toBeCloseTo(4, 2);
});

test("a washer segments into two annulus planes and two cylinders", () => {
  const { patches } = run(annulusPlate(10, 4, 3, CYL_SEGS));
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length).toBe(2);
  expect(radii[0]).toBeCloseTo(4, 1);
  expect(radii[1]).toBeCloseTo(10, 1);
});

test("patch areas sum to the mesh area", () => {
  const topo = buildTopology(cylinderMesh(4, 10, CYL_SEGS));
  const { patches } = segment(topo);
  const total = [...topo.faceArea].reduce((a, b) => a + b, 0);
  expect(patches.reduce((a, p) => a + p.area, 0)).toBeCloseTo(total, 6);
});

// Regression: the suite above only ever ran at ONE facet count, which is
// exactly why the bug fixed in this revision shipped in the first place — at
// nearly every "reasonable" CAD tessellation density (16 through 128 segments
// per revolve, span-checked against real STL exports), the OLD growth
// predicate shredded a curved wall into one plane per facet and never
// recovered a cylinder at all, while still reporting `unassigned.length === 0`
// (it was over-claiming faces as the wrong type, not failing to claim them —
// so Task 4's RANSAC mop-up, which only ever looks at `unassigned`, could
// never have caught it either). Sweeping density here is what would have
// caught that the first time.
const CYLINDER_SEGS_SWEEP = [16, 24, 32, 48, 64, 96, 240];

test.for(CYLINDER_SEGS_SWEEP)("a cylinder at %i segments still segments into two planes and one cylinder of radius 4", (segs) => {
  const { patches, unassigned } = run(cylinderMesh(4, 10, segs));
  const types = patches.map((p) => p.fit.type).sort();
  expect(types, `segs=${segs}`).toEqual(["cylinder", "plane", "plane"]);
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius, `segs=${segs}`).toBeCloseTo(4, 2);
  expect(unassigned.length, `segs=${segs}`).toBe(0);
});

test.for(CYLINDER_SEGS_SWEEP)("a washer at %i segments still segments into two annulus planes and cylinders at r=4 and r=10", (segs) => {
  const { patches, unassigned } = run(annulusPlate(10, 4, 3, segs));
  expect(patches.length, `segs=${segs}`).toBe(4);
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length, `segs=${segs}`).toBe(2);
  expect(radii[0], `segs=${segs}`).toBeCloseTo(4, 1);
  expect(radii[1], `segs=${segs}`).toBeCloseTo(10, 1);
  expect(unassigned.length, `segs=${segs}`).toBe(0);
});

// `unassigned` has an easy-to-miss precondition: a lone triangle's three points
// always define SOME plane exactly (rms 0), so `growthFit`/`bestFit` can only
// ever fail on a single-triangle seed when even a PLANE fit is refused — which
// only happens when fit.js's own rank guard judges the three points too close
// to collinear (a genuine, if extreme, sliver). This hand-built fixture pairs
// one ordinary flat quad with one isolated sliver triangle (no shared vertices
// with anything, so growth cannot rescue it from a neighbour either) placed far
// away, to exercise the one real path into `unassigned` rather than leaving it
// untested, as it was before this revision.
test("a fixture with one legitimate quad and one isolated sliver triangle reports the sliver as unassigned", () => {
  const positions = [
    0, 0, 0, 10, 0, 0, 10, 10, 0,
    0, 0, 0, 10, 10, 0, 0, 10, 0,
    1000, 0, 0, 1010, 0, 0, 1005, 1e-6, 0,
  ];
  const { patches, unassigned } = segment(buildTopology({ positions }));
  expect(patches.length).toBe(1);
  expect(patches[0].fit.type).toBe("plane");
  expect(patches[0].faces.length).toBe(2);
  expect(unassigned).toEqual([2]);
});

// Regression: the dihedral-gated adaptive tolerance that makes the sweep above
// pass (FACET_K * leverArm * |dihedral|, see segment.js) has NO ceiling on its
// own — leverArm grows with facet size without limit, so two flat quads hinged
// at a fixed design angle (10-29 degrees, comfortably under the 30-degree
// smoothness gate) merge into a single mis-typed "cylinder" patch once EITHER
// side is coarse enough to be just one quad, which is exactly how a CAD
// exporter emits a large flat face. Verified directly against the shipped
// dihedral-gate-only design before the corroboration fix below existed: this
// merged at every angle 10-29 degrees and every facet width 5-100mm tried.
// The fix (see `sameFamily`/`familySignature` in segment.js) requires a
// candidate fold to have a WITNESS — another edge of matching sign and implied
// radius — before the adaptive allowance may admit it; a lone design corner,
// unlike a real tessellated curve, never has one.
function hingedPlanes(thetaRad, w) {
  const a0 = [-w, 0, 0], a1 = [-w, 10, 0], a2 = [0, 10, 0], a3 = [0, 0, 0];
  const c = Math.cos(thetaRad), s = Math.sin(thetaRad);
  const rotate = (p) => [p[0] * c - p[2] * s, p[1], p[0] * s + p[2] * c];
  const b0 = [0, 0, 0], b1 = [0, 10, 0], b2 = rotate([w, 10, 0]), b3 = rotate([w, 0, 0]);
  const positions = [];
  const tri = (out, a, b, cc) => out.push(...a, ...b, ...cc);
  tri(positions, a0, a3, a2); tri(positions, a0, a2, a1);
  tri(positions, b0, b3, b2); tri(positions, b0, b2, b1);
  return { positions };
}

const HINGE_ANGLE_DEG_AND_WIDTH = [
  [10, 5], [10, 20], [10, 50], [10, 100],
  [20, 5], [20, 20], [20, 50], [20, 100],
  [29, 5], [29, 20], [29, 50], [29, 100],
];

test.for(HINGE_ANGLE_DEG_AND_WIDTH)(
  "two flat quads hinged at %i degrees (facet width %i) stay two separate planes",
  ([thetaDeg, w]) => {
    const { patches, unassigned } = run(hingedPlanes((thetaDeg * Math.PI) / 180, w));
    const tag = `theta=${thetaDeg} w=${w}`;
    expect(patches.length, tag).toBe(2);
    expect(patches.every((p) => p.fit.type === "plane"), tag).toBe(true);
    expect(unassigned.length, tag).toBe(0);
  },
);

// Regression, the harder direction of the same bug: a flat plane that is
// TANGENT (G1-smooth, zero dihedral right at the seam) to a cylinder wall is
// the case the smoothness gate cannot reject on dihedral alone, since a true
// tangent boundary's own immediate fold is small by construction — exactly
// the range the gate is SUPPOSED to admit for real curvature. Verified
// directly: with the flat side coarsely tessellated as ONE quad, the entire
// flat face folded into a patch mis-typed "cylinder" covering nearly the
// whole model, both via the raw adaptive term (no ceiling) and via a second,
// independent mechanism — `tol` itself is a fraction of the WHOLE MESH's bbox
// diagonal, so the large flat quad's own size inflated `tol` enough to admit
// the transition edge outright, bypassing the dihedral/corroboration logic
// entirely (a nonzero-dihedral edge that merely happens to also clear the
// flat, unrelated-feature-inflated `tol`). Fixed by routing every nonzero-
// dihedral edge through corroboration regardless of which tolerance path
// admits it (see `classifyCandidate` in segment.js) — only a PERFECTLY flat
// (dihedral === 0) continuation skips the witness requirement.
function cylinderPlusTangentPlane(r, h, segs, w) {
  const positions = [];
  const p = (i, z) => [r * Math.cos((2 * Math.PI * i) / segs), r * Math.sin((2 * Math.PI * i) / segs), z];
  const tri = (out, a, b, c) => out.push(...a, ...b, ...c);
  for (let i = 0; i < segs; i++) {
    const a = p(i, 0), b = p(i + 1, 0), c = p(i + 1, h), d = p(i, h);
    tri(positions, a, b, c); tri(positions, a, c, d);           // wall
    tri(positions, [0, 0, 0], b, a);                             // bottom cap
    tri(positions, [0, 0, h], d, c);                             // top cap
  }
  // Flat quad tangent to the wall at theta=0: shares the vertical edge
  // (r,0,0)-(r,0,h), extending in the wall's own tangent direction there
  // (+Y) rather than curving — the flat continuation a fillet-to-plane
  // blend or a straight extrusion wall would produce.
  const q0 = [r, 0, 0], q1 = [r, 0, h], q2 = [r, w, h], q3 = [r, w, 0];
  tri(positions, q0, q3, q2); tri(positions, q0, q2, q1);
  return { positions };
}

const TANGENT_SEGS_AND_WIDTH = [
  [48, 5], [48, 20], [48, 50],
  [96, 5], [96, 20], [96, 50],
];

test.for(TANGENT_SEGS_AND_WIDTH)(
  "a flat quad tangent to a %i-segment cylinder wall (width %i) stays typed plane, not folded into the cylinder",
  ([segs, w]) => {
    const topo = buildTopology(cylinderPlusTangentPlane(4, 10, segs, w));
    const totalFaces = topo.faceArea.length;
    const tangentFaces = [totalFaces - 2, totalFaces - 1];
    const { patches, unassigned } = segment(topo);
    const tag = `segs=${segs} w=${w}`;
    const flatPatch = patches.find((p) => tangentFaces.every((i) => p.faces.includes(i)));
    expect(flatPatch, tag).toBeDefined();
    expect(flatPatch.fit.type, tag).toBe("plane");
    expect(flatPatch.faces.length, tag).toBe(2);
    expect(unassigned.length, tag).toBe(0);
  },
);

// Regression: EVERY fixture in this file, and in mesh-fixtures.js itself, is
// axis-aligned and origin-centred — which is exactly why a real bug shipped
// passing 53/53 while broken for essentially every REAL (i.e. arbitrarily
// oriented) part. `classifyCandidate` in segment.js once tested a coplanar
// quad diagonal's flatness with `dihedral === 0`: bit-exact zero only when
// the mesh happens to be axis-aligned (a lucky cancellation in the
// underlying cross/dot/atan2 chain topology.js derives it through). Rotate
// the identical, still-perfectly-flat geometry and the same diagonal comes
// out as noise like `-9.4e-17` — a real zero with the wrong bit pattern —
// which routed it into the witness-requiring "pending" path, where a lone
// seed triangle's only internal edge has nothing to corroborate against.
// Verified directly before this fix: a 0.01-degree tilt was enough to
// collapse `cylinderMesh(4,10,48)` into single-triangle plane patches, and
// rotating a box, cylinder, or washer by an arbitrary (17°, 29°, 53°) failed
// at every density tried, while `b242be8` (round 2, pre-epsilon-fix) handled
// the identical rotated meshes correctly — this was a round-3 regression,
// not a pre-existing gap. Fixed by using `topology.js`'s own tested
// `convexity === "flat"` band instead of reinventing a second, exact-equality
// epsilon. These rotated variants are permanent, alongside (not instead of)
// the axis-aligned tests above, since the two failure modes are independent.
const TILT = [(17 * Math.PI) / 180, (29 * Math.PI) / 180, (53 * Math.PI) / 180];

test("a rotated box still segments into exactly six planes", () => {
  const { patches, unassigned } = run(rotateMesh(boxMesh(10, 20, 5), TILT));
  expect(patches.length).toBe(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
  expect(unassigned.length).toBe(0);
});

test.for([16, 48, 96])("a rotated cylinder at %i segments still segments into two planes and one cylinder of radius 4", (segs) => {
  const { patches, unassigned } = run(rotateMesh(cylinderMesh(4, 10, segs), TILT));
  const tag = `segs=${segs}`;
  const types = patches.map((p) => p.fit.type).sort();
  expect(types, tag).toEqual(["cylinder", "plane", "plane"]);
  const cyl = patches.find((p) => p.fit.type === "cylinder");
  expect(cyl.fit.radius, tag).toBeCloseTo(4, 2);
  expect(unassigned.length, tag).toBe(0);
});

test.for([16, 48, 96])("a rotated washer at %i segments still segments into two annulus planes and cylinders at r=4 and r=10", (segs) => {
  const { patches, unassigned } = run(rotateMesh(annulusPlate(10, 4, 3, segs), TILT));
  const tag = `segs=${segs}`;
  expect(patches.length, tag).toBe(4);
  const radii = patches.filter((p) => p.fit.type === "cylinder").map((p) => p.fit.radius).sort((a, b) => a - b);
  expect(radii.length, tag).toBe(2);
  expect(radii[0], tag).toBeCloseTo(4, 1);
  expect(radii[1], tag).toBeCloseTo(10, 1);
  expect(unassigned.length, tag).toBe(0);
});
