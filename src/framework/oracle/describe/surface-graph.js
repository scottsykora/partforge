// Patches -> the attributed adjacency graph (Joshi & Chang 1988), the structure every
// feature rule in features/ is written against. Nodes are surfaces; arcs are the
// shared boundaries between them, each labelled convex or concave and carrying its own
// geometry.
//
// TWO attributes come out of here, and confusing them is the trap this file exists to
// close (controller ruling R10, found when Task 1's fixture review contradicted itself).
//
// ARC convexity says whether an edge is an outer or an inner corner, and nothing more. It
// is decided by the interior dihedral measured through the material: under 180° convex,
// over 180° concave. A through-hole's rim leaves a 90° wedge of material and is CONVEX —
// exactly like the outer edge of the same plate. A pocket floor or a boss base leaves 270°
// and is CONCAVE. So arc convexity cannot, on its own, tell a hole from a boss: it is the
// same label on both.
//
// SURFACE curvature is what does tell them apart. A bore is a concave cylinder — its
// outward normals point toward its own axis — while a shaft or a boss is a convex one,
// normals pointing away. That sign is a property of the surface, not of any edge, and it
// survives tessellation density, partial arcs, and whatever the neighbouring faces do.
//
// Both are derived here, once, and every feature rule downstream reads them rather than
// recomputing either.
//
// An arc's convexity is the SIGN-MAJORITY of its constituent edges weighted by length,
// not the first edge's label. A tessellated circular seam has a handful of edges whose
// individual dihedral wobbles around zero at the facet joins; taking one of them as
// the verdict makes a hole intermittently read as a boss.
//
// Pure leaf. See spec §2.4.
import { fitPlane, fitSphere, fitCylinder, fitCone, fitTorus, intrinsicScale } from "./fit.js";
import { facePoints, FIT_TOL_FRAC } from "./segment.js";

const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

// A patch pair is joined by an arc only if their shared boundary has at least this
// many edges. Left at 1 (every real adjacency clears it trivially) rather than
// deleted, same reasoning as segment.js's MIN_PATCH_FACES: the one knob a future
// revision would raise to also discard a stray single-facet contact as noise.
const MIN_ARC_EDGES = 1;
// Circularity band: an arc is a circle when its edge midpoints are equidistant from
// their own centroid to within this fraction of the mean radius.
const CIRCLE_TOL_FRAC = 0.02;

const vertOf = (topo, v) => [topo.verts[3*v], topo.verts[3*v+1], topo.verts[3*v+2]];

// Classify an arc's shape from its edge midpoints. Straight arcs have collinear
// midpoints; circular arcs have midpoints on a common circle. Anything else is
// "mixed" and no rule is allowed to assume geometry about it.
function arcKind(pts) {
  if (pts.length < 3) return { kind: "line", radius: null, axis: null, center: null };
  const c = pts.reduce((a, p) => [a[0]+p[0]/pts.length, a[1]+p[1]/pts.length, a[2]+p[2]/pts.length], [0,0,0]);
  const radii = pts.map((p) => dist(p, c));
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (mean < 1e-12) return { kind: "line", radius: null, axis: null, center: null };
  const spread = Math.max(...radii.map((r) => Math.abs(r - mean))) / mean;
  if (spread > CIRCLE_TOL_FRAC) {
    // Not a circle. Collinear midpoints are the common case here — one straight
    // edge chain, e.g. a box corner — and must not be reported as a huge-radius
    // circle just because a handful of points near-collinear technically have
    // *some* circumscribing circle.
    const d0 = sub(pts[1], pts[0]);
    const len = Math.hypot(d0[0], d0[1], d0[2]);
    const straight = len > 0 && pts.every((p) => {
      const d = sub(p, pts[0]);
      const t = dot(d, d0) / (len*len);
      return Math.hypot(d[0]-t*d0[0], d[1]-t*d0[1], d[2]-t*d0[2]) < len * CIRCLE_TOL_FRAC;
    });
    return { kind: straight ? "line" : "mixed", radius: null, axis: null, center: null };
  }
  // Circle: the axis is the normal of the plane the midpoints lie in, taken from
  // the first three points — conditioned well enough for a genuine circular seam,
  // whose points are never near-collinear (that path already returned above).
  const a = sub(pts[1], pts[0]), b = sub(pts[2], pts[0]);
  const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  return { kind: "circle", radius: mean, axis: [n[0]/nl, n[1]/nl, n[2]/nl], center: c };
}

