// Bevel-band rule: a chamfer, drafted cut, or beveled blade edge swept along a CURVED
// profile in one plane.
//
// A CAD system tessellates such a surface into a chain of narrow planar facets — and
// segmentation, correctly, fits each facet as its own tiny plane, because no single
// analytic primitive in the vocabulary covers "constant-slope ruled surface along an
// arbitrary curve" (a cone covers only the circular-arc special case). The signature
// that survives tessellation is invariant and specific: every fragment's outward
// normal makes the SAME angle with one reference axis (the profile plane's normal),
// while its azimuth about that axis drifts smoothly, facet to facet, following the
// swept curve. Measured on the motivating box-opener STL: 528mm² of fragments at
// nz = +0.7071 EXACTLY (a 45° blade bevel following the outline) plus 138mm² at
// nz = -0.7071, fragmented into ~90 junk boss/pocket features before this rule.
//
// The SEAM-TURN gate is what separates "one bevel swept along a smooth profile" from
// "four straight chamfers that happen to share a slope": adjacent members must agree
// in azimuth within MAX_SEAM_TURN_DEG. Tessellation seams along a real curve turn a
// few degrees per facet; a box's chamfer ring jumps 90° at each corner and stays four
// independent chamfers (the dressup rule's territory, unchanged).
//
// Direction conventions: `slope` is the SIGNED dot of a fragment's outward normal
// with the axis, so the two bevels of a knife edge (top cut at +0.707, back cut at
// -0.707) never merge even where they touch along the cutting edge. `angleDeg` is
// the tilt of the cut faces from the profile plane itself — 0° would be flat, 90°
// a straight extrusion wall — clamped to (SLOPE_MIN, SLOPE_MAX) so caps and walls
// never enter a band.
//
// The reported `profile` is a measured POLYLINE (unlike prismatic.js's point-count
// proposals): the band's own boundary rail projected into the profile plane. Both
// rails of a constant-slope band determine each other given the angle and span, so
// one suffices; the longer rail is reported because it carries more of the curve's
// tessellation detail. Like every profile field, it is a proposal for a rebuilder,
// not an authoritative fact — the authoritative facts are angle, axis, span, area.
//
// THROUGH-CUT vs EDGE BEVEL (`throughCut`). The same constant-slope signature covers
// two features a rebuilder models completely differently, and the motivating STL has
// both: a narrow chamfer hugging the outline (an edge break — rebuild as a chamfer
// after the base extrude), and the BLADE — the same 45° slope swept along the hook's
// inner curve but spanning the plate's ENTIRE thickness (rebuild as a boolean cut
// along the reported profile, drafted at the reported angle, through the whole
// part). What separates them is the band's own span along the axis measured against
// the whole part's extent along that axis: the box-opener blade covers 96% of the
// plate's thickness where its edge bevels cover 14%. THROUGH_FRACTION sits between
// with room on both sides. The two also stay separate CHAINS wherever both exist:
// where the blade band tapers into the edge bevel the seam turns sharply (measured
// >25° dihedral on the motivating STL), which is exactly what the seam-turn gate
// splits on.
//
// Pure leaf. Same layering rules as the sibling rules here: no DOM, no three, no node.
import { arcsOf } from "../surface-graph.js";

