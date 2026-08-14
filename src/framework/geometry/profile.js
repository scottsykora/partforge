// Backend-shared 2-D region normalization + tessellation for extrude()/prism(). A contour
// is EITHER a bare points array (legacy, all straight edges) OR a canonical path contour
// { start:[x,y], segments:[{to}|{to,via}|{to,c1,c2}] } carrying true circular arcs ({to,via},
// from roundedProfile) and/or cubic Béziers ({to,c1,c2}, from pathProfile). normalizeProfile
// validates the polymorphic { outer, holes } envelope (bare array = outer only), preserving
// each contour's shape; tessellateProfile turns arcs/cubics into point rings for the Manifold
// (mesh) path at the mesh LOD. The OCCT path consumes the same contour directly (contourDrawing
// → threePointsArcTo / cubicBezierCurveTo) for true CIRCLE / B-spline B-rep edges. Legacy
// point-array contours take the exact former path byte-for-byte — no cache-busting.

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
// (identical to the former path); a path contour is walked start→segment→segment, lines
// pushing their `to`, arcs and cubics pushing their sampled points (sampleArc/sampleBezier).
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

// Build a straight-edged path contour from a bare point list — the canonical lift for
// legacy [[x,y],…] inputs into the { start, segments } IR. Lives here (not contour-ops.js)
// so paper-bridge.js can reach it without importing contour-ops (contour-ops already
// imports paper-bridge; this module is a pure leaf both can share without a cycle).
export function pointsToContour(points) {
  return { start: [points[0][0], points[0][1]],
    segments: [...points.slice(1).map((p) => ({ to: [p[0], p[1]] })), { to: [points[0][0], points[0][1]] }] };
}

// Ensure a contour's ring is EXPLICITLY closed: the last segment's `to` must coincide
// with `start`. Several contour producers leave that closing edge only implicit —
// paper.js's own Path#closePath() (see toContour() in paper-bridge.js, which drops a
// straight closing edge as redundant) and any hand-authored `pathProfile(...).close()`
// that never revisits its own start — relying on a downstream consumer (tessellation,
// an SVG "Z") to re-synthesize the missing edge. `contourCorners`/`buildCornerOpRing`
// (contour-ops.js) don't re-synthesize anything: they read `contour.segments` directly
// and assume `segments[n-1]` really is the edge arriving back at `start` (corner 0's
// "previous segment", and the wraparound neighbor for every other corner's modular
// indexing). When that assumption is false, corner 0 gets paired with the wrong
// segment entirely — if that segment is curved, the fillet/chamfer tangency solve
// fails outright (`could not fit ... max ≈ 0`); if it's a line, the corner's position
// and radius are silently miscomputed instead. Call this wherever a contour is about
// to be stored (Shape2D regions) or handed to any contour-ops function; a no-op when
// the ring is already closed, so it's safe to call unconditionally.
export function closeContourGap(contour) {
  const segs = contour.segments;
  if (!segs || segs.length === 0) return contour;
  const [sx, sy] = contour.start;
  const [lx, ly] = segs[segs.length - 1].to;
  if (Math.hypot(lx - sx, ly - sy) <= 1e-9) return contour;
  return { start: contour.start, segments: [...segs, { to: [sx, sy] }] };
}

// Reverse a contour's traversal direction: walks segments back-to-front, swapping each
// cubic's control points (c1 ↔ c2) and keeping `via` (an arc's through-point is
// direction-independent). Lives here alongside pointsToContour for the same reason —
// paper-bridge.js's booleanRegions needs it to normalize emitted winding without
// importing contour-ops.js.
export function reverseContour(contour) {
  const pts = [contour.start, ...contour.segments.map((s) => s.to)];
  const segments = [];
  for (let i = contour.segments.length - 1; i >= 0; i--) {
    const s = contour.segments[i];
    const m = { to: [pts[i][0], pts[i][1]] };
    if (s.via) m.via = [s.via[0], s.via[1]];
    if (s.c1) { m.c1 = [s.c2[0], s.c2[1]]; m.c2 = [s.c1[0], s.c1[1]]; }
    segments.push(m);
  }
  return { start: [pts[pts.length - 1][0], pts[pts.length - 1][1]], segments };
}
