// Backend-shared 2-D region normalization + tessellation for extrude()/prism(). A contour
// is EITHER a bare points array (legacy, all straight edges) OR a canonical ArcContour
// { start:[x,y], segments:[{to}|{to,via}], arc:true } carrying true circular arcs (from
// roundedProfile). normalizeProfile validates the polymorphic { outer, holes } envelope
// (bare array = outer only), preserving each contour's shape; tessellateProfile turns the
// arcs into point rings for the Manifold (mesh) path. The OCCT path consumes the same
// ArcContour directly (contourDrawing → threePointsArcTo) for true CIRCLE B-rep edges.
// Legacy point-array contours take the exact former path byte-for-byte — no cache-busting.

// An ArcContour is a non-array object carrying arcs symbolically.
export function isArcContour(c) {
  return !!c && typeof c === "object" && !Array.isArray(c) && (c.arc === true || Array.isArray(c.segments));
}

// Curves generalize arcs; the symbolic-form predicate is the same. Prefer this name.
export const isPathContour = isArcContour;

function validateContour(c, role) {
  if (isArcContour(c)) {
    if (!Array.isArray(c.start) || c.start.length < 2)
      throw new Error(`extrude: ${role} arc contour needs a start [x,y]`);
    if (!Array.isArray(c.segments) || c.segments.length < 1)
      throw new Error(`extrude: ${role} arc contour needs ≥1 segment`);
    for (const s of c.segments) {
      const hasCubic = s.c1 != null || s.c2 != null;
      if (hasCubic) {
        if (s.via != null)
          throw new Error(`extrude: ${role} segment cannot mix arc (via) and cubic (c1/c2)`);
        const ok = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
        if (!ok(s.c1) || !ok(s.c2))
          throw new Error(`extrude: ${role} cubic segment needs c1 and c2 as finite [x,y]`);
      }
    }
    return;
  }
  if (!Array.isArray(c) || c.length < 3) throw new Error(`extrude: ${role} needs ≥3 points`);
}

export function normalizeProfile(profile) {
  let outer, holes;
  if (Array.isArray(profile) || isArcContour(profile)) { outer = profile; holes = []; }
  else if (profile && typeof profile === "object") { outer = profile.outer; holes = profile.holes ?? []; }
  else throw new Error("extrude: profile must be [[x,y],…], an arc contour, or { outer, holes? }");
  // Preserve the historical, test-pinned wording for the legacy point-array path.
  if (isArcContour(outer)) validateContour(outer, "outer contour");
  else if (!Array.isArray(outer) || outer.length < 3) throw new Error("extrude: outer contour needs ≥3 points");
  if (!Array.isArray(holes)) throw new Error("extrude: holes must be an array of contours");
  for (const hole of holes) {
    if (isArcContour(hole)) validateContour(hole, "hole arc contour");
    else if (!Array.isArray(hole) || hole.length < 3) throw new Error("extrude: each hole needs ≥3 points");
  }
  return { outer, holes };
}

// Sample the circular arc through (p0, via, p1) — the three-point form roundedProfile
// emits — into a point list p1…pN (EXCLUDING the start p0, which the ring already holds;
// the last point is exactly p1). The circle is recovered from the circumcircle of the
// three points; the sweep direction is the one whose arc actually passes through `via`
// (sign-free, winding-free). Facet count scales with the sweep's fraction of the kernel's
// full-circle resolution `segs`, matching the piePolygon/circleProfile convention, so an
// arc and a circleProfile of equal radius facet identically. A degenerate (collinear)
// triple falls back to a single straight segment to p1 — the same "plain line" the OCCT
// side gets when roundedProfile emits no `via`.
export function sampleArc(p0, via, p1, segs) {
  const [ax, ay] = p0, [bx, by] = via, [cx, cy] = p1;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return [[cx, cy]];            // collinear → straight line
  const sa = ax * ax + ay * ay, sb = bx * bx + by * by, sc = cx * cx + cy * cy;
  const ux = (sa * (by - cy) + sb * (cy - ay) + sc * (ay - by)) / d;
  const uy = (sa * (cx - bx) + sb * (ax - cx) + sc * (bx - ax)) / d;
  const rr = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const av = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  const dA = vCCW <= dCCW ? dCCW : dCCW - twoPi;          // pick the sweep containing `via`
  const steps = Math.max(2, Math.ceil((segs * Math.abs(dA)) / twoPi));
  const out = [];
  for (let s = 1; s <= steps; s++) {
    const ang = a0 + dA * (s / steps);
    out.push([ux + rr * Math.cos(ang), uy + rr * Math.sin(ang)]);
  }
  out[out.length - 1] = [cx, cy];                        // pin the exact endpoint
  return out;
}

