// Shading-intent policies — the single home for every edge/shading threshold.
// A policy says how one original surface (a Manifold originalID) wants its
// SAME-surface edges treated by creased-normals.js:
//   creaseAngle       deg — same-surface edges bending more than this shade hard
//   sameSurfaceLines  whether same-surface edges past creaseAngle also draw lines
// Cross-surface (boolean cut seam) behavior is not policy: seams always shade
// hard, and draw a line when bent more than COPLANAR_ANGLE.

export const SMOOTH = Object.freeze({ creaseAngle: 35, sameSurfaceLines: true });
export const FACETED = Object.freeze({ creaseAngle: 10, sameSurfaceLines: false });
// A blend surface (fillet/chamfer band). `boundaryLines` widens the CROSS-surface
// rule for it: a seam between a blend and a NON-blend surface draws regardless of
// bend — the band's start/end are tangent (~0°) and would otherwise be invisible,
// leaving the fillet's extent unreadable in the overlay. A seam between TWO blend
// surfaces keeps the ordinary bend rule (exactly-one-side semantics), so the
// handover seams along one band — tool splits, corner arcs continuing a sweep —
// stay invisible while real mitre crossings still draw.
export const BLEND = Object.freeze({ creaseAngle: 35, sameSurfaceLines: true, boundaryLines: true });

export const COPLANAR_ANGLE = 5;  // deg — cut seams bending less than this are coplanar: no line
export const TANGENT_ANGLE = 5;   // deg — B-rep edges whose faces agree within this are tangent: no line
export const MIN_EDGE = 0.01;     // mm — drop shorter segments (degenerate slivers, pole edges)

// Loft rings with at least this many sides read as an approximation of a smooth
// surface (e.g. a 64-gon "circle"), not as 64 intentional facets.
export const SMOOTH_SIDES_MIN = 32;

export const cosDeg = (deg) => Math.cos((deg * Math.PI) / 180);

// Loft shading inference. An explicit `shading` hint wins; `ruled:false` asks
// OCCT for a smoothly blended surface, so the Manifold preview of the same part
// must shade smooth too; otherwise low-side-count rings are intentional facets.
export function loftShadingPolicy(rings, { shading, ruled } = {}) {
  if (shading === "smooth") return SMOOTH;
  if (shading === "faceted") return FACETED;
  if (shading != null) throw new Error('loft: shading must be "smooth" | "faceted"');
  if (ruled === false) return SMOOTH;
  let maxSides = 0;
  if (Array.isArray(rings)) for (const r of rings) {
    const n = Array.isArray(r?.polygon) ? r.polygon.length : (Number.isFinite(r?.sides) ? r.sides : 0);
    if (n > maxSides) maxSides = n;
  }
  return maxSides >= SMOOTH_SIDES_MIN ? SMOOTH : FACETED;
}
