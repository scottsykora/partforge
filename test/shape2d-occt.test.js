import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { circleProfile, pathProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

const SQ = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];
const stepText = async (solid) => new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));

test("union/cut/intersect extrude to the expected volumes", () => {
  const h = 4;
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).union(SQ(5,5,10)), h }).volume()).toBeCloseTo(175 * h, -1);
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).cut(SQ(5,5,10)), h }).volume()).toBeCloseTo(75 * h, -1);
  expect(k.extrude({ profile: k.shape2d(SQ(0,0,10)).intersect(SQ(5,5,10)), h }).volume()).toBeCloseTo(25 * h, -1);
});

test("curve operand stays exact: cut a cubic-circle hole → STEP has a B_SPLINE", async () => {
  const KAPPA = 0.5522847498307936, R = 5, k4 = R * KAPPA;
  const circle = pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R]).cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R]).cubicTo([R, 0], [k4, -R], [R, -k4]).close();
  const plate = k.shape2d(SQ(-10, -10, 20)).cut(circle);
  const step = await stepText(k.extrude({ profile: plate, h: 3 }));
  expect(step).toMatch(/B_SPLINE/);
});

test("boundingBox and toRegions materialize", () => {
  // NOTE: SQ(7,7,6) spans x/y 7..13, which overlaps only the (7,7)-(10,10) corner of
  // the 10x10 outer square — not a fully interior hole (that would need a bigger outer,
  // e.g. the SQ(0,0,20) used by the analogous Manifold test in shape2d-manifold.test.js).
  // So this cut leaves a single L-shaped ring (area 100 - 9 = 91), not a 100-area outer
  // with a separate hole ring — toBeCloseTo(100,...) doesn't match this fixture's own
  // geometry; toBeCloseTo(91,...) does. Bounding-box precision is loosened from 6 to 4
  // decimals: OCCT's boolean cut leaves ~1e-6 numerical fuzz on the result's bounding
  // box (confirmed present even for a fully-interior hole, so it's inherent to OCCT's
  // own tolerance, not a bug in boundingBox()'s pass-through mapping).
  const s = k.shape2d(SQ(0, 0, 10)).cut(SQ(7, 7, 6));
  const bb = s.boundingBox();
  expect(bb.min[0]).toBeCloseTo(0, 4); expect(bb.max[0]).toBeCloseTo(10, 4);
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  const area = (p) => { let a=0; for (let i=0;i<p.length;i++){const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length];a+=x1*y2-x2*y1;} return Math.abs(a/2); };
  expect(area(regions[0].outer)).toBeCloseTo(91, 4);
});

test("boundingBox and toRegions materialize a true interior hole (mirrors the Manifold sibling test)", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cut(SQ(7, 7, 6));
  const bb = s.boundingBox();
  expect(bb.min[0]).toBeCloseTo(0, 4); expect(bb.max[0]).toBeCloseTo(20, 4);
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
  const area = (p) => { let a=0; for (let i=0;i<p.length;i++){const [x1,y1]=p[i],[x2,y2]=p[(i+1)%p.length];a+=x1*y2-x2*y1;} return Math.abs(a/2); };
  expect(area(regions[0].outer)).toBeCloseTo(400, 4);
  expect(area(regions[0].holes[0])).toBeCloseTo(36, 4);
});

// Regression coverage for a bug the containment-based classification in
// drawingRegionRings fixes: replicad's Drawing.toSVGPaths() does NOT reliably
// group a region's outer+holes together (two disjoint holes cut sequentially via
// cutAll come back as a FLAT list of 3 paths, not one nested [outer, hole, hole]
// group), and every loop (outer or hole) shares the same winding sign — so neither
// array position nor ring-area sign can classify outer vs. hole; only geometric
// containment can. Without that fix this returned 3 disjoint "outer" regions
// summing 400+16+16 instead of one region netting 368.
test("cutAll: two disjoint interior holes nest under one outer region", () => {
  const s = k.shape2d(SQ(0, 0, 20)).cutAll([SQ(2, 2, 4), SQ(12, 12, 4)]);
  expect(s.area()).toBeCloseTo(400 - 16 - 16, 4);
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(2);
});