// Slope window: acos(0.99) ≈ 8° off a cap, asin(0.14) ≈ 8° off a wall. Outside the
// window a fragment is a cap or a wall — some other rule's business.
const SLOPE_MIN = 0.14;
const SLOPE_MAX = 0.99;
// Member-to-member signed-slope agreement. Wider than the fit tolerance on purpose:
// mergeCoFamily can fold two adjacent facets of the band into ONE fitted plane whose
// normal averages theirs — averaging two unit normals with equal axis components and
// different azimuths SHORTENS the in-plane part, pushing |slope| up. Measured on the
// box-opener band: true fragments at 0.707, merged patches drifting up to 0.733.
const SLOPE_TOL = 0.045;
// Azimuth step allowed across one member-to-member seam (see header).
const MAX_SEAM_TURN_DEG = 30;
// A band is a CHAIN, not a face: at least four fragments turning through at least
// this much azimuth. A single angled plane — however large — is a chamfer or just a
// face, and two or three facets are as consistent with a coarse chamfer as with a
// curve. The floor of 4/30° is calibrated against a measured false positive: on a
// rotated fixture, one chamfer strip's own normal was nominated as an axis and the
// part's two caps plus a strip read as a 3-member "band" with 27° of spread.
const MIN_MEMBERS = 4;
const MIN_AZIMUTH_SPREAD_DEG = 30;
// Report-size cap for the profile polyline, kept far under the sandbox boundary's
// own per-array budget (partforge-cloud boundedJson: 512 items).
const MAX_PROFILE_POINTS = 48;
// A band whose axis span covers at least this fraction of the whole part's own
// extent along the same axis is a THROUGH-CUT (see header). Measured anchors:
// the box-opener blade at 0.96, its edge bevels at 0.14.
const THROUGH_FRACTION = 0.8;
// Two members may union only when their own axis extents are within this ratio.
// The blade and the edge bevel on the motivating STL share the same 45° slope and
// TOUCH at the hook's tail — slope and adjacency alone would merge them into one
// feature and lose exactly the distinction the report exists to carry. Their depths
// tell them apart unambiguously: blade fragments each cross ~4.8mm of the plate,
// edge-bevel fragments ~0.7mm (ratio ~7). 2.5 passes a band's own gradual
// tessellation variation and refuses that jump.
const EXTENT_RATIO_MAX = 2.5;
// A finished cluster's members must also agree on ONE slope overall, not merely
// step-to-step: pairwise tolerance alone lets slope DRIFT accumulate along a chain,
// and the concrete failure is a fillet — a quarter-round band's facet rows step
// through every slope from cap to wall in increments smaller than SLOPE_TOL, so
// row-chains daisy-chain into a "bevel" of some meaningless intermediate angle
// (measured on filleted-box: a 19° 16-member phantom whose appearance flipped with
// orientation). The statistic is the AREA-WEIGHTED standard deviation, not the
// min/max range: a real band's mass sits on one slope with a few tiny transition
// facets at its ends (the box-opener blade's members span 0.643..0.735 but its
// area-weighted spread is far under 0.02), while a fillet's rows spread their area
// evenly across the whole slope ladder (uniform over a range R has spread R/sqrt(12)
// — the 19° phantom measures well above this threshold).
const SLOPE_SPREAD_MAX = 0.035;
// Ladder rejection. One ROW of a tessellated fillet passes every gate above — its
// facets share one slope (the row is slope-coherent by construction) and follow
// the rounded rim (azimuth spread ✓). What betrays it is its NEIGHBOURHOOD: a
// fillet row borders the next rows of the same quarter-round, surfaces at slopes
// only a rung away, while a genuine bevel band is a break in the surface — it
// borders caps (slope ~1) and walls (slope ~0), far from its own slope. A cluster
// most of whose outside boundary (by arc length) leads to near-slope surfaces is a
// rung of a ladder, not a band. Measured anchors: filleted-box's top fillet row
// (13°, rows ~11° apart, next-row slope difference ~0.06) dies here; the
// box-opener blade's boundary is caps/walls except a short seam where it meets
// the same-slope edge bevel at the tail, a small fraction of its rim.
const LADDER_SLOPE_BAND = 3 * SLOPE_TOL;
const LADDER_FRACTION_MAX = 0.5;
// A candidate axis must come from a plane at least this fraction of the largest
// plane's area — a part's reference plane is one of its major faces, and without
// the floor every stray transition facet nominates its own axis and reports noise
// bands against it (measured twice: a 13mm² tail facet on the motivating STL, and
// a 100mm² chamfer strip — 5.6% of the cap — on a rotated fixture whose "band"
// against that axis was the part's own two caps).
const AXIS_AREA_FLOOR = 0.1;

const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const round3 = (v) => Math.round(v * 1000) / 1000;

