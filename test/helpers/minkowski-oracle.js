// An INDEPENDENT offset oracle, built from the definition of the operation rather than from
// anybody's offsetter.
//
// Why this exists: the repo's other oracle (test/offset-oracle-manifold.test.js) calls
// Clipper2's own `CrossSection.offset()`, so when it disagrees with the native engine there
// is no third opinion — and Clipper2's chamfer mapping (Round @ circularSegments = 4) is
// demonstrably NOT this engine's chamfer at acute corners: task 7B chased 15 apparent
// regressions and 10 of them were Clipper2 being wrong, confirmed by this construction
// (radial2 at +3.5/sharp: Clipper2 497.890108, this oracle 467.495444, native 467.495444).
//
// The construction, for a shape S and radius r > 0:
//
//   dilate(S, r) = S  ∪  ⋃(outward edge slabs)  ∪  ⋃(caps at convex vertices)
//   erode (S, r) = Box \ dilate(Box \ S, r)
//
// The first identity is exact for any valid region: a point of S ⊕ B outside S has a nearest
// boundary point that is either interior to an edge (→ that edge's outward slab) or a vertex,
// and a vertex only has a nonempty outward normal cone when it is convex (→ that vertex's
// cap). For `round` the cap is the exact circular sector (approximated by `fan` facets), so
// the answer converges to the true Minkowski sum with a disk; for `chamfer` it is the chord
// triangle and for `sharp` the miter quad under the engine's own MITER_LIMIT, which is what
// makes those two exact rather than approximate.
//
// Clipper2 (via manifold-3d's CrossSection) appears ONLY as a polygon-set assembler: every
// piece above is emitted CCW and handed to `ofPolygons(..., "Positive")`, so the union is the
// winding > 0 region and no boolean loop is needed at all. `.offset()` is never called. That
// is the whole point — an oracle that used Clipper2's offsetter would be testing Clipper2
// against itself.
//
// The caller boots manifold and passes `CrossSection` in, so this file imports nothing from
// manifold-3d and cannot drag an OCCT-hostile WASM boot into a test file that did not ask
// for one (see AGENTS.md: OCCT and Manifold must not boot in the same process).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (v) => Math.hypot(v[0], v[1]);
const norm = (v) => { const L = len(v) || 1; return [v[0] / L, v[1] / L]; };
// Outward normal under the repo's storage winding (outer CCW, holes CW): right of travel
// always points away from the filled interior. contour-offset.js offsets along this same
// normal, which is what makes the two directly comparable.
const rightOf = ([tx, ty]) => [ty, -tx];
const MITER_LIMIT = 2;                              // matches contour-offset.js

const ringArea2 = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
};
const ccw = (poly) => (ringArea2(poly) < 0 ? poly.slice().reverse() : poly);

// Drop the duplicated closing vertex some producers emit, plus any coincident neighbours —
// a zero-length edge has no direction, so it would contribute a garbage normal.
function clean(ring) {
  const out = [];
  for (const p of ring) if (!out.length || len(sub(out.at(-1), p)) > 1e-12) out.push([p[0], p[1]]);
  while (out.length > 1 && len(sub(out[0], out.at(-1))) <= 1e-12) out.pop();
  return out;
}

