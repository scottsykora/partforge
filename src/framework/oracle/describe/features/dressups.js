// Fillet and chamfer rules.
//
// Both are TRANSITION surfaces: narrow strips whose job is to soften the meeting of
// two larger neighbours. That is what distinguishes them from a small functional
// face, and it is why the rules test the strip's relationship to its neighbours
// rather than its size alone. A 2mm-wide plane between two walls is a chamfer; a
// 2mm-wide plane bounded by four other 2mm planes is just a small face.
//
// Fillet:  cylinder or torus, exactly two arcs, both to larger surfaces, tangent to
//          both (the arc convexity gives inside vs outside rounding).
// Chamfer: plane, exactly two arcs, both to larger surfaces, meeting each at a
//          consistent angle that is neither ~0 nor ~90 degrees.
//
// A cylinder candidate additionally requires its two arcs be STRAIGHT (`kind ===
// "line"`), which is what "tangent to both" cashes out to for a plain (single-
// curvature) fillet: a constant-radius fillet run along a straight edge is tangent
// to its neighbours along a line parallel to its own axis. A CIRCULAR arc between a
// cylinder and a plane means the opposite: the cylinder's axis runs perpendicular
// to that plane, punching straight through it — a bore's or a boss's mouth, not a
// tangent blend (verified directly against annulusPlate(10,4,3,48): its bore is a
// plain cylinder with exactly two circular arcs to the two larger cap planes, and
// without this check it satisfies every other test here and gets reported as a
// fillet). A doubly-curved torus fillet's own tangent arcs ARE genuinely circular
// (it blends a curved edge), so this guard is cylinder-only.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";

// A dress-up must be materially smaller than what it joins, or it is a face in its
// own right. Ratio, not an absolute size, so it scales with the part.
const MAX_AREA_RATIO = 0.34;
// Chamfer angle band: outside this it is a tangent continuation or a square corner.
const MIN_CHAMFER_RAD = 0.15, MAX_CHAMFER_RAD = Math.PI / 2 - 0.15;
const round3 = (v) => Math.round(v * 1000) / 1000;

const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

export function detectDressups(graph) {
  const surfaces = byId(graph);
  const out = [];

  for (const s of graph.surfaces) {
    const arcs = arcsOf(graph, s.id);
    if (arcs.length !== 2) continue;
    const nbrs = arcs.map((a) => surfaces.get(other(a, s.id)));
    if (nbrs.some((n) => !n)) continue;
    if (!nbrs.every((n) => s.area <= n.area * MAX_AREA_RATIO)) continue;

    if (s.type === "cylinder" && !arcs.every((a) => a.kind === "line")) continue;

    if (s.type === "cylinder" || s.type === "torus") {
      const radius = s.type === "cylinder" ? s.fit.radius : s.fit.minorRadius;
      out.push({
        id: null,
        key: `fillet:${round3(radius)}:${nbrs.map((n) => n.id).sort().join("-")}`,
        type: "fillet", radius,
        between: nbrs.map((n) => n.id),
        convexity: arcs[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, areaRatio: round3(s.area / Math.max(...nbrs.map((n) => n.area))), fitRms: s.fit.rms },
      });
      continue;
    }

    if (s.type === "plane" && nbrs.every((n) => n.type === "plane")) {
      const angles = nbrs.map((n) => Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(s.fit.normal, n.fit.normal))))));
      if (!angles.every((a) => a > MIN_CHAMFER_RAD && a < MAX_CHAMFER_RAD)) continue;
      // Strip width from the area and the longer of the two arcs — a chamfer is a
      // ribbon, so area/length is its width.
      const width = s.area / Math.max(arcs[0].length, arcs[1].length, 1e-9);
      out.push({
        id: null,
        key: `chamfer:${round3(width)}:${nbrs.map((n) => n.id).sort().join("-")}`,
        type: "chamfer", width, angle: (angles[0] + angles[1]) / 2,
        between: nbrs.map((n) => n.id),
        convexity: arcs[0].convexity,
        surfaces: [s.id],
        evidence: { arcs: arcs.length, angles: angles.map(round3), fitRms: s.fit.rms },
      });
    }
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
