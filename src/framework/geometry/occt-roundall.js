// B-rep side of roundAll: dilate(+r), erode(-2r), dilate(+r) via raw OCCT
// BRepOffsetAPI_MakeOffsetShape (replicad has no solid-offset wrapper). Each
// step runs a variant cascade — the design spike showed no single parameter
// combo survives all shapes: plain solids dilate with Arc/Intersection=false,
// the chained erosion only succeeds with Arc/Intersection=true, and concave
// post-boolean solids only dilate with the Intersection join (morphologically
// fine: the FINAL Arc dilation supplies the convex rounding).
//
// A candidate is accepted only if IsDone, non-null, closed (mesh check),
// finite positive volume, AND volume-monotonic (dilation must not shrink,
// erosion must not grow). The monotonic gate is load-bearing: OCCT offsets
// return BRepCheck-valid garbage — the spike saw an erosion "succeed" at 0.4%
// of the input volume, and a sealed hole come back as an 11% crater. A gated
// failure skips the WHOLE op (warn + clone), mirroring safeOp's fillet policy
// and for the same reason: OCCT offset failures are not monotonic in r, so
// searching for a "largest working radius" would converge on garbage.
// Feature-consuming radii (r at/above the smallest feature) are the expected
// skip trigger — true consumption is mesh-class-only (docs/roundall-design.md).
import { isClosedSolid } from "./occt-repair.js";

const VARIANTS = [
  { join: "arc", inter: false },
  { join: "arc", inter: true },
  { join: "int", inter: false },
  { join: "int", inter: true },
];

export function occtRoundAll(replicad, shape, r) {
  if (!Number.isFinite(r) || r <= 0) throw new Error("roundAll: r must be a finite number > 0 (r = 0 is handled as the identity by the caller)");
  const oc = replicad.getOC();
  const tryOffset = (topo, offset, v) => {
    const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      mk.PerformByJoin(topo, offset, 1e-6,
        oc.BRepOffset_Mode.BRepOffset_Skin, v.inter, false,
        v.join === "arc" ? oc.GeomAbs_JoinType.GeomAbs_Arc : oc.GeomAbs_JoinType.GeomAbs_Intersection,
        false, new oc.Message_ProgressRange_1());
      if (!mk.IsDone()) return null;
      const s = mk.Shape();
      return s.IsNull() ? null : new replicad.Solid(s);
    } catch {
      return null;
    }
  };
  let cur = shape;
  let vol = replicad.measureVolume(shape);
  for (const off of [r, -2 * r, r]) {
    let next = null;
    for (const v of VARIANTS) {
      const cand = tryOffset(cur.wrapped, off, v);
      if (!cand) continue;
      let cvol;
      try { cvol = replicad.measureVolume(cand); } catch { continue; }
      if (!Number.isFinite(cvol) || cvol <= 0) continue;
      if (off > 0 && cvol < vol * 0.999) continue; // dilation shrank: garbage
      if (off < 0 && cvol > vol * 1.001) continue; // erosion grew: garbage
      if (!isClosedSolid(cand)) continue;
      next = cand;
      vol = cvol;
      break;
    }
    if (!next) {
      console.warn(`roundall-skipped: offset step ${off} produced no valid solid — r=${r} is likely at/above the smallest feature size; returning the un-rounded solid`);
      return shape.clone();
    }
    cur = next;
  }
  return cur;
}
