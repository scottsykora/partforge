// Rolling-ball corner wedges at two-chain junctions of the mesh fillet — the fix for
// "feature lines across the fillet band". At a salient outline corner, two blend tools
// used to cross in an overshot mitre; the groove where their surfaces intersect is a
// REAL crease (measured 76–90° dihedral), so the feature-line overlay faithfully drew a
// polyline ACROSS the blend band at every letter corner. The wedge replaces the mitre
// with the rolling-ball torus patch (a revolve of the same blend cross-section about
// the corner's axis — what OCCT's native fillet produces), the adjoining tools end
// flush at the corner instead of overshooting, and the band renders as a clean curve.
//
// Reflex (inner) corners keep the mitre overlap deliberately: there the rolling ball
// genuinely cannot reach into the corner and the two blend surfaces truly intersect —
// OCCT draws the same crease. Only salient corners get wedges.
//
// The line census runs the REAL render path — toMesh(), which is creased-normals plus
// the kernel's shading-policy registry. The registry matters now: blend surfaces keep
// their originalIDs (that is how the band's boundary rings draw), and only the BLEND
// policy tells the crease pass that their handover seams line-draw like one surface.
// The census window is strict-interior with a margin clear of both boundary rings, so
// it counts exactly the unwanted lines ACROSS the band.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const relErr = (v, expected) => Math.abs(v - expected) / Math.abs(expected);

function bandLines(solid, zTop, r) {
  const { edges } = solid.toMesh();
  const zLo = zTop - r + 0.05 * r, zHi = zTop - 0.05 * r;
  let n = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const inBand = (z) => z > zLo && z < zHi;
    if (inBand(edges[i + 2]) && inBand(edges[i + 5])) n++;
  }
  return n;
}

// straight-sided fixture with salient corners of mixed angles (40°, 90°, ~120°) —
// every corner is a line-line junction. OCCT's native fillet FAILS on this outline
// ("fillet(1) failed — feature skipped"), so the mesh path is the only kernel that
// can round this rim at all.
const arrow = () => {
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([i, 0]);
  for (let i = 1; i <= 20; i++) pts.push([20 - i * Math.cos((Math.PI * 40) / 180), i * Math.sin((Math.PI * 40) / 180)]);
  pts.push([-10, 18], [-10, 0]);
  return pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-9);
};

// sine-wavy square: planar-chain runs joined at four 90° salient corners.
const wavySquare = (L = 30, amp = 1.5, n = 24) => {
  const side = [];
  for (let i = 0; i < n; i++) side.push([(L * i) / n, amp * Math.sin((Math.PI * i) / n)]);
  const pts = [];
  for (const [c, s, ox, oy] of [[1, 0, 0, 0], [0, 1, L, 0], [-1, 0, L, L], [0, -1, 0, L]]) {
    for (const [x, y] of side) pts.push([ox + c * x - s * y, oy + s * x + c * y]);
  }
  return pts;
};

// rounded-rectangle outline whose corner arcs carry a deterministic ±6 µm radial
// wobble — the signature of an offset outline after simplify(): close enough to a
// circle to pass a loose circumcircle fit, far enough off one that an idealized
// revolve tool's tangent seams jitter in and out of the real rim the whole way
// around, drawing micro-facet lines along both band edges.
const wobblyRoundedRect = (W = 40, H = 30, R = 8, n = 24) => {
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= n; i++) {
      const th = a0 + (Math.PI / 2) * (i / n);
      const rr = R + 0.006 * Math.sin(9 * th + 1);
      pts.push([cx + rr * Math.cos(th), cy + rr * Math.sin(th)]);
    }
  };
  corner(W - R, H - R, 0);
  corner(R, H - R, Math.PI / 2);
  corner(R, R, Math.PI);
  corner(W - R, R, (3 * Math.PI) / 2);
  return pts;
};

describe("salient corners render as clean curves", () => {
  it("near-circular offset-style corners: the tool follows the real rim, not a fitted circle", () => {
    const out = k.extrude({ profile: wobblyRoundedRect(), h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    expect(bandLines(out, 8, 1)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });

  it("line-line corners: the arrow rim draws no lines across the blend band", () => {
    const out = k.extrude({ profile: arrow(), h: 5 }).fillet(1, { inPlane: "XY", at: 5 });
    expect(bandLines(out, 5, 1)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });

  it("planar-planar corners: the wavy-square rim draws no lines across the band", () => {
    const out = k.extrude({ profile: wavySquare(), h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    expect(bandLines(out, 8, 1)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });
});

describe("arc tools reach walls coarser than kernel tessellation", () => {
  it("a coarse polygonal rim draws no lines along the band edges", () => {
    // A 24-gon prism's rim points sit exactly on a circle (so the run classifies as an
    // arc chain), but its wall facets dip R·(1−cos(π/24)) ≈ 68 µm inside that circle —
    // twenty times deeper than the flank sagitta the revolve tool's tangent extension
    // assumed from kernel density. Where the extension failed to cross a facet, a
    // radial knife-fin of wall survived both cutters and drew a line along the band
    // (the label-backing bug, in miniature). The extension must be sized from the
    // chain's own polyline, not from an assumed tessellation.
    const n = 24, R = 8;
    const poly = [];
    for (let i = 0; i < n; i++) poly.push([R * Math.cos((2 * Math.PI * i) / n), R * Math.sin((2 * Math.PI * i) / n)]);
    const out = k.extrude({ profile: poly, h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    expect(bandLines(out, 8, 1)).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });
});

describe("wedge geometry matches the B-rep rolling ball", () => {
  it("box top rim: volume matches OCCT's native fillet (torus corners)", () => {
    // OCCT reference measured 2026-08-16 on this exact fixture:
    //   k.box({min:[0,0,0],max:[40,30,16]}).fillet(3, {inPlane:"XY", at:16})
    const out = k.box({ min: [0, 0, 0], max: [40, 30, 16] }).fillet(3, { inPlane: "XY", at: 16 });
    expect(relErr(out.volume(), 18939.956)).toBeLessThan(2e-3);
    expect(out.genus()).toBe(0);
  });

  it("single-chain selections keep today's exact behavior (no junction, no wedge)", () => {
    const W = 40, D = 30, H = 16, R = 3;
    const CORNER = (1 - Math.PI / 4) * R * R;
    const out = k.box({ min: [0, 0, 0], max: [W, D, H] }).fillet({ r: R, edges: { dir: "Z" } });
    expect(relErr(out.volume(), W * D * H - 4 * CORNER * H)).toBeLessThan(2e-3);
  });
});
