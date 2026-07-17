import { beforeAll, expect, test } from "vitest";
import { bboxSize } from "../src/testing/mesh.js";
import { circleProfile, regularPolygon, filletPolygon, roundedProfile } from "../src/framework/geometry/polygon.js";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("bootManifoldKernel boots a ready kernel in one call", async () => {
  const kk = await bootManifoldKernel();
  const bb = kk.box({ min: [0, 0, 0], max: [2, 3, 4] }).boundingBox();
  expect(bb.size).toEqual([2, 3, 4]);
});

test("cylinder minus a concentric bore removes volume", () => {
  const drum = k.cylinder({ r: 10, h: 20 }).cut(k.cylinder({ r: 4, h: 30 }).translate([0, 0, -5]));
  const m = drum.toMesh();
  expect(m.triangles).toBeGreaterThan(0);
});

test("cutAll batch-subtracts every tool", () => {
  const base = k.cylinder({ r: 10, h: 10 });
  const holes = [k.cylinder({ r: 1, h: 12 }).translate([5, 0, -1]), k.cylinder({ r: 1, h: 12 }).translate([-5, 0, -1])];
  const out = base.cutAll(holes).toMesh();
  expect(out.triangles).toBeGreaterThan(0);
});

test("binary STL writes a real outward unit normal per facet (so viewers can light it)", async () => {
  // Zero facet normals print fine (slicers recompute from winding) but render
  // unlit in viewers that shade from the stored normal (macOS Preview/Quick Look).
  const stl = await k.cylinder({ r: 10, h: 20 }).toSTL();
  const dv = new DataView(stl);
  const n = dv.getUint32(80, true);
  expect(n).toBeGreaterThan(0);
  const f = (off) => dv.getFloat32(off, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const nrm = [f(o), f(o + 4), f(o + 8)];
    expect(Math.hypot(...nrm)).toBeCloseTo(1, 3); // non-zero, unit length
    // and it points the same way as the facet's geometric normal (winding-derived)
    const v = (j) => [f(o + 12 + j * 12), f(o + 16 + j * 12), f(o + 20 + j * 12)];
    const [a, b, c] = [v(0), v(1), v(2)];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const g = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const gl = Math.hypot(...g) || 1;
    const dot = nrm[0] * (g[0] / gl) + nrm[1] * (g[1] / gl) + nrm[2] * (g[2] / gl);
    expect(dot).toBeGreaterThan(0.99);
  }
});

test("toSTEP throws (OCCT-only capability)", () => {
  expect(() => k.toSTEP([])).toThrow(/requires the OCCT backend/);
});

test("Solid.rotate swaps X/Y extents for a 90° Z-axis rotation", () => {
  // Tall thin box: X-extent=2, Y-extent=10, Z-extent=30
  const box = k.box({ min: [0, 0, 0], max: [2, 10, 30] });
  const rotated = box.rotate(90, [0, 0, 0], [0, 0, 1]);
  const rm = rotated.toMesh();
  expect(rm.triangles).toBeGreaterThan(0);
  const [rx, ry, rz] = bboxSize(rm.positions);
  // After 90° Z-rotation: original X-extent (2) becomes Y; original Y-extent (10) becomes X
  expect(rx).toBeCloseTo(10, 1);
  expect(ry).toBeCloseTo(2, 1);
  expect(rz).toBeCloseTo(30, 1);
});

test("genus is 0 for a solid box and 1 for a through-bored tube", () => {
  expect(k.box({ min: [0, 0, 0], max: [10, 10, 10] }).genus()).toBe(0);
  const tube = k.cylinder({ r: 10, h: 20 }).cut(k.cylinder({ r: 4, h: 30 }).translate([0, 0, -5]));
  expect(tube.genus()).toBe(1);
});

test("isEmpty is false for a real solid", () => {
  expect(k.box({ min: [0, 0, 0], max: [1, 1, 1] }).isEmpty()).toBe(false);
});

test("clone() yields an independent usable solid", () => {
  const a = k.box({ min: [0, 0, 0], max: [10, 10, 10] });
  const b = a.clone().translate([20, 0, 0]);
  expect(a.volume()).toBeCloseTo(1000, 0);
  expect(b.volume()).toBeCloseTo(1000, 0);
});

