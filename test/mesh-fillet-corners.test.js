// Salient-corner treatment of the mesh fillet, by sharpness (decided 2026-08-17).
// A SHARP salient corner (turn past the 30° chain-smoothness bar) keeps the honest
// MITRE: the two blends run to the vertex and cross in the classic intersection
// seam every B-rep fillet shows. The seam is a REAL crease (76–90° dihedral,
// measured), its feature line is correct — a sharp corner IS a hard edge — and the
// top face keeps its sharp corner. There is provably no band that hugs both walls
// around a salient corner without creasing, and every lift-off construction strands
// a corner column whose shelf reads as an artifact (the label part's non-bold
// letter terminals, which motivated the decision).
//
// A GENTLE salient corner (8°–30°) steers instead — a small arc chain replaces the
// mitre — because a shallow mitre's overlap wedge triangulates into junk lines
// while the steer's silhouette cost stays microns deep. The one sharp-corner
// exception: when the corner's vertical edge is being blended too (roundAll), the
// column below the band is itself rounded and the steer approximates the ball's
// sphere corner — covered by roundall-feature-lines.test.js.
//
// Reflex (inner) corners take the rolling-ball PIVOT (see
// mesh-fillet-reflex.test.js): the ball swings about the corner's face-normal axis,
// and the face's blend boundary rounds into an arc of radius r about the vertex.
//
// The line census runs the REAL render path — toMesh(), which is creased-normals plus
// the kernel's shading-policy registry. The registry matters: blend surfaces keep
// their originalIDs (that is how the band's boundary rings draw), and only the BLEND
// policy tells the crease pass that their handover seams line-draw like one surface.
// The census window is strict-interior with a margin clear of both boundary rings.
// For mitred fixtures the census EXCLUDES a neighborhood of each sharp corner —
// the seam there is wanted — and asserts separately that the seam actually draws.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const relErr = (v, expected) => Math.abs(v - expected) / Math.abs(expected);

// sharp outline vertices (turn > 30°) — where the mitre seam is expected
function sharpCorners(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]];
    const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
    const cos = (d1[0] * d2[0] + d1[1] * d2[1]) / ((l1 * l2) || 1);
    if (Math.acos(Math.max(-1, Math.min(1, cos))) > (30 * Math.PI) / 180) out.push(b);
  }
  return out;
}

function bandLines(solid, zTop, r, { excludeCorners = [], margin = 0 } = {}) {
  const { edges } = solid.toMesh();
  const zLo = zTop - r + 0.05 * r, zHi = zTop - 0.05 * r;
  const clear = (x, y) => excludeCorners.every(([cx, cy]) => Math.hypot(x - cx, y - cy) > margin);
  let n = 0, atCorners = 0;
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const inBand = (z) => z > zLo && z < zHi;
    if (!inBand(edges[i + 2]) || !inBand(edges[i + 5])) continue;
    if (clear(edges[i], edges[i + 1]) && clear(edges[i + 3], edges[i + 4])) n++;
    else atCorners++;
  }
  return { away: n, atCorners };
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

describe("smooth rims render as clean curves, sharp corners mitre honestly", () => {
  it("near-circular offset-style corners: the tool follows the real rim, not a fitted circle", () => {
    const out = k.extrude({ profile: wobblyRoundedRect(), h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    expect(bandLines(out, 8, 1).away).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });

  it("line-line corners: the arrow band is clean between corners, seamed at them", () => {
    const profile = arrow();
    const out = k.extrude({ profile, h: 5 }).fillet(1, { inPlane: "XY", at: 5 });
    const census = bandLines(out, 5, 1, { excludeCorners: sharpCorners(profile), margin: 2.5 });
    expect(census.away).toBeLessThan(10);   // no junk lines along the band
    expect(census.atCorners).toBeGreaterThan(0); // the mitre seam draws — it is a hard edge
    expect(out.genus()).toBe(0);
  });

  it("planar-planar corners: the wavy-square band is clean between corners, seamed at them", () => {
    const profile = wavySquare();
    const out = k.extrude({ profile, h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    const census = bandLines(out, 8, 1, { excludeCorners: sharpCorners(profile), margin: 2.5 });
    expect(census.away).toBeLessThan(10);
    expect(census.atCorners).toBeGreaterThan(0);
    expect(out.genus()).toBe(0);
  });
});

describe("tight salient arcs keep the revolve", () => {
  it("corner arcs near the blend radius render clean, not shattered", () => {
    // Corner radius 0.5 under a 0.3 fillet — the glyph-outline regime (a bold
    // letter's 0.4 mm offset-round corners under the label part's 0.3 mm rim
    // fillet). Planarizing an arc this tight hands it to the planar sweep,
    // whose fold guard fires on EVERY facet (curvature radius < ~1.67× the
    // blend reach), shattering the band into per-facet micro-tools — measured
    // ~20 µm-wide tools whose disagreements notched the band ("divot" artifact)
    // and drew hundreds of lines. The revolve sweeps the tight arc exactly.
    const W = 20, Hh = 10, R = 0.5, n = 12;
    const pts = [];
    const corner = (cx, cy, a0) => {
      for (let i = 0; i <= n; i++) {
        const th = a0 + (Math.PI / 2) * (i / n);
        pts.push([cx + R * Math.cos(th), cy + R * Math.sin(th)]);
      }
    };
    corner(W - R, Hh - R, 0);
    corner(R, Hh - R, Math.PI / 2);
    corner(R, R, Math.PI);
    corner(W - R, R, (3 * Math.PI) / 2);
    const out = k.extrude({ profile: pts, h: 2 }).fillet(0.3, { inPlane: "XY", at: 2 });
    expect(bandLines(out, 2, 0.3).away).toBeLessThan(10);
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
    expect(bandLines(out, 8, 1).away).toBeLessThan(10);
    expect(out.genus()).toBe(0);
  });
});

describe("mitred corners match the B-rep result", () => {
  it("box top rim: volume matches OCCT's native fillet", () => {
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
