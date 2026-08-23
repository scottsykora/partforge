// Fillet and chamfer rules.
//
// Both are TRANSITION surfaces: narrow strips whose job is to soften the meeting of
// two larger neighbours. That is what distinguishes them from a small functional
// face, and it is why the rules test the strip's relationship to its neighbours
// rather than its size alone. A 2mm-wide plane between two walls is a chamfer; a
// 2mm-wide plane bounded by four other 2mm planes is just a small face.
//
// Fillet:  cylinder or torus, tangent to both of two PRIMARY neighbours (the arc
//          convexity gives inside vs outside rounding).
// Chamfer: plane OR cone (a countersink is a revolved chamfer), meeting each
//          primary neighbour at a consistent angle that is neither ~0 nor ~90
//          degrees.
//
// PRIMARY neighbours are the two LONGEST-shared-boundary arcs, not "however many
// arcs this surface has total" (round 1 review: the original premise required
// `arcs.length === 2`, which no finite straight chamfer/fillet can ever satisfy —
// a chamfer cut along a box edge of finite length necessarily terminates against
// two more end faces besides the two walls it actually blends, giving FOUR arcs,
// not two; verified directly against a chamfered box, whose bevel plane has arcs
// of length ~30mm to the two walls it blends and ~4.2mm to the two end caps it
// merely runs into). Selecting by length picks out the two it actually blends and
// treats the incidental end walls as exactly that: incidental, not disqualifying.
//
// TANGENCY, for a cylinder candidate, means its two PRIMARY arcs are STRAIGHT
// (`kind === "line"`): a constant-radius fillet run along a straight edge is
// tangent to its neighbours along a line parallel to its own axis. A CIRCULAR
// primary arc between a cylinder and a plane means the opposite: the cylinder's
// axis runs perpendicular to that plane, punching straight through it — a bore's
// or a boss's mouth, not a tangent blend (verified directly against
// annulusPlate(10,4,3,48): its bore is a plain cylinder with exactly two circular
// arcs to the two larger cap planes, and without this check it satisfies every
// other test here and gets reported as a fillet). A doubly-curved torus fillet's
// own tangent arcs ARE genuinely circular (it blends a curved edge), so this
// guard is cylinder-only.
//
// WIDTH is compared against the primary neighbours' own EXTENT as a length, not
// an area (round 1 review: the original area-ratio test — this surface's area
// against each neighbour's — silently drops an ordinary torus fillet as it grows,
// because the neighbouring end cap shrinks by 2x the fillet radius as the fillet
// widens, which erodes the AREA ratio far faster than the actual geometry
// justifies; measured directly: r/R = 0.125 and 0.25 fillets, both completely
// normal roundovers, missed entirely under the old area test). A dress-up is
// narrow in ONE dimension, so the comparison is a length against a length: this
// surface's own width (a fillet's radius; a chamfer's or countersink's area
// divided by its longest primary arc) against the LARGER of the two primary
// arcs' own measured radius (circular arcs — the natural "how big is the thing
// this blends" reference; e.g. a fillet's tangent seam to its shaft lands almost
// exactly on the shaft's own radius) or length (straight arcs, which have no
// radius). Reusing the larger of the two, rather than requiring both
// individually, matters because a fillet's two neighbours differ in this exact
// reference by very close to the fillet's own radius (a torus fillet's tangent
// circle on the flat-cap side is smaller than on the shaft side by ~r) — testing
// against the smaller one would make the threshold tighter than the geometry
// warrants.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";

// A dress-up must be materially narrower than what it joins, or it is a face in
// its own right. Ratio, not an absolute size, so it scales with the part.
// Verified against a torus fillet sweep at r/R = 0.0625, 0.125 and 0.25 (all
// pass with this threshold; the largest, r=2 against a shaft radius R=8, checks
// 2 <= 8*0.34 = 2.72) while the washer bore (rejected by the tangency guard
// above, not by this ratio) stays rejected regardless.
const MAX_WIDTH_RATIO = 0.34;
// Chamfer angle band: outside this it is a tangent continuation or a square corner.
const MIN_CHAMFER_RAD = 0.15, MAX_CHAMFER_RAD = Math.PI / 2 - 0.15;
const round3 = (v) => Math.round(v * 1000) / 1000;

const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
// A primary arc's own reference length: its measured circle radius when curved,
// or its own run length when straight (a straight arc has no radius to offer).
const arcExtent = (arc) => arc.radius ?? arc.length;

