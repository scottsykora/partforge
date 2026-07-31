// src/framework/geometry/rounded-solids.js
// Pure geometry builders for the rounded 3-D primitives (roundedBox /
// roundedCylinder / torus). No WASM, no DOM — shared by the kernel front
// (lathe contours for the revolve-based ops) and the Manifold backend
// (roundedBox ring stack). Normative semantics: the design spec
// (docs/superpowers/specs/2026-07-30-rounded-primitives-design.md) — at
// height z the box cross-section is the rounded rect inset δ(z) with corner
// radius max(side − δ, ~0), δ tracing a quarter circle in each rim zone.

const COS45 = Math.SQRT1_2;

// Minimum corner radius standing in for a "sharp" ring corner: keeps every
// ring at the same vertex count (4·(A+1)) without coincident points, so the
// loft stitching never sees a degenerate quad. Far below mesh/print resolution.
export const EPS_R = 1e-6;

// One CCW rounded-rectangle ring: half-extents hw/hd, corner radius rc, A arc
// segments per corner → 4·(A+1) points. Corner centers sit at (±(hw−rc),
// ±(hd−rc)); the straight edges are implied between consecutive corner arcs.
// rc is clamped into [EPS_R, min(hw, hd) − EPS_R] so sharp corners and
// full-radius (stadium) corners never emit coincident points.
export function roundedRectRing(hw, hd, rc, A) {
  const r = Math.min(Math.max(rc, EPS_R), Math.max(EPS_R, Math.min(hw, hd) - EPS_R));
  const cx = hw - r, cy = hd - r;
  const C = [[cx, cy], [-cx, cy], [-cx, -cy], [cx, -cy]];
  const pts = [];
  for (let q = 0; q < 4; q++) {
    const a0 = (q * Math.PI) / 2; // corner (+,+) spans 0..90°, then CCW
    for (let i = 0; i <= A; i++) {
      const a = a0 + (i / A) * (Math.PI / 2);
      pts.push([C[q][0] + r * Math.cos(a), C[q][1] + r * Math.sin(a)]);
    }
  }
  return pts;
}

// Ring stack for the Manifold roundedBox: ascending-z loft ring specs
// [{ polygon, z }]. A (arc samples per corner AND z-stations per rim zone) is
// derived from the kernel's segs so the z-sampling matches the in-plane LOD.
// Consecutive duplicate stations (top + bottom = h) are deduped so the loft
// never sees a zero-height band.
export function roundedBoxRings([w, d, h], { side, top, bottom }, segs) {
  const A = Math.max(2, Math.ceil(segs / 8));
  const st = [];
  const push = (z, delta) => {
    const last = st[st.length - 1];
    if (last && Math.abs(last.z - z) < 1e-9 && Math.abs(last.delta - delta) < 1e-9) return;
    st.push({ z, delta });
  };
  if (bottom > 0) {
    for (let i = 0; i <= A; i++) {
      const phi = (i / A) * (Math.PI / 2);
      push(bottom * (1 - Math.cos(phi)), bottom * (1 - Math.sin(phi)));
    }
  } else push(0, 0);
  if (top > 0) {
    for (let i = A; i >= 0; i--) {
      const phi = (i / A) * (Math.PI / 2);
      push(h - top * (1 - Math.cos(phi)), top * (1 - Math.sin(phi)));
    }
  } else push(h, 0);
  return st.map(({ z, delta }) =>
    ({ polygon: roundedRectRing(w / 2 - delta, d / 2 - delta, side - delta, A), z }));
}

// ArcContour for the roundedCylinder lathe profile: the rectangle
// [0,0]→[r,0]→[r,h]→[0,h] with the two outer corners rounded (rBottom, rTop).
// Built with explicit tangent/via points — NOT roundedProfile, whose
// conservative per-corner clamp (tangent ≤ min-adjacent-edge/2) would
// silently shrink a capsule's full-radius corner. Zero-length lines are
// skipped so boundary radii (rBottom = r, rTop + rBottom = h) stay valid.
export function latheRoundedRect(r, h, rTop, rBottom) {
  const start = [0, 0];
  const segments = [];
  let cur = start;
  const lineTo = (p) => { if (Math.hypot(p[0] - cur[0], p[1] - cur[1]) > 1e-12) { segments.push({ to: p }); cur = p; } };
  const arcTo = (to, via) => { segments.push({ to, via }); cur = to; };
  lineTo([r - rBottom, 0]);
  if (rBottom > 0)
    arcTo([r, rBottom], [r - rBottom * (1 - COS45), rBottom * (1 - COS45)]);
  lineTo([r, h - rTop]);
  if (rTop > 0)
    arcTo([r - rTop, h], [r - rTop * (1 - COS45), h - rTop * (1 - COS45)]);
  lineTo([0, h]);
  return { start, segments }; // consumers close() back down the revolve axis
}

// ArcContour for the torus lathe profile: a full circle of radius rMinor
// centered at [rMajor, 0], as four quarter arcs. The loop ends exactly on its
// start: replicad's close() skips the closing line when the pen is already
// home (verified in _closeSketch), and the Manifold tessellator's duplicated
// seam point is cleaned by Clipper2 (CrossSection.ofPolygons).
export function torusContour(rMajor, rMinor) {
  const R = rMajor, r = rMinor, c = r * COS45;
  return { start: [R + r, 0], segments: [
    { to: [R, r], via: [R + c, c] },
    { to: [R - r, 0], via: [R - c, c] },
    { to: [R, -r], via: [R - c, -c] },
    { to: [R + r, 0], via: [R + c, -c] },
  ] };
}
