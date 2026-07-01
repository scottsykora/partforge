import { beforeAll, expect, test } from "vitest";
import { bboxSize } from "../src/testing/mesh.js";
import { circleProfile } from "../src/framework/geometry/polygon.js";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

test("bootManifoldKernel boots a ready kernel in one call", async () => {
  const kk = await bootManifoldKernel();
  const bb = kk.box([0, 0, 0], [2, 3, 4]).boundingBox();
  expect(bb.size).toEqual([2, 3, 4]);
});

test("cylinder minus a concentric bore removes volume", () => {
  const drum = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  const m = drum.toMesh();
  expect(m.triangles).toBeGreaterThan(0);
});

test("cutAll batch-subtracts every tool", () => {
  const base = k.cylinder(10, 10, 10);
  const holes = [k.cylinder(1, 1, 12).translate([5, 0, -1]), k.cylinder(1, 1, 12).translate([-5, 0, -1])];
  const out = base.cutAll(holes).toMesh();
  expect(out.triangles).toBeGreaterThan(0);
});

test("binary STL writes a real outward unit normal per facet (so viewers can light it)", async () => {
  // Zero facet normals print fine (slicers recompute from winding) but render
  // unlit in viewers that shade from the stored normal (macOS Preview/Quick Look).
  const stl = await k.cylinder(10, 10, 20).toSTL();
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

test("toSTEP throws (unsupported)", () => {
  expect(() => k.toSTEP([])).toThrow(/not supported/i);
});

test("Solid.rotate swaps X/Y extents for a 90° Z-axis rotation", () => {
  // Tall thin box: X-extent=2, Y-extent=10, Z-extent=30
  const box = k.box([0, 0, 0], [2, 10, 30]);
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
  expect(k.box([0, 0, 0], [10, 10, 10]).genus()).toBe(0);
  const tube = k.cylinder(10, 10, 20).cut(k.cylinder(4, 4, 30).translate([0, 0, -5]));
  expect(tube.genus()).toBe(1);
});

test("isEmpty is false for a real solid", () => {
  expect(k.box([0, 0, 0], [1, 1, 1]).isEmpty()).toBe(false);
});

test("clone() yields an independent usable solid", () => {
  const a = k.box([0, 0, 0], [10, 10, 10]);
  const b = a.clone().translate([20, 0, 0]);
  expect(a.volume()).toBeCloseTo(1000, 0);
  expect(b.volume()).toBeCloseTo(1000, 0);
});

test("boundingBox reports min/max/center/size of a box", () => {
  const bb = k.box([0, 0, 0], [10, 20, 30]).boundingBox();
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
  const v = k.revolve(rect).volume();
  expect(v).toBeCloseTo(Math.PI * 10 ** 2 * 20, -2); // within ~100mm³ (faceting)
});

test("a half revolve is about half the volume", () => {
  const rect = [[0, 0], [10, 0], [10, 20], [0, 20]];
  const full = k.revolve(rect).volume();
  const half = k.revolve(rect, { degrees: 180 }).volume();
  expect(half).toBeLessThan(full * 0.6);
  expect(half).toBeGreaterThan(full * 0.4);
});

test("revolve rejects a negative radius", () => {
  expect(() => k.revolve([[-1, 0], [10, 0], [10, 20]])).toThrow(/radius must be/);
});

test("revolve(circleProfile) yields a torus near the Pappus volume", () => {
  const majorR = 10, minorR = 2;
  const exact = 2 * Math.PI ** 2 * majorR * minorR ** 2; // Pappus: ~789.6 mm³
  const v = k.revolve(circleProfile(minorR, [majorR, 0])).volume();
  expect(v).toBeLessThan(exact);          // faceted ⇒ inscribed ⇒ slightly under
  expect(v).toBeGreaterThan(exact * 0.9); // but close
});

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];

test("prism scaleTop<1 tapers — less volume than a straight extrude", () => {
  const straight = k.prism(SQ, 10).volume();
  const taper = k.prism(SQ, 10, { scaleTop: 0.5 }).volume();
  expect(taper).toBeLessThan(straight);
  expect(taper).toBeGreaterThan(0);
});

test("prism scaleTop tapers uniformly — top shrinks equally in X and Y, not squished to a line", () => {
  // Regression: Manifold's extrude scaleTop is a Vec2; a scalar must be broadcast to
  // [s, s] or the top collapses in Y (X scales, Y → 0). Volume can't catch it (a wedge
  // loses volume too), so assert the top cross-section is a uniformly-scaled square.
  const pos = k.prism(SQ, 10, { scaleTop: 0.5 }).toMesh().positions;
  const xs = [], ys = [];
  for (let i = 0; i < pos.length; i += 3)
    if (Math.abs(pos[i + 2] - 10) < 0.5) { xs.push(pos[i]); ys.push(pos[i + 1]); }
  const span = (a) => Math.max(...a) - Math.min(...a);
  const xSpan = span(xs), ySpan = span(ys);
  expect(xSpan).toBeCloseTo(5, 1);     // 10-wide base × scaleTop 0.5
  expect(ySpan).toBeCloseTo(xSpan, 1); // uniform — was 0 before the broadcast fix
});

test("prism scaleTop:0 converges to a point (positive-volume cone)", () => {
  const cone = k.prism(SQ, 10, { scaleTop: 0 });
  expect(cone.volume()).toBeGreaterThan(0);
  expect(cone.toMesh().triangles).toBeGreaterThan(0);
});

test("prism twist keeps positive volume and full height", () => {
  const tw = k.prism(SQ, 20, { twist: 90 });
  expect(tw.volume()).toBeGreaterThan(0);
  const [, , ht] = bboxSize(tw.toMesh().positions);
  expect(ht).toBeCloseTo(20, 0);
});

test("prism rejects negative scaleTop", () => {
  expect(() => k.prism(SQ, 10, { scaleTop: -1 })).toThrow(/scaleTop/);
});

test("scale(2) multiplies volume ~8x (uniform 3D)", () => {
  const v1 = k.box([0, 0, 0], [2, 3, 4]).volume();
  const v2 = k.box([0, 0, 0], [2, 3, 4]).scale(2).volume();
  expect(v2).toBeCloseTo(v1 * 8, 1);
});

test("scale about the part's own center leaves the bbox center fixed", () => {
  const c = k.box([10, 10, 10], [14, 16, 18]).boundingBox().center; // off-origin
  const c2 = k.box([10, 10, 10], [14, 16, 18]).scale(2, c).boundingBox().center;
  for (let i = 0; i < 3; i++) expect(c2[i]).toBeCloseTo(c[i], 3);
});

test("scale rejects factor <= 0", () => {
  expect(() => k.box([0, 0, 0], [1, 1, 1]).scale(0)).toThrow(/factor must be/);
});
