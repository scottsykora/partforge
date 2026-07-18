// Pure (WASM-free) helpers for materializing a 2-D boolean result into region
// arrays. assembleRegions groups a flat set of point-rings into {outer,holes}
// regions by winding + point-in-polygon nesting. svgPathToRings discretizes a
// replicad Drawing's SVG path (from toSVGPathD) into rings, reusing F1's
// sampleBezier / sampleArc so an OCCT-materialized curve facets like Manifold.
import { sampleBezier } from "./profile.js";

const ringArea = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
};

// Ray-cast point-in-polygon (even-odd). ring: [[x,y],…].
function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Group rings: positive-area rings are outers, negative-area are holes; nest each
// hole into the smallest-area outer that contains its first vertex.
export function assembleRegions(rings) {
  const outers = [], holes = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    (ringArea(r) >= 0 ? outers : holes).push(r);
  }
  const regions = outers.map((outer) => ({ outer, holes: [] }));
  regions.sort((a, b) => Math.abs(ringArea(a.outer)) - Math.abs(ringArea(b.outer)));
  for (const hole of holes) {
    const home = regions.find((rg) => pointInRing(hole[0], rg.outer));
    if (home) home.holes.push(hole);
  }
  // largest-first for a stable, readable order
  regions.sort((a, b) => Math.abs(ringArea(b.outer)) - Math.abs(ringArea(a.outer)));
  return regions;
}

// Net area of assembled regions: Σ|outer| − Σ|holes|.
export function regionsArea(regions) {
  let a = 0;
  for (const rg of regions) {
    a += Math.abs(ringArea(rg.outer));
    for (const hole of rg.holes) a -= Math.abs(ringArea(hole));
  }
  return a;
}

// Sample an SVG elliptical-arc segment (endpoint parameterization → center form,
// W3C SVG 1.1 notes F.6) from `from` to `to` into points AFTER `from` (last pinned
// to `to`), honoring rx/ry/x-rotation and the large-arc/sweep flags. Exact for the
// semicircle case a three-point circle fit degenerates on.
function sampleSvgArc(from, rx, ry, rotDeg, largeArc, sweep, to, segs) {
  const [x1, y1] = from, [x2, y2] = to;
  if (rx === 0 || ry === 0) return [[x2, y2]];
  const phi = (rotDeg * Math.PI) / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let RX = Math.abs(rx), RY = Math.abs(ry);
  const lambda = (x1p * x1p) / (RX * RX) + (y1p * y1p) / (RY * RY);
  if (lambda > 1) { const s = Math.sqrt(lambda); RX *= s; RY *= s; }
  const numr = RX * RX * RY * RY - RX * RX * y1p * y1p - RY * RY * x1p * x1p;
  const den = RX * RX * y1p * y1p + RY * RY * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, numr / den));
  if (Boolean(largeArc) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * RX * y1p) / RY, cyp = (-coef * RY * x1p) / RX;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy, len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12;
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / RX, (y1p - cyp) / RY);
  let dTheta = angle((x1p - cxp) / RX, (y1p - cyp) / RY, (-x1p - cxp) / RX, (-y1p - cyp) / RY);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil((segs * Math.abs(dTheta)) / (2 * Math.PI)));
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + dTheta * (i / steps);
    const ex = RX * Math.cos(t), ey = RY * Math.sin(t);
    out.push([cx + cosP * ex - sinP * ey, cy + sinP * ex + cosP * ey]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

// Minimal SVG-path tokenizer for the absolute commands replicad emits: M, L, C,
// Q, A, Z. Coordinates are numbers separated by spaces or commas; a command may
// be followed by several coordinate sets (implicit repeat). One subpath (M…Z) →
// one ring; the start point is not duplicated. Throws on unsupported commands.
export function svgPathToRings(d, segs) {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const rings = [];
  let ring = null, cur = [0, 0], cmd = null, i = 0;
  const num = () => Number(toks[i++]);
  const pt = () => [num(), num()];
  const pushRing = () => { if (ring && ring.length >= 3) rings.push(ring); ring = null; };
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) {
      cmd = toks[i++];
      if (!"MLCQAZ".includes(cmd)) throw new Error(`svgPathToRings: unsupported SVG command "${cmd}"`);
    }
    if (cmd === "M") { pushRing(); cur = pt(); ring = [cur.slice()]; cmd = "L"; }
    else if (cmd === "L") { cur = pt(); ring.push(cur.slice()); }
    else if (cmd === "C") { const c1 = pt(), c2 = pt(), end = pt(); for (const p of sampleBezier(cur, c1, c2, end, segs)) ring.push(p); cur = end; }
    else if (cmd === "Q") {
      const q = pt(), end = pt();
      const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
      const c2 = [end[0] + (2 / 3) * (q[0] - end[0]), end[1] + (2 / 3) * (q[1] - end[1])];
      for (const p of sampleBezier(cur, c1, c2, end, segs)) ring.push(p); cur = end;
    }
    else if (cmd === "A") {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), end = pt();
      for (const p of sampleSvgArc(cur, rx, ry, rot, large, sweep, end, segs)) ring.push(p); cur = end;
    }
    else if (cmd === "Z") { pushRing(); }
    else throw new Error("svgPathToRings: coordinate before any command");
  }
  pushRing();
  return rings;
}
