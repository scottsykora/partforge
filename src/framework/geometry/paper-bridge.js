// Lazy, private PaperScope: built on first use (not at module load), so parts that never
// call k.text2d don't pull paper-core's setup onto the geometry worker. Never paper's
// package-global project — another consumer in the same worker may import paper too.
import paper from "paper/dist/paper-core.js";
import { tessellateContour, reverseContour, closeContourGap } from "./profile.js";

const WINDING_SEGS = 8;   // points/segment for the local orientation sampler below

let _scope = null;
function paperScope() {
  if (!_scope) { _scope = new paper.PaperScope(); _scope.setup(new _scope.Size(1, 1)); }
  return _scope;
}

// Circumcircle center + signed sweep for the arc through (p0, via, to) — the sweep is the
// one passing through `via` (sign-free, winding-free), same recovery as profile.js's
// sampleArc. Returns null for a collinear (degenerate) triple. Shared by arcToCubicSegments
// below and contour-ops.js's jointTangents (arc tangents are ⊥ radius, oriented by dA's sign).
export function arcCenterAndSweep(p0, via, to) {
  const [ax, ay] = p0, [bx, by] = via, [cx, cy] = to;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const sa = ax*ax + ay*ay, sb = bx*bx + by*by, sc = cx*cx + cy*cy;
  const ux = (sa * (by - cy) + sb * (cy - ay) + sc * (ay - by)) / d;
  const uy = (sa * (cx - bx) + sb * (ax - cx) + sc * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const a0 = Math.atan2(ay - uy, ax - ux);
  const av = Math.atan2(by - uy, bx - ux);
  const a1 = Math.atan2(cy - uy, cx - ux);
  const twoPi = 2 * Math.PI;
  const ccw = (x) => { let v = x % twoPi; if (v < 0) v += twoPi; return v; };
  const dCCW = ccw(a1 - a0), vCCW = ccw(av - a0);
  const dA = vCCW <= dCCW ? dCCW : dCCW - twoPi;
  return { center: [ux, uy], r, dA };
}

// Circular arc through (p0, via, to) → cubic Bézier segments, ≤90° each, endpoints
// exact. Each piece uses the standard k = (4/3)·tan(θ/4) control-point offset.
// Collinear triple → straight segment.
export function arcToCubicSegments(p0, via, to) {
  const cx = to[0], cy = to[1];
  const c = arcCenterAndSweep(p0, via, to);
  if (!c) return [{ to: [cx, cy] }];
  const { center: [ux, uy], r, dA } = c;
  const a0 = Math.atan2(p0[1] - uy, p0[0] - ux);
  // Handle floating-point precision: angles very close to π/2 boundaries
  const pieces = Math.max(1, Math.ceil((Math.abs(dA) - 1e-9) / (Math.PI / 2)));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const t0 = a0 + dA * (i / pieces), t1 = a0 + dA * ((i + 1) / pieces);
    const dt = t1 - t0, k = (4 / 3) * Math.tan(dt / 4);
    const P = (t) => [ux + r * Math.cos(t), uy + r * Math.sin(t)];
    const s = P(t0), e = P(t1);
    out.push({
      to: e,
      c1: [s[0] - k * r * Math.sin(t0), s[1] + k * r * Math.cos(t0)],
      c2: [e[0] + k * r * Math.sin(t1), e[1] - k * r * Math.cos(t1)],
    });
  }
  out[out.length - 1].to = [cx, cy];   // pin the exact endpoint
  return out;
}

export function toPaperPath(scope, contour, segMap = null, { open = false } = {}) {
  const path = new scope.Path({ insert: false });
  path.moveTo(new scope.Point(contour.start[0], contour.start[1]));
  let prev = contour.start;
  contour.segments.forEach((s, i) => {
    if (s.via) {
      // Expand {to,via} arc into cubic segments, all sharing one segMap entry
      const cubics = arcToCubicSegments(prev, s.via, s.to);
      for (const cubic of cubics) {
        if (cubic.c1) {
          path.cubicCurveTo(
            new scope.Point(cubic.c1[0], cubic.c1[1]),
            new scope.Point(cubic.c2[0], cubic.c2[1]),
            new scope.Point(cubic.to[0], cubic.to[1]));
        } else {
          // Collinear triple: emit straight segment
          path.lineTo(new scope.Point(cubic.to[0], cubic.to[1]));
        }
        if (segMap) segMap.push(i);
      }
      prev = s.to;
    } else if (s.c1) {
      path.cubicCurveTo(
        new scope.Point(s.c1[0], s.c1[1]),
        new scope.Point(s.c2[0], s.c2[1]),
        new scope.Point(s.to[0], s.to[1]));
      if (segMap) segMap.push(i);
      prev = s.to;
    } else {
      path.lineTo(new scope.Point(s.to[0], s.to[1]));
      if (segMap) segMap.push(i);
      prev = s.to;
    }
  });
  if (!open) {
    path.closePath();
    // A contour authored without an explicit closing segment (e.g. pathProfile(...).close())
    // relies on closePath() to synthesize the closing curve — segMap never saw it. Give it
    // the next index after the last authored segment so callers can recognize "the implicit
    // close". When the contour DOES have an explicit closing segment, closePath() joins the
    // coincident start/end segments and curve count already matches segMap — don't push then.
    if (segMap && path.curves.length === segMap.length + 1) segMap.push(contour.segments.length);
  }
  return path;
}

function toContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i], b = segs[(i + 1) % segs.length];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const closing = i === segs.length - 1;
    if (closing && straight) continue;                 // implicit straight close
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Open-path counterpart to toContour: every segment is a real curve of the path (no
// wrap-around, no implicit-close skip) — for readback of paths built with {open: true}.
function toOpenContour(path) {
  const segs = path.segments;
  const start = [segs[0].point.x, segs[0].point.y];
  const out = { start, segments: [] };
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i], b = segs[i + 1];
    const straight = a.handleOut.isZero() && b.handleIn.isZero();
    const to = [b.point.x, b.point.y];
    if (straight) out.segments.push({ to });
    else out.segments.push({ to, c1: [a.point.x + a.handleOut.x, a.point.y + a.handleOut.y], c2: [b.point.x + b.handleIn.x, b.point.y + b.handleIn.y] });
  }
  return out;
}

// Group while paths are still Paper geometry. Path.area includes cubic handles and
// interiorPoint is guaranteed to lie inside the curve; never reduce curves to endpoint rings.
function groupPaperPaths(paths) {
  const largest = paths.reduce((a, b) => Math.abs(b.area) > Math.abs(a.area) ? b : a);
  const outerClockwise = largest.clockwise;
  const outers = paths.filter((p) => p.clockwise === outerClockwise)
    .map((path) => ({ path, holes: [] }));
  for (const hole of paths.filter((p) => p.clockwise !== outerClockwise)) {
    const home = outers.filter((o) => o.path.contains(hole.interiorPoint))
      .sort((a, b) => Math.abs(a.path.area) - Math.abs(b.path.area))[0];
    if (!home) throw new Error("curve-fill: resolved hole has no containing outer");
    home.holes.push(hole);
  }
  return outers.map(({ path, holes }) => ({
    outer: toContour(path),
    holes: holes.map(toContour),
  }));
}

// Signed shoelace area of a tessellated ring (CCW positive) — a tiny local sampler so
// this module doesn't need shape2d-regions.js's ringArea for one call site.
function shoelaceArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// groupPaperPaths (containment-based outer/hole assignment), plus a winding-normalization
// pass so the emitted contours carry the storage invariant (outer CCW, holes CW in
// model y-up space). Paper's own `clockwise` flag is in paper's y-down coordinate frame,
// so it doesn't map onto that invariant directly — decide by area sign of the emitted
// contour instead: tessellate it and check the shoelace sign, reversing when wrong.
// closeContourGap re-closes the ring explicitly: toContour() (used by groupPaperPaths,
// via curve-fill.js too — see its own comment) drops a straight closing edge as
// "implicit," but every Shape2D region stored from here on must be explicitly closed —
// contour-ops.js's corner math reads `segments[n-1]` directly as the edge arriving back
// at `start` and has no other way to know the ring isn't fully spelled out.
function groupPaperPathsOriented(paths) {
  const regions = groupPaperPaths(paths);
  return regions.map(({ outer, holes }) => ({
    outer: closeContourGap(shoelaceArea(tessellateContour(outer, WINDING_SEGS)) >= 0 ? outer : reverseContour(outer)),
    holes: holes.map((h) => closeContourGap(shoelaceArea(tessellateContour(h, WINDING_SEGS)) < 0 ? h : reverseContour(h))),
  }));
}

function cloneRegion(rg) {
  return JSON.parse(JSON.stringify(rg));
}

function regionsToCompound(scope, regions) {
  const children = [];
  for (const rg of regions) {
    children.push(toPaperPath(scope, rg.outer));
    for (const h of rg.holes) children.push(toPaperPath(scope, h));
  }
  return new scope.CompoundPath({ children, fillRule: "evenodd" });
}

// Boolean op between two region lists (each in contour IR) via paper.js's planar boolean
// engine. op: "unite" | "subtract" | "intersect" — same semantics as bracket.js's Shape2D
// toolkit. Result regions come back in contour IR with the storage winding invariant
// (outer CCW, holes CW) restored by groupPaperPathsOriented. Empty result → [].
export function booleanRegions(aRegions, bRegions, op) {
  if (!["unite", "subtract", "intersect"].includes(op)) throw new Error(`booleanRegions: unknown op "${op}"`);
  if (aRegions.length === 0) return op === "unite" ? bRegions.map(cloneRegion) : [];
  if (bRegions.length === 0) return op === "intersect" ? [] : aRegions.map(cloneRegion);
  const scope = paperScope();
  try {
    const A = regionsToCompound(scope, aRegions), B = regionsToCompound(scope, bRegions);
    const out = A[op](B, { insert: false });
    const paths = (out.className === "CompoundPath" ? out.children : [out])
      .filter((p) => p.segments && p.segments.length >= 2 && Math.abs(p.area) > 1e-9);
    if (!paths.length) return [];
    return groupPaperPathsOriented(paths);
  } finally {
    scope.project.clear();
  }
}

export { paperScope, toContour, toOpenContour, groupPaperPaths };
