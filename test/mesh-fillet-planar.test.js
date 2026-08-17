// Mesh fillet/chamfer on PLANAR CONTOUR chains — top/bottom rims of extruded profiles
// whose outlines are neither straight nor circular (text, offset outlines, splines).
// These used to throw UnsupportedEdgeError ("edge curve is not circular") and reroute
// the whole sub-part to OCCT; they now blend natively by sweeping the same 2-D
// cross-section profile the prism/revolve tools use along the chain's own polyline
// (k.sweep), splitting at vertices where the sweep's miter would fold.
//
// Ground truth is analytic, same conventions as test/mesh-fillet.test.js:
//   fillet removes (1 − π/4)·r² per unit length of convex rim (adds it on concave),
//   chamfer removes d²/2 per unit length. Wavy-contour curvature corrections integrate
//   to ~2π·x̄·r·A over a closed loop — a few percent here — so tolerances are loose
//   enough to absorb them and tight enough to catch a missing stretch.
//
// Closure is asserted via genus(), NOT the structural 1e-6-weld watertight check the
// box fixtures use, and the reason is the precedent expectSmallCircularBlends already
// set: Manifold's MeshGL positions are Float32Array, so at these coordinates (~10-20 mm)
// the representable grid is ~1.4e-6 — COARSER than a 1e-6 weld. Any boolean over
// geometry that is not float32-exact (every wavy contour here) legitimately produces
// distinct vertices closer than the weld grid along tangency curves, which that check
// mis-reads as non-manifold. genus() asks Manifold itself, which owns vertex identity.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { detectSharpEdges, chainEdges } from "../src/framework/geometry/mesh-fillet.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const CORNER = (r) => (1 - Math.PI / 4) * r * r;
const relErr = (v, expected) => Math.abs(v - expected) / Math.abs(expected);

const perimeter = (pts) => {
  let L = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
};

// A wavy, decidedly non-circular closed contour — smooth everywhere (no sharp corners).
const blob = (scale = 1, n = 72) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const rr = scale * (20 + 4 * Math.sin(3 * th) + 2 * Math.cos(5 * th));
    pts.push([rr * Math.cos(th), rr * Math.sin(th)]);
  }
  return pts;
};

// A square with sine-wavy sides: four genuinely sharp 90°-ish corners joined by smooth
// non-circular runs — the chain must SPLIT there rather than fold or reroute.
const wavySquare = (L = 30, amp = 1.5, n = 24) => {
  const side = [];
  for (let i = 0; i < n; i++) {
    const x = (L * i) / n;
    side.push([x, amp * Math.sin((Math.PI * i) / n)]);
  }
  const pts = [];
  for (const [c, s, ox, oy] of [[1, 0, 0, 0], [0, 1, L, 0], [-1, 0, L, L], [0, -1, 0, L]]) {
    for (const [x, y] of side) pts.push([ox + c * x - s * y, oy + s * x + c * y]);
  }
  return pts;
};

describe("chain classification", () => {
  it("classifies a wavy extrusion's rims as planar/line chains, never unsupported", () => {
    const solid = k.extrude({ profile: blob(), h: 6 });
    const chains = chainEdges(detectSharpEdges(solid.toIndexedMesh()));
    expect(chains.some((c) => c.kind === "unsupported")).toBe(false);
    const planar = chains.filter((c) => c.kind === "planar");
    expect(planar.length).toBeGreaterThan(0);
    for (const ch of planar) expect(Math.abs(ch.w[2])).toBeGreaterThan(0.999);
  });
});

describe("planar rim fillet", () => {
  it("fillets the top rim of a wavy extrusion (previously NEEDS_OCCT)", () => {
    const H = 6, R = 1.2;
    const pts = blob();
    const solid = k.extrude({ profile: pts, h: H });
    const out = solid.fillet(R, { inPlane: "XY", at: H });
    const removed = solid.volume() - out.volume();
    expect(relErr(removed, CORNER(R) * perimeter(pts))).toBeLessThan(0.05);
    expect(out.genus()).toBe(0);
  });

  it("chamfers the same rim at d²/2 per unit length", () => {
    const H = 6, D = 1;
    const pts = blob();
    const solid = k.extrude({ profile: pts, h: H });
    const out = solid.chamfer(D, { inPlane: "XY", at: H });
    const removed = solid.volume() - out.volume();
    expect(relErr(removed, (D * D / 2) * perimeter(pts))).toBeLessThan(0.05);
    expect(out.genus()).toBe(0);
  });

  it("splits at sharp corners: wavy-square rim fillets clean", () => {
    const H = 8, R = 1;
    const pts = wavySquare();
    const solid = k.extrude({ profile: pts, h: H });
    const out = solid.fillet(R, { inPlane: "XY", at: H });
    const removed = solid.volume() - out.volume();
    expect(relErr(removed, CORNER(R) * perimeter(pts))).toBeLessThan(0.08);
    expect(out.genus()).toBe(0);
  });

  it("fills a concave planar rim (boss base bead) and cuts the plate rim in one apply", () => {
    const R = 1;
    const boss = k.extrude({ profile: blob(0.5), h: 6 });
    const plate = k.box({ min: [-20, -20, -5], max: [20, 20, 0] });
    const solid = plate.union(boss);
    const out = solid.fillet(R, { inPlane: "XY", at: 0 });
    // added: concave bead along the boss base; removed: the plate's own square rim
    const bead = CORNER(R) * perimeter(blob(0.5));
    const cut = CORNER(R) * 4 * 40;
    expect(relErr(out.volume() - solid.volume(), bead - cut)).toBeLessThan(0.08);
    expect(out.genus()).toBe(0);
  });

  it("handles rims in an arbitrary plane: rotating the solid changes nothing", () => {
    const H = 6, R = 1.2;
    const solid = k.extrude({ profile: blob(), h: H });
    const removedFlat = solid.volume() - solid.fillet(R).volume();
    const tilted = solid.rotateAbout({ axis: [1, 0, 0], deg: 30 });
    const removedTilted = tilted.volume() - tilted.fillet(R).volume();
    expect(relErr(removedTilted, removedFlat)).toBeLessThan(0.005);
  });
});