// Does this curved patch bend away from its own centre of curvature, or around it?
// Take each face's outward normal against the radial vector from the surface's own
// axis (or centre, for a sphere) out to that face's centroid: a normal pointing
// outward (same sense as the radial vector) means a convex surface — a shaft, a
// boss, a plate's outer wall. A normal pointing back toward the axis means a
// concave one — a bore. Area-weighted so one bad facet normal cannot flip the
// verdict on a large patch built from many small ones.
//
// Planes get null: a plane has no centre and no side, and forcing it into this
// vocabulary would invent a distinction the geometry does not carry.
function curvatureOf(topo, patch) {
  const fit = patch.fit;
  const centre = fit.type === "cylinder" ? fit.axis.origin
               : fit.type === "cone" ? fit.apex
               : fit.type === "sphere" ? fit.center
               : fit.type === "torus" ? fit.center : null;
  if (!centre) return null;
  const axis = fit.type === "cylinder" ? fit.axis.direction
             : fit.type === "cone" ? fit.direction
             : fit.type === "torus" ? fit.axis : null;
  let vote = 0;
  for (const t of patch.faces) {
    const c = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = topo.tris[3*t + k] * 3;
      for (let a = 0; a < 3; a++) c[a] += topo.verts[v + a] / 3;
    }
    let radial = sub(c, centre);
    if (axis) {
      // Only the component perpendicular to the axis is radial; the axial part
      // (how far along the bore/boss the face sits) says nothing about which
      // way the surface curves and would only dilute the vote.
      const ax = dot(radial, axis);
      radial = [radial[0]-ax*axis[0], radial[1]-ax*axis[1], radial[2]-ax*axis[2]];
    }
    const rl = Math.hypot(radial[0], radial[1], radial[2]);
    if (rl < 1e-12) continue;   // a face centred on its own axis has no radial direction to vote with
    const n = [topo.faceNormal[3*t], topo.faceNormal[3*t+1], topo.faceNormal[3*t+2]];
    vote += topo.faceArea[t] * dot(n, radial) / rl;
  }
  if (Math.abs(vote) < 1e-12) return null;
  return vote > 0 ? "convex" : "concave";
}

// `fitPlane`'s normal sign is an artifact of the eigensolver's own convention (whichever
// way the smallest-eigenvalue eigenvector happened to point), not tied to which side the
// material is on (controller ruling R31). Task 6 verified this directly: a washer's two
// caps — translated copies of the same ring shape, hence identical PCA covariance — both
// come back with fit.normal = (0,0,1), never the physically opposite pair the caps
// actually have. Left uncorrected, this breaks the pocket-vs-boss rule below (it compares
// SIGNED cap displacement, meaningless against an arbitrary sign) and makes the report's
// own `surfaces[].fit.normal` actively misstate which way a face points.
//
// Fixed here, once, so every consumer inherits an outward-pointing normal rather than an
// arbitrary one: average this patch's OWN faces' outward normals — `topo.faceNormal` is
// outward by construction, exactly what this file's header says every dihedral sign
// already depends on — and if the fitted normal opposes that average, negate BOTH
// `normal` and `offset` together. Flipping only one would silently break `offset = dot
// (normal, pointOnPlane)`, not just leave the direction looking wrong.
function orientPlaneOutward(topo, patch) {
  const fit = patch.fit;
  if (fit.type !== "plane") return fit;
  const meanN = [0, 0, 0];
  for (const t of patch.faces) {
    const a = topo.faceArea[t];
    meanN[0] += a * topo.faceNormal[3*t]; meanN[1] += a * topo.faceNormal[3*t+1]; meanN[2] += a * topo.faceNormal[3*t+2];
  }
  if (dot(meanN, fit.normal) >= 0) return fit;
  return { ...fit, normal: [-fit.normal[0], -fit.normal[1], -fit.normal[2]], offset: -fit.offset };
}

// Do two fits describe the same surface? Same primitive type, and parameters agreeing
// within a relative band — coaxial cylinders of equal radius, coplanar planes of equal
// normal and offset, and so on. Relative, never absolute: these are millimetre parts but
// the code must not assume a scale. Compare directions with |dot| so an antiparallel axis
// (the same line, traversed the other way) still matches.
const SAME_REL = 1e-3;
const closeRel = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1) * SAME_REL;
const sameDir = (a, b) => Math.abs(dot(a, b)) > 1 - SAME_REL;