// The pieces of dilate(rings, r): the rings themselves (in their own winding, so holes still
// subtract), plus one CCW slab per edge and one CCW cap per convex vertex.
function dilatePolygons(rings, r, corners, fan) {
  const polys = [];
  for (const raw of rings) {
    const ring = clean(raw);
    if (ring.length < 3) continue;
    polys.push(ring);                                       // keeps its own sign
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const p = ring[i], q = ring[(i + 1) % m];
      const n = rightOf(norm(sub(q, p)));
      polys.push(ccw([p, q, [q[0] + n[0] * r, q[1] + n[1] * r], [p[0] + n[0] * r, p[1] + n[1] * r]]));
    }
    for (let i = 0; i < m; i++) {
      const v = ring[i], prev = ring[(i - 1 + m) % m], next = ring[(i + 1) % m];
      const inDir = norm(sub(v, prev)), outDir = norm(sub(next, v));
      if (cross(inDir, outDir) <= 1e-12) continue;           // reflex/straight: no outward cone
      const n1 = rightOf(inDir), n2 = rightOf(outDir);
      const a = [v[0] + n1[0] * r, v[1] + n1[1] * r], b = [v[0] + n2[0] * r, v[1] + n2[1] * r];
      if (corners === "chamfer") { polys.push(ccw([v, a, b])); continue; }
      if (corners === "sharp") {
        // Miter apex on the angle bisector, at r / cos(half-exterior-angle); beyond the miter
        // limit contour-offset.js falls back to the bevel, so this does too.
        const bis = norm([n1[0] + n2[0], n1[1] + n2[1]]);
        const cosHalf = (bis[0] * n1[0] + bis[1] * n1[1]);
        const d = cosHalf > 1e-9 ? r / cosHalf : Infinity;
        if (d <= MITER_LIMIT * r) { polys.push(ccw([v, a, [v[0] + bis[0] * d, v[1] + bis[1] * d], b])); continue; }
        polys.push(ccw([v, a, b]));
        continue;
      }
      // round: the exact circular sector, sampled at `fan` facets per full turn
      const a0 = Math.atan2(n1[1], n1[0]);
      let sweep = Math.atan2(n2[1], n2[0]) - a0;
      while (sweep <= 0) sweep += 2 * Math.PI;
      while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
      const steps = Math.max(1, Math.ceil((sweep / (2 * Math.PI)) * fan));
      const arc = [v];
      for (let s = 0; s <= steps; s++) {
        const t = a0 + (sweep * s) / steps;
        arc.push([v[0] + Math.cos(t) * r, v[1] + Math.sin(t) * r]);
      }
      polys.push(ccw(arc));
    }
  }
  return polys;
}

// regions: [{ outer: [[x,y],…], holes: [[[x,y],…],…] }] in storage winding (outer CCW,
// holes CW). Returns a factory bound to one booted CrossSection.
export function minkowskiOracle(CrossSection) {
  const positive = (polys) => CrossSection.ofPolygons(polys, "Positive");
  const ringsOf = (regions) => regions.flatMap((rg) => [rg.outer, ...(rg.holes ?? [])]);

  // dilate: rings in, CrossSection out.
  const dilateRings = (rings, r, corners, fan) => positive(dilatePolygons(rings, r, corners, fan));

  // Bounding box, padded well past r so the complement's own outer boundary never interferes.
  function boxOf(rings, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [[x0 - pad, y0 - pad], [x1 + pad, y0 - pad], [x1 + pad, y1 + pad], [x0 - pad, y1 + pad]];
  }

  return {
    /** dilate(regions, r) — r > 0. Returns a CrossSection. */
    dilate(regions, r, { corners = "round", fan = 512 } = {}) {
      return dilateRings(ringsOf(regions), r, corners, fan);
    },
    /** erode(regions, r) — r > 0, by complement duality. Returns a CrossSection. */
    erode(regions, r, { corners = "round", fan = 512 } = {}) {
      const rings = ringsOf(regions);
      const box = boxOf(rings, 4 * r + 10);
      // Complement = box ∪ reversed shape rings: the outer becomes a hole of the box, each
      // hole becomes a solid island. Reversing every ring is exactly that relabelling, and it
      // leaves the complement in storage winding so the same outward-normal rule applies.
      const comp = [box, ...rings.map((rg) => clean(rg).slice().reverse())];
      return positive([box]).subtract(dilateRings(comp, r, corners, fan));
    },
    /** Signed-area convenience: offset(regions, delta) with delta of either sign. */
    offset(regions, delta, opts = {}) {
      if (delta === 0) return positive(ringsOf(regions));
      return delta > 0 ? this.dilate(regions, delta, opts) : this.erode(regions, -delta, opts);
    },
    area(regions, delta, opts = {}) {
      const cs = this.offset(regions, delta, opts);
      const a = cs.area();
      cs.delete?.();
      return a;
    },
  };
}
