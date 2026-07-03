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

// Per-corner rounding geometry, shared verbatim by filletPolygon (which tessellates it)
// and roundedProfile (which emits it as a symbolic arc). Given a corner p0→p1→p2 and a
// requested radius r, returns the incoming/outgoing tangent points `a`/`b`, the arc centre
// `c`, the clamped radius `rr`, the short sweep `dA`, and the incoming start angle `a0` —
// or null for a corner that must stay sharp (zero-length edge or a straight/180° corner).
// The per-corner clamp (t ≤ min(l0,l2)/2) keeps neighbouring arcs from overlapping.
// Extracting this means the two consumers can never diverge on clamping/winding.
export function cornerArc(p0, p1, p2, r) {
  let v0 = [p0[0] - p1[0], p0[1] - p1[1]], v2 = [p2[0] - p1[0], p2[1] - p1[1]];
  const l0 = Math.hypot(v0[0], v0[1]), l2 = Math.hypot(v2[0], v2[1]);
  if (l0 < 1e-9 || l2 < 1e-9) return null;               // zero-length edge → sharp
  v0 = [v0[0] / l0, v0[1] / l0]; v2 = [v2[0] / l2, v2[1] / l2];
  const cosA = Math.max(-1, Math.min(1, v0[0] * v2[0] + v0[1] * v2[1]));
  const half = Math.acos(cosA) / 2;                      // half the corner's interior angle
  let bis = [v0[0] + v2[0], v0[1] + v2[1]];
  const bl = Math.hypot(bis[0], bis[1]);
  if (half < 1e-6 || bl < 1e-9) return null;             // straight (180°) corner → sharp
  bis = [bis[0] / bl, bis[1] / bl];
  let rr = r, t = r / Math.tan(half);                    // tangent setback along each edge
  const tmax = Math.min(l0, l2) / 2;                     // clamp: never past an edge midpoint
  if (t > tmax) { t = tmax; rr = t * Math.tan(half); }
  const a = [p1[0] + v0[0] * t, p1[1] + v0[1] * t];      // tangent point on the incoming edge
  const b = [p1[0] + v2[0] * t, p1[1] + v2[1] * t];      // tangent point on the outgoing edge
  const c = [p1[0] + bis[0] * (rr / Math.sin(half)), p1[1] + bis[1] * (rr / Math.sin(half))]; // arc center
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let dA = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;     // sweep the SHORT arc from a to b
  while (dA <= -Math.PI) dA += 2 * Math.PI;
  while (dA > Math.PI) dA -= 2 * Math.PI;
  return { a, b, c, rr, dA, a0 };
}

// Round every corner of a CCW polygon: each vertex is replaced by a tangent circular
// arc of radius r, tessellated with `segs` segments per corner (default 8, matching
// roundedRectPolygon). Returns a plain [[x,y],…] point list usable by prism/extrude/loft
// on BOTH kernels by construction. Corners are CLAMPED per-corner: r is reduced so an
// arc's tangent points never pass the midpoint of either adjacent edge, so neighbouring
// rounded corners can never overlap (pass a very large r to fully round every corner).
// Intended for convex CCW outlines (brackets, gussets, pads, knob/star profiles); a
// reflex corner is still rounded but its arc is placed on the angle bisector.
// NOTE: bakes each arc into `segs` straight facets, so STEP export of a filletPolygon
// part has faceted (LINE) corners; for mathematically-true CIRCLE corners in STEP use
// roundedProfile, which carries the arc symbolically to both backends.
export function filletPolygon(points, r, { segs = 8 } = {}) {
  const n = points.length;
  if (n < 3) throw new Error("filletPolygon: need at least 3 points");
  if (!(r > 0)) throw new Error("filletPolygon: r must be > 0");
  const out = [];
  for (let i = 0; i < n; i++) {
    const arc = cornerArc(points[(i - 1 + n) % n], points[i], points[(i + 1) % n], r);
    if (!arc) { out.push([points[i][0], points[i][1]]); continue; } // sharp corner
    const { c, rr, dA, a0 } = arc;
    for (let s = 0; s <= segs; s++) {
      const ang = a0 + dA * (s / segs);
      out.push([c[0] + rr * Math.cos(ang), c[1] + rr * Math.sin(ang)]);
    }
  }
  return out;
}

// Arc-aware sibling of filletPolygon: rounds the corners of a CCW polygon with the SAME
// tangent/centre/sweep math (via cornerArc), but instead of tessellating each arc into
// line facets it emits a canonical ArcContour { start, segments:[{to}|{to,via}], arc:true }
// that carries the arc SYMBOLICALLY. Feed it to prism/extrude (not loft yet): OCCT builds a
// true CIRCLE B-rep edge (exact STEP fillets) while Manifold tessellates the same spec, so
// both kernels agree by construction. `r` is a scalar (every corner) or a per-corner array
// r[] (length === points.length; a 0 or a degenerate corner stays sharp — a plain line).
export function roundedProfile(points, r) {
  const n = points.length;
  if (n < 3) throw new Error("roundedProfile: need at least 3 points");
  const radii = Array.isArray(r) ? r : null;
  if (radii && radii.length !== n)
    throw new Error("roundedProfile: r[] length must match points length");
  if (!radii && !(r >= 0)) throw new Error("roundedProfile: r must be ≥ 0 (or a per-corner r[]); 0 keeps every corner sharp");
  const segments = [];
  let start = null;
  const lineTo = (p) => { if (start === null) start = [p[0], p[1]]; else segments.push({ to: [p[0], p[1]] }); };
  for (let i = 0; i < n; i++) {
    const p1 = points[i];
    const ri = radii ? radii[i] : r;
    const arc = ri > 0 ? cornerArc(points[(i - 1 + n) % n], p1, points[(i + 1) % n], ri) : null;
    if (!arc) { lineTo(p1); continue; }                  // sharp / degenerate corner → plain vertex
    const { a, b, c, rr, dA, a0 } = arc;
    lineTo(a);                                           // straight run into the incoming tangent point
    const mid = a0 + dA / 2;                             // arc midpoint (three-point via — sign/winding-free)
    segments.push({ to: [b[0], b[1]], via: [c[0] + rr * Math.cos(mid), c[1] + rr * Math.sin(mid)] });
  }
  return { start, segments, arc: true };
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

// CCW circle of radius r centered at [cx, cy]. A shared 2-D profile primitive:
// compose with the kernel's profile ops — e.g. revolve(circleProfile(minorR,
// [majorR, 0])) is a torus, prism(circleProfile(r), h) a cylinder.
export function circleProfile(r, center = [0, 0], segs = 48) {
  if (!(r > 0)) throw new Error("circleProfile: r must be > 0");
  const [cx, cy] = center;
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}
