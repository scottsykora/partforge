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
const unit2 = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };

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

// Maximum inward departure of a sharp corner's vertical-bisector silhouette
// from the requested rolling-ball arc.  This reads the indexed geometry, not
// render normals: a boolean notch at the cutter handover is visible from the
// side even when shading and feature lines are disabled.
function miterSilhouetteError(solid, corner, zTop, r, inward1 = [-1, 0], inward2 = [0, -1]) {
  const { positions, indices } = solid.toIndexedMesh();
  const [cx, cy] = corner;
  const onBisector = [];
  for (const vi of new Set(indices)) {
    const x = positions[3 * vi], y = positions[3 * vi + 1], z = positions[3 * vi + 2];
    const dx = x - cx, dy = y - cy;
    const d1 = dx * inward1[0] + dy * inward1[1];
    const d2 = dx * inward2[0] + dy * inward2[1];
    if (z <= zTop - r + 0.02 * r || z >= zTop - 0.02 * r) continue;
    if (Math.abs(d1 - d2) > 1e-3) continue;
    if (Math.hypot(d1, d2) > 2 * r) continue;
    const inset = (d1 + d2) / Math.SQRT2;
    const dz = z - (zTop - r);
    const idealInset = Math.SQRT2 * (r - Math.sqrt(Math.max(0, r * r - dz * dz)));
    onBisector.push(inset - idealInset);
  }
  if (!onBisector.length) return Infinity;
  return Math.max(...onBisector);
}

// Same geometry check as seen by a side camera: intersect every triangle with
// horizontal planes, project the local corner outline from several azimuths,
// and compare the foremost point with the ideal inset cross-section. This
// catches a notch away from the exact miter bisector.
function miterProjectionError(solid, corner, zTop, r, inward1 = [-1, 0], inward2 = [0, -1]) {
  const { positions, indices } = solid.toIndexedMesh();
  const point = (vi) => [positions[3 * vi], positions[3 * vi + 1], positions[3 * vi + 2]];
  let worst = -Infinity, samples = 0;
  for (const deg of [5, 15, 30, 45, 60, 75, 85]) {
    const a = (deg * Math.PI) / 180, w1 = Math.cos(a), w2 = Math.sin(a);
    for (let si = 1; si < 30; si++) {
      const z = zTop - r + (r * si) / 30;
      let actual = Infinity;
      for (let t = 0; t < indices.length; t += 3) {
        const tri = [point(indices[t]), point(indices[t + 1]), point(indices[t + 2])];
        for (let e = 0; e < 3; e++) {
          const p = tri[e], q = tri[(e + 1) % 3];
          if ((z - p[2]) * (z - q[2]) > 1e-14 || Math.abs(q[2] - p[2]) < 1e-12) continue;
          const u = (z - p[2]) / (q[2] - p[2]);
          if (u < -1e-8 || u > 1 + 1e-8) continue;
          const x = p[0] + u * (q[0] - p[0]), y = p[1] + u * (q[1] - p[1]);
          const dx = x - corner[0], dy = y - corner[1];
          const d1 = dx * inward1[0] + dy * inward1[1];
          const d2 = dx * inward2[0] + dy * inward2[1];
          if (d1 < -0.02 * r || d2 < -0.02 * r || d1 > 2 * r || d2 > 2 * r) continue;
          actual = Math.min(actual, w1 * d1 + w2 * d2);
        }
      }
      if (!Number.isFinite(actual)) continue;
      const dz = z - (zTop - r);
      const inset = r - Math.sqrt(Math.max(0, r * r - dz * dz));
      worst = Math.max(worst, actual - (w1 + w2) * inset);
      samples++;
    }
  }
  return samples ? worst : Infinity;
}