// Exported for direct unit testing only (the module's real contract is
// `surfaceGraph`/`arcsOf`): the post-merge residual guard in `mergeCoFamily` makes
// most position mismatches large enough to also fail on refit residual alone, at
// this file's own tolerance scale, which would otherwise mask a regression in this
// function's own position checks behind that second, coarser safety net. Testing
// this directly against fabricated fit-parameter objects (no mesh required)
// exercises the exact band each branch checks, independent of that backstop.
export function sameSurface(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === "plane") {
    if (!sameDir(a.normal, b.normal)) return false;
    // `offset` is `dot(normal, pointOnPlane)`, so it is only comparable between
    // fits whose normals point the SAME way. Comparing |offset| independently
    // (rather than canonicalizing orientation first) is wrong, not merely
    // imprecise: a plate centred on the origin has its two opposite faces at
    // z=-t/2 and z=+t/2, with outward normals (0,0,-1) and (0,0,1) — offsets
    // dot((0,0,-1),(0,0,-t/2))=t/2 and dot((0,0,1),(0,0,t/2))=t/2 come out
    // IDENTICAL in magnitude for two genuinely different, parallel-but-distinct
    // planes. Flipping the antiparallel one's (normal, offset) pair together
    // before comparing raw offsets is what tells that case apart from the same
    // plane seen through two windings (see ransac.js's planeHypothesis for the
    // same flip, applied for the same reason).
    const bOffset = dot(a.normal, b.normal) < 0 ? -b.offset : b.offset;
    return closeRel(a.offset, bOffset);
  }
  if (a.type === "sphere") return closeRel(a.radius, b.radius) && closeRel(0, dist(a.center, b.center));
  if (a.type === "cylinder") {
    // Coaxial means parallel AND collinear: parallel axes at different offsets are two
    // different bores of the same size, which must NOT merge.
    const d = sub(a.axis.origin, b.axis.origin);
    const along = dot(d, b.axis.direction);
    const perp = Math.hypot(d[0]-along*b.axis.direction[0], d[1]-along*b.axis.direction[1], d[2]-along*b.axis.direction[2]);
    return closeRel(a.radius, b.radius) && sameDir(a.axis.direction, b.axis.direction) && perp <= a.radius * SAME_REL;
  }
  if (a.type === "cone") return sameDir(a.direction, b.direction) && closeRel(a.halfAngle, b.halfAngle) && closeRel(0, dist(a.apex, b.apex));
  if (a.type === "torus") {
    // Same shape (axis direction, both radii) is NOT the same surface without also
    // checking POSITION — every other branch above gates on it (plane: offset;
    // sphere/cone: centre/apex distance; cylinder: perpendicular offset from the
    // axis), and the torus branch originally didn't, which is exactly the kind of
    // gap this file's header warns about: two unrelated O-ring grooves of the same
    // size, on the same shaft but at different heights, or two identical grooves at
    // opposite ends of a part, share axis direction and both radii and would merge
    // into one impossible surface. Same decomposition as the cylinder branch: split
    // centre-to-centre into the component ALONG the axis (must be small — two
    // coaxial grooves at different heights are different grooves) and the
    // component PERPENDICULAR to it (must be small — two grooves off to the side
    // of each other, sharing a parallel axis, are different grooves too).
    const d = sub(a.center, b.center);
    const along = dot(d, b.axis);
    const perp = Math.hypot(d[0]-along*b.axis[0], d[1]-along*b.axis[1], d[2]-along*b.axis[2]);
    return sameDir(a.axis, b.axis) && closeRel(a.majorRadius, b.majorRadius) && closeRel(a.minorRadius, b.minorRadius)
      && perp <= a.majorRadius * SAME_REL && Math.abs(along) <= a.majorRadius * SAME_REL;
  }
  return false;
}

// Re-run one specific fit over a merged patch's points. Not `bestFit`: the merged patch is
// already classified, and re-classifying could flip its type on a fragment boundary.
const REFITTERS = {
  plane: (pts) => fitPlane(pts),
  sphere: (pts) => fitSphere(pts),
  cylinder: (pts, normals) => fitCylinder(pts, normals),
  cone: (pts, normals) => fitCone(pts, normals),
  torus: (pts, normals) => fitTorus(pts, normals),
};
const refitAs = (type, pts, normals) => REFITTERS[type]?.(pts, normals) ?? null;