test("boundingBox reports min/max/center/size of a box", () => {
  const bb = k.box({ min: [0, 0, 0], max: [10, 20, 30] }).boundingBox();
  expect(bb.min).toEqual([0, 0, 0]);
  expect(bb.max[0]).toBeCloseTo(10, 6);
  expect(bb.max[1]).toBeCloseTo(20, 6);
  expect(bb.max[2]).toBeCloseTo(30, 6);
  expect(bb.center).toEqual([5, 10, 15]);
  expect(bb.size).toEqual([10, 20, 30]);
});

test("sphere volume is ~4/3 pi r^3", () => {
  const r = 10;
  const v = k.sphere(r).volume();
  expect(v).toBeCloseTo((4 / 3) * Math.PI * r ** 3, -2); // within ~50mm³ (faceting at 116 segs gives ~7mm³ error)
});

test("revolve of a rectangular profile equals a cylinder volume", () => {
  // profile r in [0,10], z in [0,20] → solid cylinder r=10 h=20
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const v = k.revolve({ profile: rect }).volume();
  expect(v).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2); // within ~100mm³ (faceting)
});

test("a half revolve is about half the volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const full = k.revolve({ profile: rect }).volume();
  const half = k.revolve({ profile: rect, degrees: 180 }).volume();
  expect(half).toBeLessThan(full * 0.6);
  expect(half).toBeGreaterThan(full * 0.4);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve({ profile: [[-1, 0], [10, 0], [10, 20]] })).toThrow(/radius must be/);
});

test("revolve(circleProfile) yields a torus near the Pappus volume", () => {
  const majorR = 10, minorR = 2;
  const exact = 2 * Math.PI ** 2 * majorR * minorR ** 2; // Pappus: ~789.6 mm³
  const v = k.revolve({ profile: circleProfile(minorR, [majorR, 0]) }).volume();
  expect(v).toBeLessThan(exact);          // faceted ⇒ inscribed ⇒ slightly under
  expect(v).toBeGreaterThan(exact * 0.9); // but close
});

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than a straight extrude", () => {
  const straight = k.prism({ points: SQ, h: 10 }).volume();
  const taper = k.prism({ points: SQ, h: 10, scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism scaleTop tapers uniformly — top shrinks equally in X and Y, not squished to a line", () => {
  // Regression: Manifold's extrude scaleTop is a Vec2; a scalar must be broadcast to
  // [s, s] or the top collapses in Y (X scales, Y → 0). Volume can't catch it (a wedge
  // loses volume too), so assert the top cross-section is a uniformly-scaled square.
  const pos = k.prism({ points: SQ, h: 10, scaleTop: 0.5 }).toMesh().positions;
  const xs = [], ys = [];
  for (let i = 0; i < pos.length; i += 3)
    if (Math.abs(pos[i + 2] - 10) < 0.5) { xs.push(pos[i]); ys.push(pos[i + 1]); }
  const span = (a) => Math.max(...a) - Math.min(...a);
  const xSpan = span(xs), ySpan = span(ys);
  expect(xSpan).toBeCloseTo(5, 1);     // 10-wide base × scaleTop 0.5
  expect(ySpan).toBeCloseTo(xSpan, 1); // uniform — was 0 before the broadcast fix
});

test("prism scaleTop:0 converges to a point (positive-volume cone)", () => {
  const cone = k.prism({ points: SQ, h: 10, scaleTop: 0 });
  expect(cone.volume()).toBeGreaterThan(0);
  expect(cone.toMesh().triangles).toBeGreaterThan(0);
});

test("prism twist keeps positive volume and full height", () => {
  const tw = k.prism({ points: SQ, h: 20, twist: 90 });
  expect(tw.volume()).toBeGreaterThan(0);
  const [, , ht] = bboxSize(tw.toMesh().positions);
  expect(ht).toBeCloseTo(20, 0);
});

test("prism rejects negative scaleTop", () => {
  expect(() => k.prism({ points: SQ, h: 10, scaleTop: -1 })).toThrow(/scaleTop/);
});

test("scale(2) multiplies volume ~8x (uniform 3D)", () => {
  const v1 = k.box({ min: [0, 0, 0], max: [2, 3, 4] }).volume();
  const v2 = k.box({ min: [0, 0, 0], max: [2, 3, 4] }).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 1);
});

test("scale about the part's own center leaves the bbox center fixed", () => {
  const c = k.box({ min: [10, 10, 10], max: [14, 16, 18] }).boundingBox().center; // off-origin
  const c2 = k.box({ min: [10, 10, 10], max: [14, 16, 18] }).scale(2, c).boundingBox().center;
  for (let i = 0; i < 3; i++) expect(c2[i]).toBeCloseTo(c[i], 3);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box({ min: [0, 0, 0], max: [1, 1, 1] }).scale(0)).toThrow(/factor must be/);
});

