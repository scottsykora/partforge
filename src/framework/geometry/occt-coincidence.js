// Refuses the boolean OCCT cannot survive, before it runs.
//
// The degenerate case (measured on real feedback, 2026-08-31): a swept face —
// a thread root from screwSweep is the canonical one — lying exactly ON the
// other operand's cylindrical face. OCCT 7.6 detects same-domain overlap
// between two ANALYTIC cylinders instantly (flush stacks, re-cut holes and
// overlapping coaxial rods all fuse in milliseconds), but a BSpline surface
// coincident with a cylinder has no same-domain shortcut: the intersection
// walker grinds for minutes with no error, wedging the serial kernel worker,
// or — on OCCT 8 — "finishes" with corrupt geometry (a negative-volume fuse).
// Every kernel-level mitigation was measured and ruled out: SetFuzzyValue
// hangs at 1e-4/1e-3/1e-2, SetUseOBB hangs, glue completes only under a
// precondition (no volumetric overlap) that cannot be proven in general, and
// the WASM build binds no progress indicator so the grind cannot be aborted.
// The only fix is refusing the contact and coaching the author toward real
// clearance, real overlap, or k.tappedBore.
//
// The predicate is AREA contact, not proximity: a freeform face whose sampled
// points nearly all sit on the cylinder (within the sweep's own approximation
// band — the swept "cylinder" deviates from the true radius by ~1e-3·r, which
// is exactly why OCCT cannot classify it as same-domain). Faces that merely
// CROSS the radius (thread flanks, the tapered lead-in ramps) put only a
// fraction of their samples in the band and are left alone — measured at 0.5
// and 0.75 against the 0.9 threshold, and a construction with the documented
// 0.05 mm of clearance sits far outside the band entirely.
//
// Known misses, accepted: freeform-vs-freeform coincidence (two swept
// surfaces mated exactly) and exact contact with non-cylindrical analytic
// faces. This guard exists for the case users actually author — a bore plus a
// thread — not as a proof that every boolean terminates.

const FREEFORM_SURFACES = [
  "GeomAbs_BSplineSurface",
  "GeomAbs_BezierSurface",
  "GeomAbs_SurfaceOfExtrusion",
  "GeomAbs_SurfaceOfRevolution",
  "GeomAbs_OffsetSurface",
  "GeomAbs_OtherSurface",
];

// Sampled 4×4 across each candidate face; "on the cylinder" means within
// max(1e-3, 2e-3·r) — twice the measured sweep-approximation band, still an
// order of magnitude below the 0.05 mm the authoring guidance calls real
// clearance — and a face is contact only when ≥90% of its samples qualify.
const GRID = 4;
const REL_TOL = 2e-3;
const MIN_TOL = 1e-3;
const MIN_ON_FRACTION = 0.9;

// Above this many faces on one operand, skip detection (fail open): the guard
// must never cost more than the boolean it protects. A part-authored solid is
// tens to hundreds of faces; only a large STEP import approaches this.
const MAX_FACES = 8000;

const enumName = (enumObj, value) =>
  Object.keys(enumObj).find((n) => enumObj[n] === value || (enumObj[n]?.value !== undefined && enumObj[n].value === value?.value));

// One pass over a solid's faces: analytic cylinders (radius + axis + bbox) and
// freeform faces (adaptor kept for lazy sampling + bbox). Caller must dispose().
function faceProfile(oc, topo) {
  const cylinders = [];
  const freeforms = [];
  let faceCount = 0;
  const explorer = new oc.TopExp_Explorer_2(topo, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    faceCount += 1;
    if (faceCount > MAX_FACES) break;
    const face = oc.TopoDS.Face_1(explorer.Current());
    const adaptor = new oc.BRepAdaptor_Surface_2(face, true);
    const surface = enumName(oc.GeomAbs_SurfaceType, adaptor.GetType());
    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(face, box, false);
    const mn = box.CornerMin(), mx = box.CornerMax();
    const bbox = [mn.X(), mn.Y(), mn.Z(), mx.X(), mx.Y(), mx.Z()];
    box.delete();
    if (surface === "GeomAbs_Cylinder") {
      const cyl = adaptor.Cylinder();
      const axis = cyl.Axis(), dir = axis.Direction(), loc = axis.Location();
      cylinders.push({
        r: cyl.Radius(),
        loc: [loc.X(), loc.Y(), loc.Z()],
        dir: [dir.X(), dir.Y(), dir.Z()],
        bbox,
      });
      adaptor.delete();
    } else if (FREEFORM_SURFACES.includes(surface)) {
      freeforms.push({ adaptor, bbox });
    } else {
      adaptor.delete();
    }
  }
  explorer.delete();
  return {
    cylinders,
    freeforms,
    overflow: faceCount > MAX_FACES,
    dispose: () => { for (const f of freeforms) f.adaptor.delete(); },
  };
}