// Adjacent patches describing the SAME surface, merged before anything is numbered.
// Segmentation can split one true surface in two — a bore tessellated coarse on one half
// and fine on the other splits into two coaxial cylinder patches of identical radius
// (controller ruling R25). Left unmerged those become two `surfaces`, and because Task 6
// walks every concave cylinder independently and both fragments reach both end planes,
// the SAME hole is detected twice with the SAME geometry-derived `key` — a collision that
// breaks the stable-id invariant the whole report rests on.
//
// Merging here rather than deduplicating in Task 6 is deliberate: this stage is already
// "merge patches into surfaces", the duplicate is a segmentation artefact rather than a
// feature-rule concern, and fixing it at the source means no downstream rule has to know
// the artefact exists.
function mergeCoFamily(topo, rawPatches, tol) {
  const merged = rawPatches.map((p) => ({ ...p, faces: [...p.faces] }));

  // NOTE: adjacency is deliberately NOT required (controller ruling R26). A plane
  // interrupted by a boss, or a bore crossed by a slot, comes out of segmentation as two
  // or more DISCONNECTED patches of identical geometry — and growth never routes them
  // through `unassigned`, so Task 4's mop-up never sees them either. They are one surface;
  // the fact that a feature crosses it does not make it two. The `loops` array preserves
  // the island structure, so anything downstream that genuinely needs the disjointness
  // can still read it, while every feature rule gets the one surface it should be
  // reasoning about.
  //
  // The risk this accepts: two genuinely independent same-geometry faces — the two feet of
  // a bracket lying in one plane — also merge. That is the right trade for this oracle.
  // A hole is a hole whichever foot it sits in, and the alternative silently splits every
  // interrupted surface, which breaks hole detection outright.
  //
  // `sameSurface` agreeing on FIT PARAMETERS is necessary but never sufficient on its
  // own — it is a finite list of bands over a finite list of fields, and any gap in it
  // (the torus branch above was missing a position check entirely until this was found
  // in review) turns two unrelated patches into one fabricated surface with full
  // confidence. So every tentative merge below is refit over the ACTUAL COMBINED point
  // cloud before it is accepted, and rejected if that combined fit is null or its
  // `maxDev` exceeds the same `tol` region growing itself used to decide these patches
  // were valid in the first place. This is deliberately a POST hoc check on the real
  // geometry, not a smarter `sameSurface` — it makes `sameSurface`'s correctness a
  // PERFORMANCE concern (a gap there costs a merge that should have happened but
  // didn't) rather than a correctness one (a gap there fabricating a surface that
  // should never have existed). Any future gap degrades to "failed to merge", which is
  // the safe direction.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length && !changed; i++) {
      if (!merged[i]) continue;
      for (let j = i + 1; j < merged.length && !changed; j++) {
        if (!merged[j] || !sameSurface(merged[i].fit, merged[j].fit)) continue;
        const faces = [...merged[i].faces, ...merged[j].faces];
        const { pts, normals } = facePoints(topo, faces);
        const fit = refitAs(merged[i].fit.type, pts, normals);
        if (!fit || fit.maxDev > tol) continue;   // sameSurface said yes, the geometry says no — don't merge
        merged[i] = { ...merged[i], faces, fit, area: merged[i].area + merged[j].area };
        merged[j] = null;
        changed = true;   // restart: a merge can make a third patch's fit agree too
      }
    }
  }

  return merged.filter(Boolean);
}

// Same acceptance band region growing itself used (segment.js's own `FIT_TOL_FRAC`,
// imported rather than restated), scaled to THIS mesh's own bbox diagonal rather than
// segment.js's — surfaceGraph is not handed segment.js's `topo`-derived tol directly,
// and recomputing it from the identical fraction is simpler than plumbing one more
// value through every caller for a quantity `topo` already has everything needed to
// reproduce exactly. intrinsicScale(), not a plain world-axis min/max, for the same
// reason segment.js switched: it must agree with segment.js's own tol on an
// arbitrarily-rotated input, and a world AABB diagonal does not (see intrinsicScale's
// comment in fit.js) — this is the twin of that fix, kept in step on purpose.
function defaultTol(topo) {
  return intrinsicScale(topo.verts) * FIT_TOL_FRAC;
}

