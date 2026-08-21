import { expect, test } from "vitest";
import { buildTopology } from "../src/framework/oracle/describe/topology.js";
import { ransacPatches } from "../src/framework/oracle/describe/ransac.js";
import { segment } from "../src/framework/oracle/describe/segment.js";
import { boxMesh, cylinderMesh, rotateMesh } from "./helpers/mesh-fixtures.js";

// Fisher-Yates over a fixed seed, not `Math.random` — this file's own fixture
// needs a SHUFFLED face order to prove output doesn't depend on input order,
// but the suite as a whole still may not call `Math.random` (the framework's
// purity rule, restated in ransac.js's own header) for its own logic; a
// deterministic pseudo-shuffle keeps the test itself reproducible too.
function shuffled(arr, seed) {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test("ransac recovers a plane from a disconnected face set", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  // Every face, offered with no adjacency hint at all — region growing's job is
  // done by connectivity, ransac's job is done by consensus.
  const all = [...topo.faceArea.keys()];
  const { patches } = ransacPatches(topo, all, 1e-3);
  expect(patches.length).toBeGreaterThanOrEqual(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
});

test("ransac recovers a plane from a disconnected face set, arbitrarily oriented", () => {
  // Same fixture, rotated by an ugly angle triple, so recovery is proven to not
  // depend on axis alignment (see rotateMesh's own comment on why that matters).
  const topo = buildTopology(rotateMesh(boxMesh(10, 20, 5), [17 * Math.PI / 180, 29 * Math.PI / 180, 53 * Math.PI / 180]));
  const all = [...topo.faceArea.keys()];
  const { patches } = ransacPatches(topo, all, 1e-3);
  expect(patches.length).toBeGreaterThanOrEqual(6);
  expect(patches.every((p) => p.fit.type === "plane")).toBe(true);
});

test("ransac is deterministic across runs", () => {
  const topo = buildTopology(cylinderMesh(4, 10, 32));
  const a = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  const b = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  expect(a.patches.map((p) => p.faces.length)).toEqual(b.patches.map((p) => p.faces.length));
});

// Content (which faces end up grouped together) is provably independent of the
// order `faces` was handed in — nothing in `ransacPatches` reads array position
// as identity, only face-index values. But the DISCOVERY order the internal
// while-loop finds patches in can differ across a shuffled input (ties in
// consensus size break on whichever candidate the pair generator tries first),
// and this file's own header claims "same input, same patches, every run" — a
// claim that is only actually true if patch IDENTITY (id, and array position)
// doesn't depend on caller order either. Six different shuffles of the same
// 12-face box, and every one must produce the SAME serialized output, not just
// the same patch count.
test("ransac output does not depend on the caller's face order", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  const faces = [...topo.faceArea.keys()];
  const canonical = JSON.stringify(ransacPatches(topo, faces, 1e-3));
  for (let seed = 1; seed <= 6; seed++) {
    const result = ransacPatches(topo, shuffled(faces, seed * 97 + 13), 1e-3);
    expect(JSON.stringify(result), `seed ${seed}`).toBe(canonical);
  }
});

test("ransac leaves faces it cannot explain in unassigned", () => {
  const topo = buildTopology(boxMesh(10, 20, 5));
  const { patches, unassigned } = ransacPatches(topo, [0, 1], 1e-9);
  const claimed = patches.reduce((a, p) => a + p.faces.length, 0);
  expect(claimed + unassigned.length).toBe(2);
});

// A cylinder wall handed to `ransacPatches` directly (no segment() growing, no
// adjacency hint beyond the topology itself) fragments into one small "plane"
// patch per facet (see the file's own comment on why: a minimal sample only
// ever hypothesizes planes, and each individual facet of a faceted wall IS
// flat) rather than one cylinder — an accepted, documented limitation, not
// what this test is checking. What this test checks is that EVERY facet still
// gets claimed, at every one of these sizes, including well past the size
// where an earlier version of this file silently gave up on half the mesh
// (see the CRITICAL fix this guards: a coprime-stride sampling fallback that
// activated once a pool exceeded a fixed budget could skip every same-facet
// pair a plane hypothesis needs, at a fixed size cliff). Segment counts kept
// modest enough to run well inside a normal test timeout — the same recovery
// was independently re-verified up to 4000 faces (segs=1000) by hand; see the
// fix report for those numbers and their (much longer) run times.
test.for([16, 32, 64, 100, 200])("a %i-segment cylinder's wall and caps are recovered with nothing left unassigned", (segs) => {
  const topo = buildTopology(cylinderMesh(4, 10, segs));
  const { unassigned } = ransacPatches(topo, [...topo.faceArea.keys()], 1e-2);
  expect(unassigned.length, `segs=${segs}`).toBe(0);
});