// ── loft ──────────────────────────────────────────────────────────────────────
const LSQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("loft of two identical square rings equals a box volume", () => {
  const v = k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }] }).volume();
  expect(v).toBeCloseTo(10 * 10 * 10, -2); // 10×10 square × height 10 = 1000 mm³
});

test("loft reports the stacked bounding box (rings' XY extent × z span)", () => {
  const bb = k.loft({ rings: [{ polygon: LSQ, z: 2 }, { polygon: LSQ, z: 12 }] }).boundingBox();
  expect(bb.size).toEqual([10, 10, 10]);
  expect(bb.min[2]).toBeCloseTo(2, 6);
});

test("loft accepts the sides+radius ring shorthand (regular n-gon rings)", () => {
  const shorthand = k.loft({ rings: [{ sides: 6, radius: 10, z: 0 }, { sides: 6, radius: 10, z: 8 }] }).volume();
  const explicit = k.loft({ rings: [{ polygon: regularPolygon(6, 10), z: 0 }, { polygon: regularPolygon(6, 10), z: 8 }] }).volume();
  expect(shorthand).toBeCloseTo(explicit, 5);
});

test("a twisted multi-ring loft has ~the same volume as the untwisted one (continuous twist ≈ prism)", () => {
  const steps = 24, hex = regularPolygon(6, 10);
  const straight = [], twisted = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    straight.push({ polygon: hex, z: 20 * t });
    twisted.push({ sides: 6, radius: 10, z: 20 * t, rotate: 60 * t }); // one full facet over the height
  }
  const vs = k.loft({ rings: straight }).volume(), vt = k.loft({ rings: twisted }).volume();
  expect(vt).toBeGreaterThan(vs * 0.97); // ruled segments pinch a hair, but stay within ~2%
  expect(vt).toBeLessThan(vs * 1.01);
});

test("a scaled top ring makes a frustum (analytic prismatoid volume)", () => {
  const v = k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10, scale: 0.5 }] }).volume();
  expect(v).toBeCloseTo((10 / 3) * (100 + 25 + 50), -1); // base 10×10, top 5×5: 583.3 mm³
});

test("loft rejects fewer than 2 rings, a missing z, and mismatched vertex counts", () => {
  expect(() => k.loft({ rings: [{ polygon: LSQ, z: 0 }] })).toThrow(/at least 2/);
  expect(() => k.loft({ rings: [{ polygon: LSQ }, { polygon: LSQ, z: 5 }] })).toThrow(/finite z/);
  expect(() => k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: regularPolygon(6, 5), z: 5 }] })).toThrow(/same number of points/);
});

test("loft is a single atomic cache node, and its hash folds every ring's transform", () => {
  k.resetCacheStats();
  k.beginSubPart("a"); k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }] }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(1); // one node, not its internal mesh ops
  k.resetCacheStats();
  k.beginSubPart("a"); k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }] }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 }); // identical build reused
  // a shape-affecting change (a ring's rotate) must change the hash
  const a = k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }] });
  const b = k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10, rotate: 15 }] });
  expect(a._hash).not.toBe(b._hash);
  expect(a._hash).toBe(k.loft({ rings: [{ polygon: LSQ, z: 0 }, { polygon: LSQ, z: 10 }] })._hash); // deterministic
});

// ── extrude (polygon-with-holes) ────────────────────────────────────────────────
const EOUT = [[-10, -10], [10, -10], [10, 10], [-10, 10]]; // 20×20
const EHOLE = [[-3, -3], [3, -3], [3, 3], [-3, 3]];        // 6×6

test("extrude of a region with a hole removes the hole volume in one op", () => {
  const v = k.extrude({ profile: { outer: EOUT, holes: [EHOLE] }, h: 5 }).volume();
  expect(v).toBeCloseTo((20 * 20 - 6 * 6) * 5, -2); // (400−36)×5 = 1820 mm³
  expect(k.extrude({ profile: { outer: EOUT, holes: [EHOLE] }, h: 5 }).genus()).toBe(1); // a real through-hole
});

test("extrude accepts a bare points array as outer-only (equals { outer })", () => {
  expect(k.extrude({ profile: EOUT, h: 5 }).volume()).toBeCloseTo(k.extrude({ profile: { outer: EOUT }, h: 5 }).volume(), 5);
  expect(k.extrude({ profile: EOUT, h: 5 }).volume()).toBeCloseTo(20 * 20 * 5, -2);
});

