// Rim bevel for extruded profiles — extrude({ profile, h, bevel }). Composed
// entirely from existing kernel ops (extrude + loft + intersect) at the
// backend-shared front, so both backends get identical semantics for free and
// the probe sees no CAD-only op: a beveled extrusion stays on the fast Manifold
// backend instead of routing the whole part to OCCT. (OCCT's native chamfer is
// per-edge; on a many-point profile rim — a gear — one call costs seconds. The
// loft envelope costs one boolean regardless of point count.)
//
// Geometry: a 45° bevel, exactly what chamfer({d, edges:{inPlane}}) would cut —
// the profile inset by the bevel distance at the face, flaring to the full
// profile over the same distance in z. The envelope extends 1 mm past both
// faces so its own end caps never coincide with the extrusion's faces:
// coincident caps leave sliver-triangle shading artifacts on the flat tops;
// extended, every visible face comes from the boolean's clean re-triangulation.
import { offsetPolygon } from "./polygon.js";
import { isArcContour } from "./profile.js";

// Normalize `bevel` (number = both rims, {bottom, top} = per rim) and validate
// against the height. Exported for direct unit testing.
export function resolveBevel(bevel, h) {
  let bottom, top;
  if (typeof bevel === "number") { bottom = bevel; top = bevel; }
  else if (bevel !== null && typeof bevel === "object") {
    for (const key of Object.keys(bevel)) if (key !== "bottom" && key !== "top")
      throw new Error(`extrude: unknown bevel option ${JSON.stringify(key)} (valid: bottom, top)`);
    bottom = bevel.bottom ?? 0; top = bevel.top ?? 0;
  } else throw new Error("extrude: bevel must be a number or { bottom?, top? }");
  if (!(Number.isFinite(bottom) && bottom >= 0) || !(Number.isFinite(top) && top >= 0))
    throw new Error("extrude: bevel distances must be finite numbers >= 0");
  if (bottom + top >= h)
    throw new Error("extrude: bevel must fit the height (bottom + top < h)");
  return { bottom, top };
}

// The largest inset the profile can take, starting from the requested distance.
// Narrow features cap the bevel (the same geometric limit OCCT's chamfer hits —
// see ERROR-PATTERNS.md#chamfer-rescue-bisection), but each attempt here is pure
// JS on the 2-D outline, not a kernel op, so backing off is effectively free.
// The loop is deterministic, preserving build purity. `corners: "sharp"` keeps
// the offset 1:1 with the input points — loft stitching requires every ring to
// share the profile's exact point count (a mismatch is treated as a failed try).
const inset = (profile, requested) => {
  let c = requested;
  for (;;) {
    try {
      const inner = offsetPolygon(profile, -c, { corners: "sharp" });
      if (inner.length === profile.length) {
        if (c < requested)
          console.warn(`partforge: extrude bevel ${requested} exceeds what the profile can take — reduced to ${c.toFixed(2)}`);
        return { inner, c };
      }
    } catch { /* inset collapsed or self-intersected — try smaller */ }
    c *= 0.85;
    if (c < 0.05) {
      console.warn(`partforge: extrude bevel ${requested} has no valid inset for this profile — rim left square`);
      return null;
    }
  }
};

export function beveledExtrude(k, { profile, h, twist, scaleTop, bevel }) {
  if (twist !== undefined || scaleTop !== undefined)
    throw new Error("extrude: bevel cannot combine with twist or scaleTop");
  if (!Array.isArray(profile) || isArcContour(profile))
    throw new Error("extrude: bevel requires a plain polygon profile ([[x,y],…] — no holes, arcs, or Shape2D)");
  const { bottom, top } = resolveBevel(bevel, h);
  const body = k.extrude({ profile, h });
  const b = bottom > 0 ? inset(profile, bottom) : null;
  const t = top > 0 ? inset(profile, top) : null;
  if (!b && !t) return body;
  const rings = [];
  if (b) rings.push({ polygon: b.inner, z: -1 }, { polygon: b.inner, z: 0 }, { polygon: profile, z: b.c });
  else rings.push({ polygon: profile, z: -1 });
  if (t) rings.push({ polygon: profile, z: h - t.c }, { polygon: t.inner, z: h }, { polygon: t.inner, z: h + 1 });
  else rings.push({ polygon: profile, z: h + 1 });
  return body.intersect(k.loft({ rings }));
}
