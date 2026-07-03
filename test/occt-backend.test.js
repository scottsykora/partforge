import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { assemblyOverlaps } from "../src/framework/assembly.js";
import { KERNEL_OPS, SOLID_OPS, SOLID_OPTIONAL_OPS } from "../src/framework/geometry/kernel.js";
import { roundedProfile, filletPolygon, circleProfile } from "../src/framework/geometry/polygon.js";
import planterPart from "../src/parts/planter.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); });

// Contract parity — the Manifold twin lives in kernel-contract.test.js (the two
// backends must never boot in one process, so each file checks its own side).
const publicKeys = (obj) => Object.keys(obj).filter((key) => !key.startsWith("_"));

test("OCCT kernel implements every required op and nothing undocumented", () => {
  const keys = publicKeys(k);
  for (const op of KERNEL_OPS) expect(keys, `kernel is missing ${op}`).toContain(op);
  const documented = new Set(KERNEL_OPS); // the optional cache brackets are Manifold-only
  expect(keys.filter((key) => !documented.has(key))).toEqual([]);
});

test("OCCT solid implements every required op and nothing undocumented", () => {
  const keys = publicKeys(k.box([0, 0, 0], [1, 1, 1]));
  for (const op of SOLID_OPS) expect(keys, `solid is missing ${op}`).toContain(op);
  const documented = new Set([...SOLID_OPS, ...SOLID_OPTIONAL_OPS]);
  expect(keys.filter((key) => !documented.has(key))).toEqual([]);
});

test("cylinder minus a bore meshes to a solid", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(drum.toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
});

test("intersect keeps only the overlapping volume of two solids", () => {
  // STEP export always builds on OCCT, so OCCT must implement every boolean a part may
  // use — including intersect (e.g. the planter clips its cavity with .intersect(box)).
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = k.box([5, 5, 5], [15, 15, 15]);
  expect(a.intersect(b).volume()).toBeCloseTo(125, 0); // the 5×5×5 overlap
});

test("intersect of disjoint solids is empty (volume 0) without throwing", () => {
  // assemblyOverlaps depends on this on OCCT: a non-overlapping pair must yield 0, not throw.
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = k.box([50, 50, 50], [60, 60, 60]); // far apart
  expect(a.intersect(b).volume()).toBeCloseTo(0, 5);
});

test("assemblyOverlaps runs on OCCT — clean for disjoint parts, flags a real overlap", () => {
  // Adding intersect to OCCT flips measure.js's canIntersect gate, so this overlap path now
  // runs on the OCCT kernel for the first time. Guard that it behaves: no throw on disjoint.
  const mk = (bx) => ({ defaults: {}, views: { v: {} }, parts: {
    a: { views: ["v"], build: (kk) => kk.box([0, 0, 0], [10, 10, 10]) },
    b: { views: ["v"], build: (kk) => kk.box([bx, 0, 0], [bx + 10, 10, 10]) },
  } });
  expect(assemblyOverlaps(k, mk(20), "v", {})).toEqual([]);   // disjoint → no overlaps
  const hit = assemblyOverlaps(k, mk(5), "v", {});            // 5-unit overlap on X
  expect(hit).toHaveLength(1);
  expect(hit[0].volume).toBeCloseTo(500, 0);                  // 5×10×10
});

test("a Manifold-routed part (planter) exports STEP via OCCT — every part gets all 3 formats", async () => {
  // Mirrors the export-step path in jobs.js: build the part fresh on OCCT, then toSTEP.
  // Regression: the planter uses .intersect(), which OCCT lacked, so STEP silently failed.
  const p = { ...planterPart.defaults };
  const d = planterPart.derive(p);
  const solid = planterPart.parts.planter.build(k, p, d);
  const step = await k.toSTEP([{ name: "planter", solid }]);
  expect(step.byteLength).toBeGreaterThan(1000);
  expect(new TextDecoder().decode(step.slice(0, 13))).toBe("ISO-10303-21;"); // STEP header
});

test("clone() lets the original survive a consuming transform", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const moved = a.clone().translate([20, 0, 0]); // consumes the clone, not `a`
  expect(a.volume()).toBeCloseTo(1000, 0);        // original still usable
  expect(moved.volume()).toBeCloseTo(1000, 0);
});