export function surfaceGraph(topo, rawPatches, opts = {}) {
  const tol = opts.tol ?? defaultTol(topo);
  const patches = mergeCoFamily(topo, rawPatches, tol);
  const surfaces = patches.map((p, i) => {
    const fit = orientPlaneOutward(topo, p);
    return {
      id: `s${i}`, type: fit.type, fit, faces: p.faces, area: p.area, loops: [],
      curvature: curvatureOf(topo, p),
    };
  });
  const owner = new Int32Array(topo.faceArea.length).fill(-1);
  patches.forEach((p, i) => { for (const t of p.faces) owner[t] = i; });

  // Group boundary edges by the unordered pair of surfaces they separate. Edges
  // interior to one surface never reach here (owner[a] === owner[b]) — the boundary
  // loops below are built from exactly this same set instead.
  const between = new Map();
  const boundaryEdges = new Map();   // surface index -> edges on its rim
  for (const e of topo.edges) {
    if (e.triB < 0) continue;   // a true mesh boundary, not a surface-to-surface seam
    const a = owner[e.triA], b = owner[e.triB];
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!between.has(key)) between.set(key, { a: Math.min(a,b), b: Math.max(a,b), edges: [] });
    between.get(key).edges.push(e);
    for (const s of [a, b]) {
      if (!boundaryEdges.has(s)) boundaryEdges.set(s, []);
      boundaryEdges.get(s).push(e);
    }
  }

  const arcs = [];
  for (const { a, b, edges } of between.values()) {
    if (edges.length < MIN_ARC_EDGES) continue;
    // Length-weighted majority vote (see the header comment on why not first-edge).
    let convexLen = 0, concaveLen = 0, total = 0;
    const mids = [];
    for (const e of edges) {
      const p0 = vertOf(topo, e.v0), p1 = vertOf(topo, e.v1);
      const len = dist(p0, p1);
      total += len;
      if (e.convexity === "convex") convexLen += len;
      else if (e.convexity === "concave") concaveLen += len;
      mids.push([(p0[0]+p1[0])/2, (p0[1]+p1[1])/2, (p0[2]+p1[2])/2]);
    }
    // Never `===` on floats (global constraint — Task 3 shipped exactly this shape of
    // bug as `dihedral === 0` and it collapsed segmentation on any non-axis-aligned
    // mesh). `convexLen`/`concaveLen` are sums of real edge lengths accumulated in
    // whatever order `edges` happens to iterate in, so even a genuine tie (every edge
    // on this arc flat, or a symmetric mix of convex/concave halves) is not
    // guaranteed to land on the same last bit both ways — an epsilon relative to the
    // arc's own total length is the same "relative, scale-free" policy this file
    // already uses everywhere else (`closeRel`, `CIRCLE_TOL_FRAC`), not a one-off.
    const convexity = Math.abs(convexLen - concaveLen) <= total * 1e-9 ? "flat"
      : convexLen > concaveLen ? "convex" : "concave";
    const { kind, radius, axis } = arcKind(mids);
    arcs.push({
      between: [surfaces[a].id, surfaces[b].id],
      convexity, kind, radius: radius ?? null, axis: axis ?? null, length: total,
    });
  }

  // Boundary loops: chain each surface's rim edges end to end. A surface with an
  // island hole in it (an annulus cap) yields two loops, which is exactly the signal
  // the pocket and hole rules read.
  for (const [si, edges] of boundaryEdges) {
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.v0)) adj.set(e.v0, []);
      if (!adj.has(e.v1)) adj.set(e.v1, []);
      adj.get(e.v0).push(e.v1); adj.get(e.v1).push(e.v0);
    }
    const seen = new Set();
    for (const start of adj.keys()) {
      if (seen.has(start)) continue;
      const loop = [];
      let cur = start, prev = -1;
      while (cur !== undefined && !seen.has(cur)) {
        seen.add(cur); loop.push(cur);
        const next = (adj.get(cur) ?? []).find((v) => v !== prev && !seen.has(v));
        prev = cur; cur = next;
      }
      if (loop.length >= 3) surfaces[si].loops.push(loop);
    }
  }

  return { surfaces, arcs };
}

export function arcsOf(graph, surfaceId) {
  return graph.arcs.filter((a) => a.between[0] === surfaceId || a.between[1] === surfaceId);
}
