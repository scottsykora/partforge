// Pure (WASM-free) helpers for materializing a 2-D boolean result into region
// arrays. assembleRegions groups a flat set of point-rings into {outer,holes}
// regions by winding + point-in-polygon nesting. svgPathToRings discretizes a
// replicad Drawing's SVG path (from toSVGPathD) into rings, reusing F1's
// sampleBezier / sampleArc so an OCCT-materialized curve facets like Manifold.
import { sampleBezier, sampleArc } from "./profile.js";

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

// Minimal SVG-path tokenizer for the absolute commands replicad emits: M, L, C,
// A, Z (and their explicit forms). Coordinates are numbers separated by spaces
// or commas. One subpath (M…Z) → one ring; the start point is not duplicated.
export function svgPathToRings(d, segs) {
  const toks = d.match(/[MLCAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const rings = [];
  let ring = null, cur = null, start = null, i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    const t = toks[i++];
    if (t === "M") { if (ring && ring.length >= 3) rings.push(ring); cur = start = [num(), num()]; ring = [cur.slice()]; }
    else if (t === "L") { cur = [num(), num()]; ring.push(cur.slice()); }
    else if (t === "C") {
      const c1 = [num(), num()], c2 = [num(), num()], end = [num(), num()];
      for (const p of sampleBezier(cur, c1, c2, end, segs)) ring.push(p);
      cur = end;
    }
    else if (t === "A") {
      // SVG elliptical arc: rx ry rot largeArc sweep x y. Treated as circular
      // (rx≈ry) via the three-point sampleArc: midpoint of the chord bulged by
      // the sagitta is a good `via`. If replicad never emits A (see Task 4), this
      // branch is dead but harmless.
      const rx = num(), ry = num(); num(); const large = num(), sweep = num(); const end = [num(), num()];
      const r = (rx + ry) / 2;
      const mx = (cur[0] + end[0]) / 2, my = (cur[1] + end[1]) / 2;
      const dx = end[0] - cur[0], dy = end[1] - cur[1], dist = Math.hypot(dx, dy) || 1e-9;
      const h2 = Math.max(0, r * r - (dist / 2) ** 2) ** 0.5;
      const sign = (large === sweep) ? 1 : -1;   // bulge side
      const via = [mx + sign * h2 * (-dy / dist), my + sign * h2 * (dx / dist)];
      for (const p of sampleArc(cur, via, end, segs)) ring.push(p);
      cur = end;
    }
    else if (t === "Z") { if (ring && ring.length >= 3) rings.push(ring); ring = null; }
  }
  if (ring && ring.length >= 3) rings.push(ring);
  return rings;
}