// Deterministic in-plane frame for an axis — the same smallest-component rule
// describe.js's candidate builder uses, duplicated because this is a pure leaf and
// the orchestrator imports from here, not the other way around.
function frameFor(axis) {
  const ax = Math.abs(axis[0]) <= Math.abs(axis[1]) && Math.abs(axis[0]) <= Math.abs(axis[2]) ? [1, 0, 0]
    : Math.abs(axis[1]) <= Math.abs(axis[2]) ? [0, 1, 0] : [0, 0, 1];
  const u = unit([ax[0] - axis[0]*dot(ax, axis), ax[1] - axis[1]*dot(ax, axis), ax[2] - axis[2]*dot(ax, axis)]);
  return { u, v: cross(axis, u) };
}

// Candidate axes: the normals of the largest fitted planes, deduped by direction.
// A bevel band is cut against the part's own reference plane, and the part's biggest
// flat faces ARE that reference — the same "biggest plane is the base" reading
// prismatic.js's cap selection leans on. Sign-insensitive: a band against the top
// cap and one against the bottom cap share an axis line.
function candidateAxes(graph) {
  const planes = graph.surfaces
    .filter((s) => s.type === "plane")
    .sort((a, b) => b.area - a.area);
  const axes = [];
  for (const p of planes) {
    if (planes.length && p.area < AXIS_AREA_FLOOR * planes[0].area) break;
    const n = unit(p.fit.normal);
    if (!axes.some((a) => Math.abs(dot(a, n)) > 0.99)) axes.push(n);
    if (axes.length >= 4) break;
  }
  return axes;
}

// The area-weighted mean slope of ANY surface's faces against `axis` — no window,
// no constancy requirement. This is the ladder gate's read of a band's neighbours:
// it must work on caps, walls, and curved rows alike.
function rawSlope(surf, axis, topo) {
  if (surf.type === "plane") return dot(unit(surf.fit.normal), axis);
  let sum = 0, area = 0;
  for (const t of surf.faces) {
    const n = [topo.faceNormal[3*t], topo.faceNormal[3*t + 1], topo.faceNormal[3*t + 2]];
    sum += dot(n, axis) * topo.faceArea[t];
    area += topo.faceArea[t];
  }
  return area ? sum / area : 0;
}

// The signed slope of a surface against `axis`, or null when the surface cannot be
// a band member for that axis. A plane's fitted normal carries it directly. Every
// OTHER surface type is judged by what its FACES actually do, not by the label the
// fit put on it: the faces must agree on one signed slope to within SLOPE_TOL.
// A cone coaxial with the band axis passes naturally (every face at sin(halfAngle))
// — but so does a band stretch that segmentation mislabeled, and that robustness is
// the point. The motivating STL's edge bevel came back 112mm² inside one giant
// osculating "sphere" (position residual 9e-5mm — the sphere genuinely hugs a
// constant-slope band along a circular stretch, it is the sphere inscribed in the
// local cone), and a kernel-built fixture's corner stretches did the same at
// r=12mm. Their faces measure a constant 0.707 slope regardless; membership by
// measured slope keeps the band whole where membership by fitted type broke the
// chain at every such surface.
function memberSlope(surf, axis, topo) {
  if (surf.type === "plane") {
    const s = dot(unit(surf.fit.normal), axis);
    return Math.abs(s) >= SLOPE_MIN && Math.abs(s) <= SLOPE_MAX ? s : null;
  }
  let sum = 0, area = 0, lo = Infinity, hi = -Infinity;
  for (const t of surf.faces) {
    const n = [topo.faceNormal[3*t], topo.faceNormal[3*t + 1], topo.faceNormal[3*t + 2]];
    const s = dot(n, axis);
    const a = topo.faceArea[t];
    sum += s * a; area += a;
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  if (!area || hi - lo > SLOPE_TOL) return null;
  const s = sum / area;
  return Math.abs(s) >= SLOPE_MIN && Math.abs(s) <= SLOPE_MAX ? s : null;
}

// Azimuth of a plane member's normal about the axis frame; cones have no single
// azimuth (they ARE the turning stretch) and never gate a seam.
function azimuthOf(surf, axis, frame) {
  if (surf.type !== "plane") return null;
  const n = unit(surf.fit.normal);
  return Math.atan2(dot(n, frame.v), dot(n, frame.u));
}

const turnDeg = (a, b) => {
  let d = Math.abs(a - b) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
};

// Total azimuth coverage of a set of angles, wraparound-aware: sort, find the largest
// gap, and the band covers everything else. A closed ring covers ~360°.
function azimuthSpreadDeg(angles) {
  if (angles.length < 2) return 0;
  const s = [...angles].sort((a, b) => a - b);
  let largestGap = 2 * Math.PI - (s[s.length - 1] - s[0]);
  for (let i = 1; i < s.length; i++) largestGap = Math.max(largestGap, s[i] - s[i - 1]);
  return (2 * Math.PI - largestGap) * 180 / Math.PI;
}

// Collinear-point removal then uniform stride, capped at MAX_PROFILE_POINTS. The
// tolerance is relative to the polyline's own extent — the same scale-free policy
// segmentation uses everywhere.
function decimate(pts) {
  if (pts.length <= 2) return pts;
  let ext = 0;
  for (const [x, y] of pts) ext = Math.max(ext, Math.abs(x), Math.abs(y));
  const tol = ext * 1e-3;
  const kept = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = kept[kept.length - 1], b = pts[i], c = pts[i + 1];
    const areaX2 = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]));
    const base = Math.hypot(c[0]-a[0], c[1]-a[1]) || 1;
    if (areaX2 / base > tol) kept.push(b);
  }
  kept.push(pts[pts.length - 1]);
  if (kept.length <= MAX_PROFILE_POINTS) return kept;
  const stride = (kept.length - 1) / (MAX_PROFILE_POINTS - 1);
  return Array.from({ length: MAX_PROFILE_POINTS }, (_, i) => kept[Math.round(i * stride)]);
}