test("extrude composes with filletPolygon (rounded outer + hole) into a positive solid", () => {
  const s = k.extrude({ profile: { outer: filletPolygon(EOUT, 3), holes: [EHOLE] }, h: 5 });
  expect(s.volume()).toBeGreaterThan(0);
  expect(s.volume()).toBeLessThan(20 * 20 * 5); // rounded corners + hole ⇒ less than the full block
});

test("extrude rejects negative scaleTop and a degenerate outer", () => {
  expect(() => k.extrude({ profile: EOUT, h: 5, scaleTop: -1 })).toThrow(/scaleTop/);
  expect(() => k.extrude({ profile: [[0, 0], [1, 1]], h: 5 })).toThrow(/≥3 points/);
});

test("extrude hash folds twist (tessellation-affecting) — a twisted region differs from a straight one", () => {
  const a = k.extrude({ profile: EOUT, h: 5 });
  const b = k.extrude({ profile: EOUT, h: 5, twist: 45 });
  expect(a._hash).not.toBe(b._hash);
});

// ── arc profiles (roundedProfile) ───────────────────────────────────────────────
const ASQ = (a) => [[-a / 2, -a / 2], [a / 2, -a / 2], [a / 2, a / 2], [-a / 2, a / 2]];

test("extrude(roundedProfile) hits the rounded-square volume, inscribed and below the sharp block", () => {
  const a = 20, r = 4, hgt = 5;
  const analytic = (a * a - (4 - Math.PI) * r * r) * hgt; // (a²−(4−π)r²)·h
  const v = k.extrude({ profile: roundedProfile(ASQ(a), r), h: hgt }).volume();
  expect(v).toBeLessThanOrEqual(analytic + 1e-6);         // tessellation inscribes the true arc
  expect(v).toBeCloseTo(analytic, -1);                    // and is close (loose preview tolerance)
  expect(v).toBeLessThan(a * a * hgt);                    // rounded ⇒ less than the sharp block
});

test("extrude(roundedProfile) converges up toward the analytic volume vs a coarse filletPolygon", () => {
  const a = 20, r = 4, hgt = 5;
  const analytic = (a * a - (4 - Math.PI) * r * r) * hgt;
  const arcV = k.extrude({ profile: roundedProfile(ASQ(a), r), h: hgt }).volume();
  const facetV = k.extrude({ profile: filletPolygon(ASQ(a), r), h: hgt }).volume(); // fixed segs=8 corners
  expect(analytic - arcV).toBeLessThan(analytic - facetV);          // arc path is closer to truth
});

test("extrude(roundedProfile) with a rounded hole is a genus-1 solid", () => {
  const s = k.extrude({ profile: { outer: roundedProfile(ASQ(20), 4), holes: [roundedProfile(ASQ(6), 1)] }, h: 5 });
  expect(s.genus()).toBe(1);
  expect(s.volume()).toBeGreaterThan(0);
});

test("prism(roundedProfile) rounds an outer-only region (equals the same-area extrude)", () => {
  const a = 20, r = 4, hgt = 5;
  expect(k.prism({ points: roundedProfile(ASQ(a), r), h: hgt }).volume())
    .toBeCloseTo(k.extrude({ profile: roundedProfile(ASQ(a), r), h: hgt }).volume(), 3);
});

test("extrude hash folds the arc spec AND the segs quality (no preview geometry served to print)", () => {
  const sharp = k.extrude({ profile: ASQ(20), h: 5 });
  const rounded = k.extrude({ profile: roundedProfile(ASQ(20), 4), h: 5 });
  expect(sharp._hash).not.toBe(rounded._hash);            // arc spec changes the key
  const r2 = k.extrude({ profile: roundedProfile(ASQ(20), 2), h: 5 });
  expect(rounded._hash).not.toBe(r2._hash);               // a different radius is a fresh node
  expect(rounded._hash).toBe(k.extrude({ profile: roundedProfile(ASQ(20), 4), h: 5 })._hash); // deterministic
});

// ── sweep ───────────────────────────────────────────────────────────────────────
const W = 6;
const SW = [[-W / 2, -W / 2], [W / 2, -W / 2], [W / 2, W / 2], [-W / 2, W / 2]]; // W×W square profile
const SL = 20;

