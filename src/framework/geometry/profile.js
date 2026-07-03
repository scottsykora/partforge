// Backend-shared 2-D region normalization for extrude(). Accepts either a bare points
// array (outer contour only) or { outer, holes? }, and returns a canonical
// { outer:[[x,y],…], holes:[[[x,y],…],…] }. Both backends normalize the same way so an
// outer-only array and { outer } extrude identically.
export function normalizeProfile(profile) {
  let outer, holes;
  if (Array.isArray(profile)) { outer = profile; holes = []; }
  else if (profile && typeof profile === "object") { outer = profile.outer; holes = profile.holes ?? []; }
  else throw new Error("extrude: profile must be [[x,y],…] or { outer:[[x,y],…], holes?:[[[x,y],…],…] }");
  if (!Array.isArray(outer) || outer.length < 3)
    throw new Error("extrude: outer contour needs ≥3 points");
  if (!Array.isArray(holes)) throw new Error("extrude: holes must be an array of contours");
  for (const hole of holes)
    if (!Array.isArray(hole) || hole.length < 3) throw new Error("extrude: each hole needs ≥3 points");
  return { outer, holes };
}