test("boundingBox reports size/center of a box (query does not consume)", () => {
  const b = k.box([0, 0, 0], [10, 20, 30]);
  const bb = b.boundingBox();
  expect(bb.size[0]).toBeCloseTo(10, 3);
  expect(bb.size[1]).toBeCloseTo(20, 3);
  expect(bb.size[2]).toBeCloseTo(30, 3);
  expect(bb.center[0]).toBeCloseTo(5, 3);
  expect(b.volume()).toBeCloseTo(6000, 0); // still usable after the query
});

test("sphere volume is ~4/3 pi r^3", () => {
  const r = 10;
  expect(k.sphere(r).volume()).toBeCloseTo((4 / 3) * Math.PI * r ** 3, -1);
});

test("revolve of a rectangular profile equals a cylinder volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  expect(k.revolve(rect).volume()).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve([[-1, 0], [10, 0], [10, 20]])).toThrow(/radius must be/);
});

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than straight", () => {
  const straight = k.prism(SQ, 10).volume();
  const taper = k.prism(SQ, 10, { scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism twist meshes to a positive-volume solid", () => {
  const tw = k.prism(SQ, 20, { twist: 90 });
  expect(tw.toMesh().triangles).toBeGreaterThan(0);
  expect(tw.volume()).toBeGreaterThan(0);
});

test("scale(2) multiplies volume ~8x", () => {
  const v1 = k.box([0, 0, 0], [2, 3, 4]).volume();
  const v2 = k.box([0, 0, 0], [2, 3, 4]).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 0);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).scale(0)).toThrow(/factor must be/);
});

// ── loft ──────────────────────────────────────────────────────────────────────
const LSQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("loft of two identical square rings equals a box volume", () => {
  const v = k.loft([{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }]).volume();
  expect(v).toBeCloseTo(10 * 10 * 10, -1); // 1000 mm³
});

test("loft of a scaled top ring is a frustum (analytic prismatoid volume)", () => {
  const v = k.loft([{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10, scale: 0.5 }]).volume();
  expect(v).toBeCloseTo((10 / 3) * (100 + 25 + 50), -1); // 583.3 mm³
});

test("loft rejects mismatched vertex counts (shared validation with Manifold)", () => {
  expect(() => k.loft([{ polygon: LSQ, z: 0 }, { polygon: [[0, 0], [5, 0], [5, 5], [0, 5], [0, 2]], z: 5 }]))
    .toThrow(/same number of points/);
});

test("loft closed:true loops are Manifold-only — OCCT throws a clear error", () => {
  expect(() => k.loft([{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 5 }], { closed: true }))
    .toThrow(/Manifold backend/);
});

// ── extrude (polygon-with-holes) ────────────────────────────────────────────────
const EOUT = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
const EHOLE = [[-3, -3], [3, -3], [3, 3], [-3, 3]];

test("extrude of a region with a hole removes the hole volume in one op", () => {
  const v = k.extrude({ outer: EOUT, holes: [EHOLE] }, 5).volume();
  expect(v).toBeCloseTo((20 * 20 - 6 * 6) * 5, -1); // 1820 mm³
});

test("extrude accepts a bare points array as outer-only", () => {
  expect(k.extrude(EOUT, 5).volume()).toBeCloseTo(20 * 20 * 5, -1);
});

test("extrude with a hole exports STEP (region-with-hole survives to B-rep)", async () => {
  const solid = k.extrude({ outer: EOUT, holes: [EHOLE] }, 5);
  const step = await k.toSTEP([{ name: "gasket", solid }]);
  expect(new TextDecoder().decode(step.slice(0, 13))).toBe("ISO-10303-21;");
});

// ── arc profiles (roundedProfile) — true B-rep CIRCLE fillets ────────────────────
const ASQ = (a) => [[-a / 2, -a / 2], [a / 2, -a / 2], [a / 2, a / 2], [-a / 2, a / 2]];
const stepText = async (solid) => new TextDecoder().decode(await k.toSTEP([{ name: "p", solid }]));

test("extrude(roundedProfile) matches the EXACT rounded-square volume (B-rep is not faceted)", () => {
  const a = 20, r = 4, hgt = 5;
  const analytic = (a * a - (4 - Math.PI) * r * r) * hgt; // exact fillets ⇒ exact area·h
  // This assertion FAILS if OCCT faceted the corners (faceted volume is smaller by ~0.02·r²·h).
  expect(k.extrude(roundedProfile(ASQ(a), r), hgt).volume()).toBeCloseTo(analytic, 3);
});

