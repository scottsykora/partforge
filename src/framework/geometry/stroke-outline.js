// Stroke → filled geometry. The half of paperjs-offset that contour-offset.js
// did not port: `offsetStroke`.
//
// Both cases reduce to "offset the path, offset its reverse, let nonzero winding
// assemble the result":
//
//   CLOSED  outer = offset(contour, +w/2), inner = offset(reverse(contour), +w/2).
//           Two rings of opposite handedness -> an annulus. _offsetContour
//           already does closed rings correctly, so this adds no geometry code.
//   OPEN    the same two offsets as open CHAINS, joined end to end by caps into
//           one closed ring.
//
// Pure leaf: DOM-free, node:-free.
import { _joinSegs, _offsetContour, _offsetSegment } from "./contour-offset.js";
import { SMOOTH_JOINT_DEG, segTangent } from "./contour-ops.js";
import { closeContourGap, reverseContour } from "./profile.js";
import { resolveCurveFill } from "./curve-fill.js";

const JOIN_EPS = 1e-6;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rightOf = ([x, y]) => [y, -x];        // matches contour-offset.js:31 exactly

// SVG's linejoin vocabulary is contour-offset.js's `corners` vocabulary under
// different names.
const CORNERS = { miter: "sharp", round: "round", bevel: "chamfer" };

// Each segment's start point, with zero-length lines dropped (no direction, so
// no offset).
function chainParts(contour) {
  const segs = [], froms = [];
  let p = contour.start;
  for (const s of contour.segments) {
    if (s.c1 || s.via || dist(p, s.to) > 1e-9) { segs.push(s); froms.push(p); }
    p = s.to;
  }
  return { segs, froms, end: p };
}

// Offset an OPEN chain, joining at interior vertices only. Mirrors
// _offsetContour's join decision (gap side gets a join, overlap side gets a
// bevel the winding rule then cancels) minus the wrap-around and the whole-ring
// collapse predicate, neither of which means anything for a chain.
function offsetOpenChain(contour, delta, corners) {
  const { segs, froms } = chainParts(contour);
  if (segs.length === 0) return null;
  const pieces = segs.map((s, i) => _offsetSegment(froms[i], s, delta));
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) {
      const aEnd = pieces[i - 1].segments.at(-1).to, bStart = pieces[i].start;
      const inTan = segTangent(froms[i - 1], segs[i - 1], false);
      const outTan = segTangent(froms[i], segs[i], true);
      const turn = cross(inTan, outTan);
      const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, dot(inTan, outTan)))) * 180) / Math.PI;
      if (dist(aEnd, bStart) > JOIN_EPS && turnDeg >= SMOOTH_JOINT_DEG) {
        // turn === 0 with a large turnDeg is an exact 180 degree reversal — the
        // same ambiguity _offsetContour calls out; treat it as gap side so a
        // round join is honored rather than flat-capped.
        if (turn * delta > 0 || turn === 0) out.push(..._joinSegs(froms[i], aEnd, bStart, inTan, outTan, delta, corners));
        else out.push({ to: [bStart[0], bStart[1]] });
      }
    }
    out.push(...pieces[i].segments);
  }
  return { start: pieces[0].start, segments: out };
}

// Bridge to `to` around the path endpoint `tip`, where `tangent` points OUT of
// the path at that end and `hw` is the half stroke width. The current position
// on entry is tip + hw*rightOf(tangent).
function capSegments(tip, tangent, hw, linecap, to) {
  if (linecap === "round") return [{ via: add(tip, scl(tangent, hw)), to }];
  if (linecap === "square") {
    const ext = scl(tangent, hw), n = scl(rightOf(tangent), hw);
    return [{ to: add(add(tip, n), ext) }, { to: add(sub(tip, n), ext) }, { to }];
  }
  return [{ to }];                                            // butt
}

export function outlineStroke(contour, closed, style) {
  const hw = style.strokeWidth / 2;
  if (!(hw > 0)) throw new Error("svg: cannot outline a stroke of zero width");
  const corners = CORNERS[style.linejoin] ?? "sharp";

  if (closed) {
    const ring = closeContourGap(contour);
    const a = _offsetContour(ring, hw, corners).contour;
    const b = _offsetContour(closeContourGap(reverseContour(ring)), hw, corners).contour;
    const rings = [a, b].filter(Boolean);
    if (rings.length < 2) throw new Error("svg: stroke outline collapsed — stroke-width is too large for this shape");
    return resolveCurveFill(rings, { fillRule: "nonzero" });
  }

  const fwd = offsetOpenChain(contour, hw, corners);
  const rev = offsetOpenChain(reverseContour(contour), hw, corners);
  if (!fwd || !rev) throw new Error("svg: stroke path has no length to outline");

  const { segs, froms, end } = chainParts(contour);
  const endTan = segTangent(froms.at(-1), segs.at(-1), false);
  const startTanIn = segTangent(contour.start, segs[0], true);
  const startTanOut = [-startTanIn[0], -startTanIn[1]];

  const segments = [
    ...fwd.segments,
    ...capSegments(end, endTan, hw, style.linecap, rev.start),
    ...rev.segments,
    ...capSegments(contour.start, startTanOut, hw, style.linecap, fwd.start),
  ];

  // A stroke path that crosses itself makes this ring self-intersecting.
  // resolveCurveFill under nonzero is exactly the normalizer for that — the same
  // one the fill path uses, not a second mechanism.
  return resolveCurveFill([{ start: fwd.start, segments }], { fillRule: "nonzero" });
}
