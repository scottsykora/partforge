// Fuzzy boolean cut via the raw OpenCASCADE kernel.
//
// replicad's high-level Shape3D.cut() runs BRepAlgoAPI_Cut with the default
// (zero) fuzzy tolerance, which returns an EMPTY result for large near-tangent
// helical groove tools (fine up to a few turns, empty by ~10). OCCT's fuzzy
// boolean snaps near-coincident geometry within a tolerance and makes the
// operation robust — this is how the full multi-turn drum gets cut.
//
// Mirrors replicad's own cut() (BRepAlgoAPI_Cut_3 + Build + SimplifyResult +
// cast) and just adds SetFuzzyValue before Build.

import { getOC, cast } from "replicad";

export function fuzzyCut(base, tool, { fuzz = 1e-3, simplify = false } = {}) {
  const oc = getOC();
  const progress = new oc.Message_ProgressRange_1();
  const cutter = new oc.BRepAlgoAPI_Cut_3(base.wrapped, tool.wrapped, progress);
  cutter.SetFuzzyValue(fuzz);
  cutter.Build(progress);
  if (cutter.HasErrors && cutter.HasErrors()) {
    cutter.delete();
    progress.delete();
    throw new Error(`fuzzy cut failed (OCCT BOP error, fuzz=${fuzz})`);
  }
  // SimplifyResult merges coplanar faces but is very slow on helical results —
  // off by default; the mesh/STEP are fine without it.
  if (simplify) cutter.SimplifyResult(true, true, 1e-3);
  const result = cast(cutter.Shape());
  cutter.delete();
  progress.delete();
  return result;
}