const boxesOverlap = (a, b, pad) =>
  a[0] <= b[3] + pad && b[0] <= a[3] + pad &&
  a[1] <= b[4] + pad && b[1] <= a[4] + pad &&
  a[2] <= b[5] + pad && b[2] <= a[5] + pad;

// Fraction of a freeform face's interior sample grid lying on the cylinder.
function onCylinderFraction(freeform, cyl, tol) {
  const ad = freeform.adaptor;
  const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter();
  const v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
  let hits = 0;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const p = ad.Value(u0 + ((i + 0.5) / GRID) * (u1 - u0), v0 + ((j + 0.5) / GRID) * (v1 - v0));
      const px = p.X() - cyl.loc[0], py = p.Y() - cyl.loc[1], pz = p.Z() - cyl.loc[2];
      const t = px * cyl.dir[0] + py * cyl.dir[1] + pz * cyl.dir[2];
      const rx = px - t * cyl.dir[0], ry = py - t * cyl.dir[1], rz = pz - t * cyl.dir[2];
      if (Math.abs(Math.hypot(rx, ry, rz) - cyl.r) <= tol) hits += 1;
    }
  }
  return hits / (GRID * GRID);
}

function contactBetween(profileA, profileB) {
  for (const [cylSide, freeSide] of [[profileA, profileB], [profileB, profileA]]) {
    for (const cyl of cylSide.cylinders) {
      const tol = Math.max(MIN_TOL, REL_TOL * cyl.r);
      for (const freeform of freeSide.freeforms) {
        if (!boxesOverlap(cyl.bbox, freeform.bbox, tol)) continue;
        if (onCylinderFraction(freeform, cyl, tol) >= MIN_ON_FRACTION) return { radius: cyl.r };
      }
    }
  }
  return null;
}

// The one entry point. `solids` are replicad Shape3D wrappers (`.wrapped` is
// the TopoDS shape); every unordered pair is checked, because a cutAll fuses
// its tools together before cutting — the contact can be tool-to-tool as
// easily as target-to-tool. Throws the coached error on contact; returns
// silently otherwise. Any internal failure returns silently too: the guard
// must never break a boolean that would have succeeded.
export function assertNoCoincidentBoolean(oc, opName, solids) {
  if (!oc || solids.length < 2) return;
  const profiles = [];
  try {
    for (const s of solids) profiles.push(faceProfile(oc, s.wrapped));
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const contact = contactBetween(profiles[i], profiles[j]);
        if (contact) throw coincidentBooleanError(opName, contact.radius);
      }
    }
  } catch (e) {
    if (e?.code === "COINCIDENT_BOOLEAN") throw e;
    // Detection is best-effort; a probe failure must not block the build.
  } finally {
    for (const p of profiles) { try { p.dispose(); } catch { /* freed with the shape */ } }
  }
}

function coincidentBooleanError(opName, radius) {
  const r = Number(radius.toFixed(4));
  const err = new Error(
    `${opName} between exactly-touching surfaces: a swept or curved face of one operand lies ` +
    `exactly on a cylindrical face of the other (radius ${r}). The exact kernel cannot process ` +
    `this contact — it grinds for minutes or returns broken geometry — so the build was refused ` +
    `before trying. Make the surfaces genuinely overlap or genuinely clear each other (0.05 or ` +
    `more) instead of exactly touching; for an internal thread, replace the bore + screwSweep ` +
    `pair with k.tappedBore, which builds the same tap as one safe tool.`,
  );
  err.code = "COINCIDENT_BOOLEAN";
  return err;
}