test("segment runs the mop-up and reports no unassigned faces on a box (regression: clean segmentation is unaffected)", () => {
  // Region growing alone already claims every face of a box (Task 3's own
  // assertion); RANSAC never has anything to do here. This is a wiring
  // regression guard, not a recovery test — see the sliver-pair test below for
  // one where the mop-up actually does something.
  expect(segment(buildTopology(boxMesh(10, 20, 5))).unassigned.length).toBe(0);
});

test("segment runs the mop-up on an arbitrarily oriented box too (regression)", () => {
  const rotated = rotateMesh(boxMesh(10, 20, 5), [17 * Math.PI / 180, 29 * Math.PI / 180, 53 * Math.PI / 180]);
  expect(segment(buildTopology(rotated)).unassigned.length).toBe(0);
});

// The genuine wiring test the two above are NOT: for both, `segment(topo,
// {ransac:false}).unassigned` is already empty, so neither would fail if
// `ransacPatches` were replaced with a stub, or the wiring in segment.js were
// deleted outright. This fixture is built so growing's own connectivity search
// leaves real residue behind for the mop-up to actually recover.
//
// Extends Task 3's own degenerate-sliver fixture (see the "isolated sliver
// triangle" test above in this suite's sibling file, describe-segment.test.js):
// `unassigned`'s one known real path is a lone triangle so close to collinear
// that even `fitPlane`'s own rank guard refuses it (an ill-determined normal,
// not a tolerance failure) — `growthFit` returns null for that seed before
// growth ever starts, and it is never assigned to any patch. ONE such sliver
// has nothing to pair with and stays unassigned; TWO, placed apart on the
// SAME real plane (z=0) but each individually still too thin to fit alone,
// combine into a well-conditioned 6-point set once RANSAC considers them
// together (verified directly: each triangle alone fails `fitPlane`; the two
// together fit one with `maxDev` of exactly 0, since every point genuinely
// lies at z=0). Region growing cannot rescue either sliver from the other
// (no shared vertices, no shared edge — this is what disconnected islands of
// a real plane look like structurally), so recovering them is squarely
// RANSAC's job, not growing's.
test("segment's mop-up reunites two disconnected slivers of the same real plane that growing alone cannot", () => {
  const positions = [
    // an ordinary flat quad, claimed by growing on its own — present so the
    // mop-up's own consensus scan has more than just the two slivers in the
    // wider mesh, and so this test also confirms the reunited slivers do NOT
    // get folded into the unrelated quad's own patch.
    0, 0, 0, 10, 0, 0, 10, 10, 0,
    0, 0, 0, 10, 10, 0, 0, 10, 0,
    // sliver A: isolated, near-collinear, individually degenerate
    1000, 0, 0, 1010, 0, 0, 1005, 1e-6, 0,
    // sliver B: isolated, near-collinear, individually degenerate, same z=0
    // plane as A, offset in y so the two together span real 2-D area
    1000, 50, 0, 1010, 50, 0, 1005, 50 + 1e-6, 0,
  ];
  const topo = buildTopology({ positions });

  const withoutRansac = segment(topo, { ransac: false });
  expect(withoutRansac.patches.length).toBe(1);
  expect(withoutRansac.unassigned).toEqual([2, 3]);

  const { patches, unassigned } = segment(topo);
  expect(unassigned.length).toBe(0);
  const quad = patches.find((p) => p.faces.length === 2 && p.faces.includes(0));
  const reunited = patches.find((p) => p.faces.includes(2));
  expect(quad).toBeDefined();
  expect(reunited).toBeDefined();
  expect(reunited.fit.type).toBe("plane");
  expect(reunited.faces.sort((a, b) => a - b)).toEqual([2, 3]);
});
