// Parametric capstan drum geometry (Replicad / OpenCASCADE).
// Port of the helical-groove core from cad/capstan_drum_generator.py.
// Currently a single-sweep + boolean cut — robust up to a few turns; the full
// multi-turn drum waits on the fuzzy-boolean work (see README).

import {
  makeCylinder,
  makeHelix,
  makeCircle,
  assembleWire,
  genericSweep,
} from "replicad";

export const DEFAULTS = {
  blankD: 10.2, // blank outer diameter (mm)
  pitch: 1.4, // axial groove pitch (mm/rev)
  turns: 1, // number of groove turns
  grooveW: 1.2, // groove width (mm) — cutter Ø; depth ≈ grooveW/2
};

export function buildDrum(params = {}) {
  const { blankD, pitch, turns, grooveW } = { ...DEFAULTS, ...params };
  const blankR = blankD / 2;
  const height = turns * pitch;
  const grooveCutR = grooveW / 2;
  const pathR = blankR; // cutter centre rides the surface -> ~grooveW/2 deep

  const blank = makeCylinder(blankR, height);

  // Helix(θ) = (R cosθ, R sinθ, pitch·θ/2π); tangent at θ=0 = (0, R, pitch/2π).
  const tangent = [0, pathR, pitch / (2 * Math.PI)];
  const spine = makeHelix(pitch, height, pathR);
  const profile = assembleWire([makeCircle(grooveCutR, [pathR, 0, 0], tangent)]);
  const grooveTool = genericSweep(profile, spine, { frenet: true });

  return blank.cut(grooveTool);
}
