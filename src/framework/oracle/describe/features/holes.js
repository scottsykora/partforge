// Hole rules over the attributed adjacency graph.
//
// The primary test is the cylinder's own CURVATURE, not the convexity of its arcs
// (controller ruling R10). A bore is a concave cylinder — outward normals pointing back
// toward its axis. A shaft or a boss is a convex one. Arc convexity cannot make this call:
// a through-hole's rim and a plate's outer edge are both plain 90-degree convex corners,
// because in both cases the material leaves a 90-degree wedge at the seam.
//
// Arc convexity still does the SECOND half of the job, once curvature has established we
// are looking at a bore: a convex circular arc to a plane is a MOUTH (the bore breaking
// out through a face), and a concave arc to a plane or cone is a FLOOR (the bore
// bottoming out). Two mouths on anti-parallel planes is a through hole; one mouth plus a
// floor is a blind hole. Everything else — radius, extent, axis — fit.js already measured.
//
// `id` is deliberately null: feature numbering is the orchestrator's job (Task 12),
// because ids must be assigned once across ALL feature families in a stable order.
// A `key` derived from rounded geometry gives that ordering something deterministic
// to sort on, so the same mesh always numbers its features the same way.
//
// Pure leaf. See spec §2.5.
import { arcsOf } from "../surface-graph.js";

// Two planes count as "parallel" (a through hole's two mouths) within this band.
const PARALLEL_DOT = 0.98;
// `arcsOf` is imported for the mouth/floor split; curvature comes off the surface itself.
const round3 = (v) => Math.round(v * 1000) / 1000;

const byId = (graph) => new Map(graph.surfaces.map((s) => [s.id, s]));
const other = (arc, id) => (arc.between[0] === id ? arc.between[1] : arc.between[0]);

export function detectHoles(graph) {
  const surfaces = byId(graph);
  const out = [];

  for (const s of graph.surfaces) {
    if (s.type !== "cylinder") continue;
    if (s.curvature !== "concave") continue;                  // a boss, a shaft, an outer wall

    const arcs = arcsOf(graph, s.id);
    // A mouth is where the bore breaks out through a face: a convex seam to a plane.
    const mouths = arcs
      .filter((a) => a.convexity === "convex")
      .map((a) => ({ arc: a, face: surfaces.get(other(a, s.id)) }))
      .filter((m) => m.face && m.face.type === "plane");
    if (mouths.length === 0) continue;

    const dir = s.fit.axis.direction;
    const depth = Math.abs(s.fit.extent[1] - s.fit.extent[0]);
    const diameter = s.fit.radius * 2;
    const origin = s.fit.axis.origin;

    // Through: two planar mouths on parallel planes, both perpendicular to the bore
    // axis. Blind: one mouth, with the far end closed by a surface the bore also
    // touches (planar floor or conical drill point).
    //
    // NOTE: this checks |dot| against PARALLEL_DOT, not dot <= -PARALLEL_DOT (which
    // is what "anti-parallel outward normals" would suggest and what a first draft
    // of this rule used). fitPlane() (fit.js) is pure PCA over a point cloud with no
    // reference to the mesh's own winding/face normals, so a plane surface's
    // `fit.normal` sign is an arbitrary artifact of the eigensolver, not tied to the
    // true outward direction — confirmed directly against annulusPlate(10,4,3,48),
    // whose two caps (translated copies of the same ring shape, hence identical PCA
    // covariance) both come back with fit.normal = (0,0,1), not the physically
    // anti-parallel (0,0,-1)/(0,0,1) the caps actually have. A dot <= -PARALLEL_DOT
    // test against that ambiguous sign found zero through holes on this fixture.
    // The physical invariant that survives the sign ambiguity is just that the two
    // mouth planes are PARALLEL to each other (their normals share a line, whichever
    // way each happens to point) — a bore's own axis is perpendicular to a mouth
    // plane at each end it breaks through, so two such planes at opposite ends of a
    // straight bore cannot help but be parallel to one another.
    let type = null, entryFace = null, exitFace = null, floorFace = null;
    if (mouths.length >= 2) {
      const [m0, m1] = mouths;
      const d = m0.face.fit.normal[0]*m1.face.fit.normal[0]
              + m0.face.fit.normal[1]*m1.face.fit.normal[1]
              + m0.face.fit.normal[2]*m1.face.fit.normal[2];
      if (Math.abs(d) >= PARALLEL_DOT) { type = "throughHole"; entryFace = m0.face.id; exitFace = m1.face.id; }
    }
    if (!type) {
      // A floor is the opposite seam: CONCAVE, because the bore bottoming out leaves 270
      // degrees of material there. Planar for a flat-bottomed bore, conical for a drill point.
      const floor = arcs
        .filter((a) => a.convexity === "concave")
        .map((a) => surfaces.get(other(a, s.id)))
        .find((n) => n && n.id !== mouths[0].face.id && (n.type === "plane" || n.type === "cone"));
      if (floor) { type = "blindHole"; entryFace = mouths[0].face.id; floorFace = floor.id; }
    }
    if (!type) continue;

    out.push({
      id: null,
      key: `hole:${round3(diameter)}:${round3(origin[0])},${round3(origin[1])},${round3(origin[2])}`,
      type, diameter, depth,
      axis: { origin, direction: dir },
      entryFace, exitFace, floorFace,
      surfaces: [s.id],
      // What the rule actually saw. The report carries this so a wrong call can be
      // argued with rather than merely disbelieved.
      evidence: { curvature: s.curvature, planarMouths: mouths.length, arcs: arcs.length, fitRms: s.fit.rms },
    });
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
