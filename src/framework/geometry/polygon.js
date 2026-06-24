// 2-D polygon helpers shared by parts that call kernel.prism().

// CCW polygon points for a circular-sector "pie" from the origin, radius tipR.
export function piePolygon(tipR, arcDeg, segs = 32) {
  const a = (arcDeg * Math.PI) / 180;
  const pts = [[0, 0]];
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  for (let i = 0; i <= steps; i++) {
    const t = (a * i) / steps;
    pts.push([tipR * Math.cos(t), tipR * Math.sin(t)]);
  }
  return pts;
}

// Vertex-up regular hexagon, circumradius r (flats facing ±X).
export function hexPolygon(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Rectangle w×h centred at the origin with radius-r corners (r clamped to min(w,h)/2).
export function roundedRectPolygon(w, h, r, segs = 8) {
  r = Math.min(r, Math.min(w, h) / 2);
  const hw = w / 2, hh = h / 2;
  if (r <= 0) return [[hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]];
  const corners = [
    [hw - r, hh - r, 0],                 // top-right
    [-(hw - r), hh - r, Math.PI / 2],    // top-left
    [-(hw - r), -(hh - r), Math.PI],     // bottom-left
    [hw - r, -(hh - r), (3 * Math.PI) / 2], // bottom-right
  ];
  const pts = [];
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= segs; i++) {
      const a = a0 + (Math.PI / 2) * (i / segs);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  return pts;
}

// Regular n-gon, circumradius r. Vertex up by default; flat:true puts a flat edge up.
export function regularPolygon(n, r, { flat = false } = {}) {
  const base = Math.PI / 2 + (flat ? Math.PI / n : 0);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = base + (2 * Math.PI * i) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

// Ellipse with semi-axes rx, ry.
export function ellipsePolygon(rx, ry, segs = 48) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([rx * Math.cos(a), ry * Math.sin(a)]);
  }
  return pts;
}

// Stadium/obround slot: two r-radius semicircles whose centres are `length` apart
// (overall length = length + 2r), centred at the origin, long axis along X.
export function slotPolygon(length, r, segs = 16) {
  const hl = length / 2;
  const pts = [];
  for (let i = 0; i <= segs; i++) { const a = -Math.PI / 2 + Math.PI * (i / segs); pts.push([hl + r * Math.cos(a), r * Math.sin(a)]); }
  for (let i = 0; i <= segs; i++) { const a = Math.PI / 2 + Math.PI * (i / segs); pts.push([-hl + r * Math.cos(a), r * Math.sin(a)]); }
  return pts;
}

// Star with `points` tips, alternating outer/inner radius. First tip points up.
export function starPolygon(points, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / points;
    const rr = i % 2 === 0 ? outerR : innerR;
    pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return pts;
}

// Annular sector as a single closed contour (outer arc, then inner arc back).
// arcDeg must be < 360 — a full annulus is a contour-with-hole; cut an inner
// cylinder from an outer one for a full ring.
export function ringSectorPolygon(innerR, outerR, arcDeg, segs = 32) {
  if (arcDeg >= 360) throw new Error("ringSectorPolygon: arcDeg must be < 360 (use a cut for a full ring)");
  const a = (arcDeg * Math.PI) / 180;
  const steps = Math.max(2, Math.ceil((segs * arcDeg) / 360));
  const pts = [];
  for (let i = 0; i <= steps; i++) { const t = (a * i) / steps; pts.push([outerR * Math.cos(t), outerR * Math.sin(t)]); }
  for (let i = steps; i >= 0; i--) { const t = (a * i) / steps; pts.push([innerR * Math.cos(t), innerR * Math.sin(t)]); }
  return pts;
}

const PATTERN_AXIS = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

// `count` copies of `solid` translated by i*step ([dx,dy,dz]) for i in 0..count-1.
// Returns a Solid[] — feed to k.union(...) (features) or s.cutAll(...) (holes).
export function linearPattern(solid, count, step) {
  const out = [];
  for (let i = 0; i < count; i++)
    out.push(solid.clone().translate([step[0] * i, step[1] * i, step[2] * i]));
  return out;
}

// `count` copies spaced angle/count degrees apart around `axis` through `center`.
// rotateCopies:true re-orients each copy to face along the circle; false places it
// at the orbital position with its original orientation (for radially symmetric tools).
export function circularPattern(solid, count, { center = [0, 0, 0], axis = "Z", angle = 360, rotateCopies = true } = {}) {
  const ax = Array.isArray(axis) ? axis : PATTERN_AXIS[axis];
  const out = [];
  for (let i = 0; i < count; i++) {
    const deg = (angle / count) * i;
    const placed = solid.clone().rotate(deg, center, ax);
    if (rotateCopies) { out.push(placed); continue; }
    // cancel the orientation change by counter-rotating about the copy's own centre
    const c = placed.boundingBox().center;
    out.push(placed.rotate(-deg, c, ax));
  }
  return out;
}