test("a straight single-segment sweep equals an extrude of the same profile (volume AND bbox)", () => {
  const swept = k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL]] });
  expect(swept.volume()).toBeCloseTo(W * W * SL, -2);       // 6×6×20 = 720
  expect(swept.volume()).toBeCloseTo(k.extrude({ profile: SW, h: SL }).volume(), -2);
  expect(swept.boundingBox().size).toEqual(k.extrude({ profile: SW, h: SL }).boundingBox().size);
});

test("a sweep along a non-axis diagonal scales the caps correctly (√3·a length)", () => {
  const a = 10;
  expect(k.sweep({ profile: SW, path: [[0, 0, 0], [a, a, a]] }).volume()).toBeCloseTo(W * W * Math.sqrt(3) * a, 0); // broken seed frame would mis-scale
});

test("a 90° L-path is a true mitered elbow: volume 2·w²·L and the mitered bbox", () => {
  // A true miter terminates each leg at the bisecting plane, so the elbow volume is exactly
  // 2·w²·L (the two legs partition space across the miter — no overlap, no gap). This is the
  // real mitered-elbow volume; it is NOT the union of two square-corner prisms (2w²L − w³/4).
  const elbow = k.sweep({ profile: SW, path: [[-SL, 0, 0], [0, 0, 0], [0, SL, 0]] });
  expect(elbow.volume()).toBeCloseTo(2 * W * W * SL, -1);   // 1440
  const bb = elbow.boundingBox();
  expect(bb.min).toEqual([-SL, -W / 2, -W / 2]);            // outer corner reaches +w/2 in x and y
  expect(bb.max).toEqual([W / 2, SL, W / 2]);
  expect(elbow.genus()).toBe(0);                           // open sweep → no through-hole
});

test("a planar circular-arc path matches the analytic torus-sector volume (Pappus) and converges", () => {
  const R = 20, r = 2, alpha = Math.PI;                     // half torus centerline
  const analytic = Math.PI * r * r * (R * alpha);           // Pappus: πr²·(Rα)
  const arcPath = (M) => Array.from({ length: M + 1 }, (_, i) => {
    const t = (alpha * i) / M; return [R * Math.cos(t), R * Math.sin(t), 0];
  });
  const coarse = k.sweep({ profile: circleProfile(r), path: arcPath(24) }).volume();
  const fine = k.sweep({ profile: circleProfile(r), path: arcPath(96) }).volume();
  expect(Math.abs(fine - analytic) / analytic).toBeLessThan(0.05);        // within 5% of analytic
  expect(Math.abs(fine - analytic)).toBeLessThan(Math.abs(coarse - analytic)); // finer sampling → closer
});

test("a closed square-loop path is a genus-1 picture frame", () => {
  const R = 20;
  const loop = [[-R, -R, 0], [R, -R, 0], [R, R, 0], [-R, R, 0]];
  const frame = k.sweep({ profile: SW, path: loop, closed: true });
  expect(frame.genus()).toBe(1);                           // a loop with a hole
  expect(frame.volume()).toBeGreaterThan(0);
});

test("cornerRadius fillets a bend into a smooth arc (positive-volume, watertight solid)", () => {
  const s = k.sweep({ profile: circleProfile(3), path: [[0, 0, 0], [0, 0, 20], [15, 0, 20]], cornerRadius: 6 });
  expect(s.volume()).toBeGreaterThan(0);
  expect(s.genus()).toBe(0);
});

test("sweep is a single atomic cache node whose hash folds the path/profile/opts", () => {
  k.resetCacheStats();
  k.beginSubPart("a"); k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL]] }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats().misses).toBe(1);
  k.resetCacheStats();
  k.beginSubPart("a"); k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL]] }).toMesh(); k.endSubPart(); k.cleanup();
  expect(k.cacheStats()).toEqual({ hits: 1, misses: 0 });  // identical build reused
  const base = k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL]] });
  expect(base._hash).not.toBe(k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL + 1]] })._hash);            // path change
  expect(base._hash).not.toBe(k.sweep({ profile: SW, path: [[-SL, 0, 0], [0, 0, 0], [0, SL, 0]], cornerRadius: 6 })._hash); // opts change
  expect(base._hash).toBe(k.sweep({ profile: SW, path: [[0, 0, 0], [0, 0, SL]] })._hash);                    // deterministic
});

test("sweep throws up front on a fold (too-tight bend) rather than shipping bad geometry", () => {
  expect(() => k.sweep({ profile: SW, path: [[-3, 0, 0], [0, 0, 0], [0, 3, 0]] })).toThrow(/too wide|too sharp/);
});