// A neighbour's own fitted geometry, not its segmentation surface id (round 2
// review: `s0`/`s1` are assigned in triangle-DISCOVERY order — the same defect
// prismatic.js's key had — so they renumber under a triangle-order permutation
// of the same geometry, which must never change what a fillet/chamfer's own
// key is). Covers every surface type a dress-up's primary neighbour can be;
// `round3` absorbs the float-associativity noise a permuted summation/fit
// order introduces (Task 4's own ruling, R29) — real geometry never differs at
// 3-decimal precision, only float dust does.
const vec3 = (a) => a.map(round3).join(",");
function surfaceSignature(s) {
  if (s.type === "plane") return `plane:${round3(s.fit.offset)}:${vec3(s.fit.normal)}`;
  if (s.type === "cylinder") return `cylinder:${round3(s.fit.radius)}:${vec3(s.fit.axis.direction)}:${vec3(s.fit.axis.origin)}`;
  if (s.type === "cone") return `cone:${round3(s.fit.halfAngle)}:${vec3(s.fit.apex)}:${vec3(s.fit.direction)}`;
  if (s.type === "torus") return `torus:${round3(s.fit.majorRadius)}:${round3(s.fit.minorRadius)}:${vec3(s.fit.center)}`;
  return `${s.type}:${round3(s.area)}`;   // any future surface type
}
// "|", not "-": a signature can itself contain "-" (a negative coordinate), and
// this only ever needs to be a stable SORT key, never parsed back apart.
const sortSignatures = (nbrs) => nbrs.map(surfaceSignature).sort().join("|");

export function detectDressups(graph) {
  const surfaces = byId(graph);
  const out = [];

  for (const s of graph.surfaces) {
    const arcs = arcsOf(graph, s.id);
    if (arcs.length < 2) continue;

    // The two PRIMARY neighbours: the longest-shared-boundary arcs. Any other
    // arcs (a finite chamfer/fillet's incidental end walls) are ignored below.
    const primary = [...arcs].sort((a, b) => b.length - a.length).slice(0, 2);
    const nbrs = primary.map((a) => surfaces.get(other(a, s.id)));
    if (nbrs.some((n) => !n)) continue;

    if (s.type === "cylinder" && !primary.every((a) => a.kind === "line")) continue;

    const extent = Math.max(...primary.map(arcExtent));
    const fitsAsStrip = (width) => width <= extent * MAX_WIDTH_RATIO;

    if (s.type === "cylinder" || s.type === "torus") {
      const radius = s.type === "cylinder" ? s.fit.radius : s.fit.minorRadius;
      if (!fitsAsStrip(radius)) continue;
      out.push({
        id: null,
        key: `fillet:${round3(radius)}:${sortSignatures(nbrs)}`,
        type: "fillet", radius,
        between: nbrs.map((n) => n.id),
        convexity: primary[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, widthRatio: round3(radius / extent), fitRms: s.fit.rms },
      });
      continue;
    }

    if (s.type === "plane" && nbrs.every((n) => n.type === "plane")) {
      const angles = nbrs.map((n) => Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(s.fit.normal, n.fit.normal))))));
      if (!angles.every((a) => a > MIN_CHAMFER_RAD && a < MAX_CHAMFER_RAD)) continue;
      // Strip width from the area and the longer of the two arcs — a chamfer is a
      // ribbon, so area/length is its width.
      const width = s.area / Math.max(primary[0].length, primary[1].length, 1e-9);
      if (!fitsAsStrip(width)) continue;
      out.push({
        id: null,
        key: `chamfer:${round3(width)}:${sortSignatures(nbrs)}`,
        type: "chamfer", width, angle: (angles[0] + angles[1]) / 2,
        between: nbrs.map((n) => n.id),
        convexity: primary[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, angles: angles.map(round3), fitRms: s.fit.rms },
      });
      continue;
    }

    // A countersink is a REVOLVED chamfer: a cone blending a bore into a face
    // (or another cone) instead of a plane blending two walls. Its own conical
    // half-angle already IS its blend angle (fit.js's fitCone recovers it
    // directly), so unlike the plane branch above there's no pair of face
    // normals to average — the cone's `halfAngle` cashes out to the same
    // "angle from the material" the plane branch measures.
    if (s.type === "cone") {
      const width = s.area / Math.max(primary[0].length, primary[1].length, 1e-9);
      if (!fitsAsStrip(width)) continue;
      out.push({
        id: null,
        key: `chamfer:${round3(width)}:${sortSignatures(nbrs)}`,
        type: "chamfer", width, angle: s.fit.halfAngle,
        between: nbrs.map((n) => n.id),
        convexity: primary[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, halfAngle: round3(s.fit.halfAngle), fitRms: s.fit.rms },
      });
    }
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