test("roundedProfile writes a true CIRCLE to STEP; filletPolygon (faceted) does not", async () => {
  const rounded = await stepText(k.extrude(roundedProfile(ASQ(20), 4), 5));
  expect(rounded).toMatch(/CIRCLE\s*\(/);                 // the whole point: true fillet survived to B-rep
  const faceted = await stepText(k.extrude(filletPolygon(ASQ(20), 4), 5));
  expect(faceted).not.toMatch(/CIRCLE\s*\(/);             // negative control: tessellated corners are LINEs
});

test("a rounded outer AND a rounded hole each contribute true CIRCLE edges to STEP", async () => {
  const solid = k.extrude({ outer: roundedProfile(ASQ(20), 4), holes: [roundedProfile(ASQ(6), 1)] }, 5);
  const text = await stepText(solid);
  expect((text.match(/CIRCLE\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(2); // outer + hole
});

test("prism(roundedProfile) also carries a true CIRCLE (outer-only arc region)", async () => {
  expect(await stepText(k.prism(roundedProfile(ASQ(20), 4), 5))).toMatch(/CIRCLE\s*\(/);
});

// ── sweep ───────────────────────────────────────────────────────────────────────
const SW = [[-3, -3], [3, -3], [3, 3], [-3, 3]]; // 6×6 square profile
const SL = 20;

test("a straight sweep equals an extrude of the same profile (both build the shared stations)", () => {
  expect(k.sweep(SW, [[0, 0, 0], [0, 0, SL]]).volume()).toBeCloseTo(6 * 6 * SL, -1); // 720
});

test("a 90° L-path is the true mitered elbow (2·w²·L) — same number the Manifold backend reports", () => {
  // Parity by construction: OCCT lofts the SAME stations the Manifold backend hand-meshes,
  // so both report the exact mitered-elbow volume 2·w²·L and the same mitered bbox.
  const elbow = k.sweep(SW, [[-SL, 0, 0], [0, 0, 0], [0, SL, 0]]);
  expect(elbow.volume()).toBeCloseTo(2 * 6 * 6 * SL, -1); // 1440
  const bb = elbow.boundingBox();
  expect(bb.min.map((v) => Math.round(v))).toEqual([-SL, -3, -3]);
  expect(bb.max.map((v) => Math.round(v))).toEqual([3, SL, 3]);
});

test("sweep closed:true loops are Manifold-only — OCCT throws a clear error", () => {
  expect(() => k.sweep(SW, [[0, 0, 0], [10, 0, 0]], { closed: true })).toThrow(/Manifold backend/);
});

test("sweep throws up front on a too-tight bend (same fold guard as Manifold)", () => {
  expect(() => k.sweep(SW, [[-3, 0, 0], [0, 0, 0], [0, 3, 0]])).toThrow(/too wide|too sharp/);
});

test("cornerRadius arc-fan (default non-smooth path) matches the Manifold arc-fan volume", () => {
  // Same inputs as the Manifold arc-fan case (manifold-backend.test.js "cornerRadius fillets
  // a bend into a smooth arc"): circleProfile(3) along an L-path with a 6 mm filleted corner.
  // The default (non-smooth) OCCT path lofts the SAME arc-fan stations Manifold hand-meshes,
  // so both report ~912.47 mm³ (parity by construction — verified 0.0000 rel diff vs Manifold).
  const s = k.sweep(circleProfile(3), [[0, 0, 0], [0, 0, 20], [15, 0, 20]], { cornerRadius: 6 });
  expect(s.volume()).toBeCloseTo(912.47, -1); // OCCT tolerance convention
});

test("smooth:true builds a native swept B-rep and exports STEP", async () => {
  const s = k.sweep(SW, [[0, 0, 0], [0, 0, 20], [15, 0, 20]], { cornerRadius: 5, smooth: true });
  expect(s.volume()).toBeGreaterThan(0);
  const step = await k.toSTEP([{ name: "hose", solid: s }]);
  expect(new TextDecoder().decode(step.slice(0, 13))).toBe("ISO-10303-21;");
});