test("a CW-wound hole materializes correctly (winding-agnostic classification)", () => {
  const cwHole = [[3, 3], [3, 6], [6, 6], [6, 3]];               // clockwise
  const s = k.shape2d([[0,0],[20,0],[20,20],[0,20]]).cut(cwHole);
  expect(s.area()).toBeCloseTo(400 - 9, 3);                       // 391, not 409
  const regions = s.toRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("cutAll: empty list is a safe identity", () => {
  const id = k.shape2d(SQ(0, 0, 10)).cutAll([]);
  expect(id.area()).toBeCloseTo(100, 4);
});

// replicad booleans consume their operands — union()/cut()/intersect() must each
// .clone() before calling fuse/cut/intersect so a Shape2D used more than once
// (e.g. as a base for two different derived shapes) still has a live Drawing.
test("a Shape2D reused in two different booleans is not consumed by the first", () => {
  const base = k.shape2d(SQ(0, 0, 10));
  const union = base.union(SQ(5, 5, 10));
  const cut = base.cut(SQ(2, 2, 3));
  expect(union.area()).toBeCloseTo(175, 4);
  expect(cut.area()).toBeCloseTo(100 - 9, 4);
});

test("curve operand: cut a circleProfile hole from a square (faceted → loose tol)", () => {
  const s = k.shape2d(SQ(-10, -10, 20)).cut(circleProfile(5));
  expect(s.area()).toBeCloseTo(400 - Math.PI * 25, 0);
});

test("revolve of a Shape2D builds a positive-volume solid", () => {
  const prof = k.shape2d([[2, 0], [6, 0], [6, 8], [2, 8]]);
  expect(k.revolve({ profile: prof, degrees: 360 }).volume()).toBeGreaterThan(0);
});

test("offset grows/insets and extrudes to the expected volume", () => {
  const grown = k.extrude({ profile: k.shape2d(SQ(0,0,10)).offset(1, { corners: "sharp" }), h: 4 });
  expect(grown.volume()).toBeCloseTo(144 * 4, -1);       // 12x12x4 (sharp corners = exact square)
});

test("offset of a curved Shape2D stays exact → STEP has a B_SPLINE", async () => {
  const KAPPA = 0.5522847498307936, R = 5, k4 = R * KAPPA;
  const circle = pathProfile([R, 0])
    .cubicTo([0, R], [R, k4], [k4, R]).cubicTo([-R, 0], [-k4, R], [-R, k4])
    .cubicTo([0, -R], [-R, -k4], [-k4, -R]).cubicTo([R, 0], [k4, -R], [R, -k4]).close();
  const step = await stepText(k.extrude({ profile: k.shape2d(circle).offset(1), h: 3 }));
  expect(step).toMatch(/B_SPLINE/);
});

test("collapse throws immediately (OCCT)", () => {
  expect(() => k.shape2d(SQ(0, 0, 10)).offset(-6)).toThrow("Shape2D.offset: offset collapses the shape");
});

test("offset+extrude volume is close to Manifold (parity)", () => {
  // 10x10 square, +1 sharp offset → 12x12; both backends should agree closely.
  const v = k.extrude({ profile: k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "sharp" }), h: 4 }).volume();
  expect(v).toBeCloseTo(144 * 4, -1);
});

test("chamfer is a true 45° bevel — area 142, identical to Manifold", () => {
  // Manifold pins the same 142 (single-chord round == OCCT bevel); this is the
  // cross-backend parity that the F3 follow-up (true-bevel Manifold chamfer) added.
  expect(k.shape2d(SQ(0, 0, 10)).offset(1, { corners: "chamfer" }).area()).toBeCloseTo(142, 3);
});

// --- Shape2D sugar (extrude / revolve / regions) ---

test("Shape2D.extrude({h}) equals k.extrude({profile, h})", () => {
  const viaSugar = k.shape2d(SQ(0, 0, 10)).extrude({ h: 4 });
  const viaKernel = k.extrude({ profile: k.shape2d(SQ(0, 0, 10)), h: 4 });
  expect(viaSugar.volume()).toBeCloseTo(400, -1);
  expect(viaSugar.volume()).toBeCloseTo(viaKernel.volume(), -1);
});

test("Shape2D.revolve({degrees}) equals k.revolve({profile})", () => {
  const viaSugar = k.shape2d(SQ(5, 0, 4)).revolve({ degrees: 360 });   // offset from the axis
  const viaKernel = k.revolve({ profile: k.shape2d(SQ(5, 0, 4)), degrees: 360 });
  expect(viaSugar.volume()).toBeGreaterThan(0);
  expect(viaSugar.volume()).toBeCloseTo(viaKernel.volume(), -1);
});

test("Shape2D.regions() splits disjoint regions into separate live Shape2Ds", () => {
  const disjoint = k.shape2d(SQ(0, 0, 10)).union(SQ(20, 0, 10));   // two separated squares
  const regions = disjoint.regions();
  expect(regions.length).toBe(2);
  for (const r of regions) { expect(r._shape2d).toBe(true); expect(r.area()).toBeCloseTo(100, 1); }
  expect(regions[0].union(regions[1]).area()).toBeCloseTo(200, 1);   // re-composable
});