// Cross-section a straight selected edge at its midpoint and compare the outside
// silhouette through the whole blend band with the requested rolling-ball arc.
function straightProfileError(solid, a, b, zTop, r) {
  const { positions, indices } = solid.toIndexedMesh();
  const tangent = unit2([b[0] - a[0], b[1] - a[1]]);
  const inward = [-tangent[1], tangent[0]];
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const point = (vi) => [positions[3 * vi], positions[3 * vi + 1], positions[3 * vi + 2]];
  const crossSection = [];
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [point(indices[t]), point(indices[t + 1]), point(indices[t + 2])];
    const hits = [];
    for (let e = 0; e < 3; e++) {
      const p = tri[e], q = tri[(e + 1) % 3];
      const sp = (p[0] - mid[0]) * tangent[0] + (p[1] - mid[1]) * tangent[1];
      const sq = (q[0] - mid[0]) * tangent[0] + (q[1] - mid[1]) * tangent[1];
      if (Math.abs(sp) < 1e-10 && Math.abs(sq) < 1e-10) {
        for (const hit of [p, q].map(([x, y, z]) => [(x - mid[0]) * inward[0] + (y - mid[1]) * inward[1], z]))
          if (!hits.some((h) => Math.hypot(h[0] - hit[0], h[1] - hit[1]) < 1e-8)) hits.push(hit);
        continue;
      }
      if (sp * sq > 1e-14 || Math.abs(sq - sp) < 1e-12) continue;
      const u = -sp / (sq - sp);
      if (u < -1e-8 || u > 1 + 1e-8) continue;
      const x = p[0] + u * (q[0] - p[0]), y = p[1] + u * (q[1] - p[1]);
      const hit = [(x - mid[0]) * inward[0] + (y - mid[1]) * inward[1], p[2] + u * (q[2] - p[2])];
      if (!hits.some((h) => Math.hypot(h[0] - hit[0], h[1] - hit[1]) < 1e-8)) hits.push(hit);
    }
    if (hits.length >= 2) {
      let pair = [hits[0], hits[1]], span = 0;
      for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
        const d = Math.hypot(hits[i][0] - hits[j][0], hits[i][1] - hits[j][1]);
        if (d > span) { span = d; pair = [hits[i], hits[j]]; }
      }
      crossSection.push(pair);
    }
  }
  let worst = -Infinity, samples = 0;
  for (let si = 1; si < 30; si++) {
    const z = zTop - r + (r * si) / 30;
    let actual = Infinity;
    for (const [p, q] of crossSection) {
      if ((z - p[1]) * (z - q[1]) > 1e-14 || Math.abs(q[1] - p[1]) < 1e-12) continue;
      const u = (z - p[1]) / (q[1] - p[1]);
      const d = p[0] + u * (q[0] - p[0]);
      if (d >= -0.02 * r && d <= 2 * r) actual = Math.min(actual, d);
    }
    if (!Number.isFinite(actual)) continue;
    const dz = z - (zTop - r);
    const ideal = r - Math.sqrt(Math.max(0, r * r - dz * dz));
    worst = Math.max(worst, actual - ideal);
    samples++;
  }
  return samples ? worst : Infinity;
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
  it("a box miter follows the fillet arc without a side-profile notch", () => {
    const H = 2, R = 0.3, L = 10;
    const out = k.box({ min: [0, 0, 0], max: [L, L, H] }).fillet(R, { inPlane: "XY", at: H });
    expect(straightProfileError(out, [L, 0], [L, L], H, R)).toBeLessThan(0.01);
    expect(miterSilhouetteError(out, [L, L], H, R)).toBeLessThan(0.01);
    expect(miterProjectionError(out, [L, L], H, R)).toBeLessThan(0.01);
  });

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

describe("corner rounds smaller than the blend collapse to virtual corners", () => {
  it("sub-threshold corner rounds mitre as corners instead of shattering", () => {
    // A corner round with radius under the fold threshold (~0.37·magnitude)
    // cannot be swept — the band pinches — and cannot be steered (no setback
    // room), so the fold guard used to break at EVERY facet and the band
    // shattered into overshot micro-tools (the non-bold glyph "divot" regime:
    // raw letter terminals carry ~0.1–0.25 mm rounds under a 0.3 mm fillet;
    // bold outlines never hit this because the 0.4 mm round offset pads every
    // convex radius past the threshold). collapseTightCorners replaces the run
    // with the flanking edge lines' intersection and the corner mitres like
    // the sharp corner it effectively is: seam at the corner, clean elsewhere.
    for (const R of [0.12, 0.25]) {
      const W = 20, Hh = 10, n = 6;
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
      const census = bandLines(out, 2, 0.3, {
        excludeCorners: [[W, Hh], [0, Hh], [0, 0], [W, 0]],
        margin: 0.75,
      });
      expect(census.away).toBeLessThan(10);
      expect(out.genus(), `corner radius ${R}`).toBe(0);
    }
  });

  it("the exact centered Scott t regions have clean sharp-corner miter silhouettes", () => {
    const H = 2, R = 0.3;
    const regions = k.text2d("Scott", { size: 31, align: "center", valign: "middle" }).regions();
    for (const glyph of [regions[3], regions[4]]) {
      const outline = glyph.toRegions()[0].outer;
      const out = glyph.extrude({ h: H }).fillet(R, { inPlane: "XY", at: H });
      // Every sharp salient corner in each t outline. Indices 100 and 101 are
      // the two stem-top silhouettes from the report; the other three ensure a
      // repair does not just move the defect around the crossbar.
      for (const i of [97, 98, 100, 101, 103]) {
        const a = outline[(i - 1 + outline.length) % outline.length], b = outline[i], c = outline[(i + 1) % outline.length];
        const inward1 = unit2([a[0] - b[0], a[1] - b[1]]);
        const inward2 = unit2([c[0] - b[0], c[1] - b[1]]);
        expect(miterSilhouetteError(out, b, H, R, inward1, inward2)).toBeLessThan(0.01);
        expect(miterProjectionError(out, b, H, R, inward1, inward2)).toBeLessThan(0.01);
      }
      for (const [i, j] of [[97, 98], [98, 99], [100, 101], [102, 103], [103, 104]])
        expect(straightProfileError(out, outline[i], outline[j], H, R), `edge ${i}->${j}`).toBeLessThan(0.01);
      expect(out.genus()).toBe(0);
    }
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