// Chain a set of undirected edges (vertex-index pairs) into polylines — the same
// walk surface-graph.js uses for boundary loops, tolerant of open chains.
function chainEdges(edges) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  }
  const seen = new Set();
  const chains = [];
  // Open chains first (start at degree-1 vertices), then closed loops.
  const starts = [...adj.keys()].sort((a, b) => (adj.get(a).length - adj.get(b).length));
  for (const start of starts) {
    if (seen.has(start)) continue;
    const chain = [];
    let cur = start, prev = -1;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur); chain.push(cur);
      const next = (adj.get(cur) ?? []).find((v) => v !== prev && !seen.has(v));
      prev = cur; cur = next;
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

export function detectBands(graph, topo) {
  const surfById = new Map(graph.surfaces.map((s) => [s.id, s]));
  const out = [];
  const claimedAnywhere = new Set(); // a surface joins at most one band across all axes

  for (const axis of candidateAxes(graph)) {
    const frame = frameFor(axis);
    // The whole part's extent along this axis — the through-cut yardstick.
    let partLo = Infinity, partHi = -Infinity;
    for (let i = 0; i < topo.verts.length; i += 3) {
      const h = topo.verts[i]*axis[0] + topo.verts[i+1]*axis[1] + topo.verts[i+2]*axis[2];
      if (h < partLo) partLo = h;
      if (h > partHi) partHi = h;
    }
    const slopes = new Map();   // surface id -> signed slope
    const azimuths = new Map(); // surface id -> azimuth (planes only)
    const extents = new Map();  // surface id -> own extent along the axis
    for (const s of graph.surfaces) {
      if (claimedAnywhere.has(s.id)) continue;
      const sl = memberSlope(s, axis, topo);
      if (sl === null) continue;
      slopes.set(s.id, sl);
      const az = azimuthOf(s, axis, frame);
      if (az !== null) azimuths.set(s.id, az);
      let eLo = Infinity, eHi = -Infinity;
      for (const t of s.faces) for (let c = 0; c < 3; c++) {
        const vi = topo.tris[3*t + c] * 3;
        const h = topo.verts[vi]*axis[0] + topo.verts[vi+1]*axis[1] + topo.verts[vi+2]*axis[2];
        if (h < eLo) eLo = h;
        if (h > eHi) eHi = h;
      }
      extents.set(s.id, eHi - eLo);
    }
    if (slopes.size < MIN_MEMBERS) continue;

    // Union-find over arcs whose two ends are slope-compatible members and whose
    // seam turn is small (plane-to-plane only; cones join on slope + adjacency).
    const parent = new Map([...slopes.keys()].map((id) => [id, id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const arc of graph.arcs) {
      const [a, b] = arc.between;
      if (!slopes.has(a) || !slopes.has(b)) continue;
      if (Math.abs(slopes.get(a) - slopes.get(b)) > SLOPE_TOL) continue;
      const azA = azimuths.get(a), azB = azimuths.get(b);
      if (azA !== undefined && azB !== undefined && turnDeg(azA, azB) > MAX_SEAM_TURN_DEG) continue;
      // Depth-compatibility (see EXTENT_RATIO_MAX): a through-cut and an edge bevel
      // can share slope AND adjacency; their axis extents are what differ.
      const eA = extents.get(a), eB = extents.get(b);
      if (Math.max(eA, eB) > EXTENT_RATIO_MAX * Math.max(Math.min(eA, eB), 1e-9)) continue;
      union(a, b);
    }
    const clusters = new Map();
    for (const id of slopes.keys()) {
      const r = find(id);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(id);
    }

    for (const members of clusters.values()) {
      if (members.length < MIN_MEMBERS) continue;
      const memberAz = members.map((id) => azimuths.get(id)).filter((a) => a !== undefined);
      if (azimuthSpreadDeg(memberAz) < MIN_AZIMUTH_SPREAD_DEG) continue;
      let swSum = 0, swSq = 0, swArea = 0;
      for (const id of members) {
        const sv = slopes.get(id), av = surfById.get(id).area;
        swSum += sv * av; swSq += sv * sv * av; swArea += av;
      }
      const swMean = swSum / (swArea || 1);
      if (Math.sqrt(Math.max(0, swSq / (swArea || 1) - swMean * swMean)) > SLOPE_SPREAD_MAX) continue;
      // Ladder rejection (see LADDER_SLOPE_BAND above).
      const memberSetPre = new Set(members);
      let ladderLen = 0, boundaryLen = 0;
      for (const id of members) for (const arc of arcsOf(graph, id)) {
        const otherId = arc.between[0] === id ? arc.between[1] : arc.between[0];
        if (memberSetPre.has(otherId)) continue;
        const other = surfById.get(otherId);
        if (!other) continue;
        boundaryLen += arc.length;
        if (Math.abs(Math.abs(rawSlope(other, axis, topo)) - Math.abs(swMean)) <= LADDER_SLOPE_BAND) ladderLen += arc.length;
      }
      if (boundaryLen > 0 && ladderLen > LADDER_FRACTION_MAX * boundaryLen) continue;

      const surfs = members.map((id) => surfById.get(id));
      const area = surfs.reduce((a, s) => a + s.area, 0);
      let slopeSum = 0;
      for (const id of members) slopeSum += slopes.get(id) * surfById.get(id).area;
      const meanSlope = slopeSum / area;
      const angleDeg = Math.acos(Math.min(1, Math.abs(meanSlope))) * 180 / Math.PI;
      // Report the axis signed toward the band's outward normals, so `axis` +
      // `angleDeg` alone orient the cut without the reader consulting the sign of
      // an internal slope value.
      const signedAxis = meanSlope >= 0 ? axis : axis.map((c) => -c);

      // Membership by triangle for rail extraction and span.
      const memberSet = new Set(members);
      const owner = new Map();
      for (const s of graph.surfaces) if (memberSet.has(s.id)) for (const t of s.faces) owner.set(t, s.id);

      let lo = Infinity, hi = -Infinity;
      const centroid = [0, 0, 0];
      let vcount = 0;
      for (const t of owner.keys()) for (let c = 0; c < 3; c++) {
        const vi = topo.tris[3*t + c] * 3;
        const p = [topo.verts[vi], topo.verts[vi+1], topo.verts[vi+2]];
        const h = dot(p, signedAxis);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        for (let a = 0; a < 3; a++) centroid[a] += p[a];
        vcount++;
      }
      for (let a = 0; a < 3; a++) centroid[a] /= vcount || 1;

      // Boundary rails: edges with a member triangle on exactly one side, split into
      // the low and high rail by each edge's own midpoint height along the axis.
      const railLo = [], railHi = [];
      const mid = (lo + hi) / 2;
      for (const e of topo.edges) {
        if (e.triB < 0) continue;
        const inA = owner.has(e.triA), inB = owner.has(e.triB);
        if (inA === inB) continue;
        const p0 = [topo.verts[3*e.v0], topo.verts[3*e.v0+1], topo.verts[3*e.v0+2]];
        const p1 = [topo.verts[3*e.v1], topo.verts[3*e.v1+1], topo.verts[3*e.v1+2]];
        const h = (dot(p0, signedAxis) + dot(p1, signedAxis)) / 2;
        (h < mid ? railLo : railHi).push([e.v0, e.v1]);
      }
      const railLen = (rail) => rail.reduce((sum, [a, b]) => {
        const dx = topo.verts[3*a] - topo.verts[3*b], dy = topo.verts[3*a+1] - topo.verts[3*b+1], dz = topo.verts[3*a+2] - topo.verts[3*b+2];
        return sum + Math.hypot(dx, dy, dz);
      }, 0);
      const rail = railLen(railLo) >= railLen(railHi) ? railLo : railHi;

      // Project the longest chained rail into the profile plane.
      const chains = chainEdges(rail).sort((a, b) => b.length - a.length);
      let profile = null;
      if (chains.length) {
        let offSum = 0, offSq = 0, count = 0;
        const pts = chains[0].map((vi) => {
          const p = [topo.verts[3*vi], topo.verts[3*vi+1], topo.verts[3*vi+2]];
          const off = dot(p, signedAxis);
          offSum += off; offSq += off * off; count++;
          return [round3(dot(p, frame.u)), round3(dot(p, frame.v))];
        });
        const meanOff = offSum / count;
        profile = {
          kind: "polyline",
          points: decimate(pts),
          planeOffset: round3(meanOff),
          planeRms: round3(Math.sqrt(Math.max(0, offSq / count - meanOff * meanOff))),
        };
      }

      // Seam convexity between members, length-weighted — convex reads as an outside
      // edge bevel (a blade, an eased rim), concave as an inside one (a countersunk
      // slot's flank).
      let convexLen = 0, concaveLen = 0;
      for (const id of members) for (const arc of arcsOf(graph, id)) {
        const [a, b] = arc.between;
        if (!memberSet.has(a) || !memberSet.has(b)) continue;
        if (arc.convexity === "convex") convexLen += arc.length;
        else if (arc.convexity === "concave") concaveLen += arc.length;
      }
      const convexity = convexLen === 0 && concaveLen === 0 ? null
        : convexLen >= concaveLen * 4 ? "convex"
        : concaveLen >= convexLen * 4 ? "concave" : "mixed";

      for (const id of members) claimedAnywhere.add(id);
      out.push({
        type: "bevel",
        key: `bevel:${round3(angleDeg)}:${signedAxis.map(round3).join(",")}:${centroid.map(round3).join(",")}`,
        angleDeg: round3(angleDeg),
        axis: signedAxis.map(round3),
        // Slant width of the band's face, derived from its axis rise and its own
        // angle (rise / sin(tilt)) — a 3mm 45-degree chamfer reads ~4.24, a blade
        // through a 5mm plate at 45 degrees reads ~7.07. Rail lengths are NOT used
        // here: which boundary edges land on which rail shifts with neighbouring
        // segmentation, and a width that moves when an unrelated surface re-fits
        // is not a measurement.
        width: round3((hi - lo) / Math.max(Math.sqrt(1 - meanSlope * meanSlope), 1e-6)),
        span: [round3(lo), round3(hi)],
        // True when the band crosses (nearly) the part's whole extent along the
        // axis: a profile CUT through the part — a blade — not an edge break.
        throughCut: (hi - lo) >= THROUGH_FRACTION * (partHi - partLo),
        area: round3(area),
        profile: profile ?? { kind: "polyline", points: [], planeOffset: null, planeRms: null },
        surfaces: members,
        convexity,
        evidence: { members: members.length, azimuthSpreadDeg: round3(azimuthSpreadDeg(memberAz)) },
      });
    }
  }
  return out;
}