// Flatten the cubic Bézier (p0,c1,c2,p1) into points p1…pN — EXCLUDING the start
// p0 (the ring already holds it), last point pinned exactly to p1. Adaptive: split
// at t=½ (de Casteljau) until the control polygon's total unsigned turn is ≤ 2π/segs
// — the exact generalization of sampleArc's "a point every 2π/segs of sweep", so a
// cubic tracing a circular arc facets like the arc primitive at the same segs. Summing
// |turn| at BOTH interior control points also catches S-curves a pure endpoint-tangent
// test would miss. Depth cap guarantees termination. Pure in (args, segs).
export function sampleBezier(p0, c1, c2, p1, segs) {
  const maxTurn = (2 * Math.PI) / Math.max(3, segs);
  const out = [];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const turn = (u, v) => {
    const du = Math.hypot(u[0], u[1]), dv = Math.hypot(v[0], v[1]);
    if (du < 1e-12 || dv < 1e-12) return 0;
    let c = (u[0] * v[0] + u[1] * v[1]) / (du * dv);
    if (c > 1) c = 1; else if (c < -1) c = -1;
    return Math.acos(c);
  };
  const recurse = (a, b, c, d, depth) => {
    const ab = [b[0] - a[0], b[1] - a[1]];
    const bc = [c[0] - b[0], c[1] - b[1]];
    const cd = [d[0] - c[0], d[1] - c[1]];
    if (depth >= 12 || turn(ab, bc) + turn(bc, cd) <= maxTurn) { out.push([d[0], d[1]]); return; }
    const p01 = mid(a, b), p12 = mid(b, c), p23 = mid(c, d);
    const p012 = mid(p01, p12), p123 = mid(p12, p23), m = mid(p012, p123);
    recurse(a, p01, p012, m, depth + 1);
    recurse(m, p123, p23, d, depth + 1);
  };
  recurse(p0, c1, c2, p1, 0);
  if (out.length === 0) out.push([p1[0], p1[1]]);
  out[out.length - 1] = [p1[0], p1[1]];   // pin the exact endpoint
  return out;
}

// Tessellate a single contour into a CCW point ring. A legacy array is returned unchanged
// (identical to the former path); an ArcContour is walked start→segment→segment, lines
// pushing their `to` and arcs pushing their sampled points.
export function tessellateContour(contour, segs) {
  if (Array.isArray(contour)) return contour;
  const ring = [[contour.start[0], contour.start[1]]];
  let prev = contour.start;
  for (const seg of contour.segments) {
    if (seg.c1) for (const p of sampleBezier(prev, seg.c1, seg.c2, seg.to, segs)) ring.push(p);
    else if (seg.via) for (const p of sampleArc(prev, seg.via, seg.to, segs)) ring.push(p);
    else ring.push([seg.to[0], seg.to[1]]);
    prev = seg.to;
  }
  return ring;
}

// Normalize + tessellate a whole region to { outer:[[x,y],…], holes:[[[x,y],…],…] } of
// point rings, ready for CrossSection.ofPolygons on the Manifold path.
export function tessellateProfile(profile, segs) {
  const { outer, holes } = normalizeProfile(profile);
  return { outer: tessellateContour(outer, segs), holes: holes.map((hl) => tessellateContour(hl, segs)) };
}
