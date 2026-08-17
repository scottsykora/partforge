// Reflex (inside) rim corners of the mesh fillet — the cloud "artifacts" bug
// (label part 0d47960f): at a sharp reflex corner of a planar rim, the blend tools
// used to end flush (0.05·r anti-graze overshoot only), so a wedge of the original
// rim survived both cutters and the top face kept a point AT the corner. The fix is
// the rolling-ball pivot: the ball swings about the corner's face-normal axis while
// touching the face and the vertical corner edge, sweeping a horn-torus patch. The
// top face's inner boundary at such a corner is therefore an ARC of radius r about
// the vertex — the "nice rounded inside curve" — never a point at the vertex.
//
// Fixtures cover both code paths:
//   - L-shape: straight edges → line chains → the two-chain junction path
//     (roundSalientCorners' reflex counterpart).
//   - union of two discs: arc chains, planarized and stitched into one closed
//     planar chain → planarTool's split-vertex path.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// Top-face boundary points (z == zTop) of a non-indexed toMesh(), by position key.
function topBoundary(solid, zTop) {
  const { positions: pos, triangles: nTri } = solid.toMesh();
  const edgeCount = new Map();
  const pk = (x, y) => x.toFixed(5) + "," + y.toFixed(5);
  const ek = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
  for (let t = 0; t < nTri; t++) {
    const o = t * 9;
    const zs = [pos[o + 2], pos[o + 5], pos[o + 8]];
    if (!zs.every((z) => Math.abs(z - zTop) < 1e-4)) continue;
    const ks = [pk(pos[o], pos[o + 1]), pk(pos[o + 3], pos[o + 4]), pk(pos[o + 6], pos[o + 7])];
    for (let e = 0; e < 3; e++) {
      const kk = ek(ks[e], ks[(e + 1) % 3]);
      edgeCount.set(kk, (edgeCount.get(kk) ?? 0) + 1);
    }
  }
  const bpts = new Set();
  for (const [kk, c] of edgeCount) if (c === 1) for (const p of kk.split("|")) bpts.add(p);
  return [...bpts].map((s) => s.split(",").map(Number));
}

const distancesFrom = (pts, [cx, cy], within) =>
  pts.map(([x, y]) => Math.hypot(x - cx, y - cy)).filter((d) => d < within);

describe("mesh fillet at reflex rim corners", () => {
  const H = 2.5, R = 0.3;

  it("L-shape (line-chain junction): top boundary is an arc of radius r about the reflex vertex", () => {
    const profile = k.shape2d([[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]);
    const solid = profile.extrude({ h: H });
    const out = solid.fillet({ r: R, edges: { inPlane: "XY", at: H } });
    expect(out.genus()).toBe(solid.genus());

    const near = distancesFrom(topBoundary(out, H), [10, 10], 3 * R);
    expect(near.length).toBeGreaterThan(2);
    // no boundary point closer to the vertex than the ball radius (the old bug left
    // a point essentially AT the vertex, distance ≈ 0.05·r)
    expect(Math.min(...near)).toBeGreaterThan(0.95 * R);
    // the pivot arc: the mid-wedge boundary sits AT radius r (tessellation slack)
    const mid = topBoundary(out, H).filter(([x, y]) => {
      const th = Math.atan2(y - 10, x - 10); // wedge spans azimuths 180°..270°
      return th > -Math.PI * 0.7 && th < -Math.PI * 0.3 && Math.hypot(x - 10, y - 10) < 3 * R;
    });
    expect(mid.length).toBeGreaterThan(0);
    for (const [x, y] of mid) expect(Math.hypot(x - 10, y - 10)).toBeCloseTo(R, 1);
  });

  it("union of two discs (planar split path): junction keeps no point, gains the arc", () => {
    const circle = (r, cx, n = 96) => {
      const pts = [];
      for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; pts.push([cx + r * Math.cos(t), r * Math.sin(t)]); }
      return pts;
    };
    const profile = k.shape2d(circle(8, -5)).union(k.shape2d(circle(8, 5)));
    const solid = profile.extrude({ h: H });
    const out = solid.fillet({ r: R, edges: { inPlane: "XY", at: H } });
    expect(out.genus()).toBe(solid.genus());

    const yJ = Math.sqrt(64 - 25); // junction vertex (0, ±6.245)
    const bnd = topBoundary(out, H);
    for (const vy of [yJ, -yJ]) {
      const near = distancesFrom(bnd, [0, vy], 2.5 * R);
      expect(near.length).toBeGreaterThan(2);
      expect(Math.min(...near)).toBeGreaterThan(0.9 * R);
    }
  });

  it("chamfer at a reflex corner: cone pivot, no point at the vertex", () => {
    const profile = k.shape2d([[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]]);
    const solid = profile.extrude({ h: H });
    const out = solid.chamfer({ d: R, edges: { inPlane: "XY", at: H } });
    expect(out.genus()).toBe(solid.genus());
    const near = distancesFrom(topBoundary(out, H), [10, 10], 3 * R);
    expect(near.length).toBeGreaterThan(2);
    expect(Math.min(...near)).toBeGreaterThan(0.95 * R);
  });
});
