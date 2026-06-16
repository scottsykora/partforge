// Capstan drum geometry (Replicad / OpenCASCADE) — port of the small- and
// big-drum cores from cad/capstan_drum_generator.py.
//
// buildDrum(part, params, onProgress) builds "small", "big", or "both".
// Intricate extras (tensioner pockets, end stops, load socket, rope-lock
// holes) are not ported yet — see README roadmap.

import {
  makeCylinder,
  makeHelix,
  makeCircle,
  assembleWire,
  genericSweep,
  makeCompound,
} from "replicad";
import { fuzzyCut } from "./fuzzy-cut.js";
import { DEFAULTS, derive } from "./params.js";

// A helical groove cutter: a circle swept along a helix. lefthand + partial
// turns supported (big-drum stripes are left-handed; the small-drum coil is
// right-handed).
function grooveTool(pathR, axialPitch, turns, z0, grooveR, lefthand) {
  const height = axialPitch * turns;
  const spine = makeHelix(axialPitch, height, pathR, [0, 0, z0], [0, 0, 1], lefthand);
  const dir = lefthand ? -1 : 1;
  const tangent = [0, dir * pathR, axialPitch / (2 * Math.PI)];
  const profile = assembleWire([makeCircle(grooveR, [pathR, 0, z0], tangent)]);
  return genericSweep(profile, spine, { frenet: true });
}

function buildSmallDrum(p, d, onProgress) {
  const margin = d.axialPitch; // plain band above/below the groove
  const bodyH = d.smallBodyH;
  const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;

  let drum = makeCylinder(d.smallBlankR, bodyH, [0, 0, baseH]);

  // continuous right-handed groove across the body
  onProgress?.("cutting small-drum groove");
  const gturns = Math.max(1, (bodyH - 2 * margin) / d.axialPitch);
  const pathR = d.smallBlankR - d.grooveDepth + d.grooveR;
  const tool = grooveTool(pathR, d.axialPitch, gturns, baseH + margin, d.grooveR, false);
  drum = fuzzyCut(drum, tool);

  // motor flange + standoff neck + bolt holes (z = 0 is the rotor face)
  if (p.motor_mount) {
    const flangeR = p.motor_bolt_circle_d / 2 + p.motor_flange_margin;
    drum = drum.fuse(makeCylinder(flangeR, p.motor_flange_t));
    drum = drum.fuse(
      makeCylinder(d.smallBlankR, p.motor_standoff_h + 0.05, [0, 0, p.motor_flange_t - 0.05])
    );
    const r = p.motor_bolt_circle_d / 2;
    for (let i = 0; i < p.motor_bolt_count; i++) {
      const a = (2 * Math.PI * i) / p.motor_bolt_count;
      drum = drum.cut(
        makeCylinder(p.motor_bolt_d / 2, p.motor_flange_t + 2, [r * Math.cos(a), r * Math.sin(a), -1])
      );
    }
  }

  // 608ZZ support stub on top
  if (p.top_stub_d > 0) {
    drum = drum.fuse(
      makeCylinder(p.top_stub_d / 2, p.top_stub_len, [0, 0, baseH + bodyH - 0.05])
    );
  }

  // central shaft bore (through everything) — last so it clears all fused parts
  if (p.small_bore_d > 0) {
    const totalH = baseH + bodyH + (p.top_stub_d > 0 ? p.top_stub_len : 0) + 2;
    drum = drum.cut(makeCylinder(p.small_bore_d / 2, totalH, [0, 0, -1]));
  }
  return drum;
}

function buildBigDrum(p, d, onProgress) {
  const bodyH = d.bigBodyH;
  let drum = makeCylinder(d.bigBlankR, bodyH);

  const pathR = d.bigBlankR - d.grooveDepth + d.grooveR;
  const a0 = (d.sector - d.arc) / 2;

  // Group the (disjoint) stripe tools into a compound — far cheaper than a
  // boolean fuse — then cut them all in one fuzzy boolean.
  onProgress?.("building groove field");
  const tools = [];
  for (let k = 0; k < d.stripes; k++) {
    let t = grooveTool(pathR, d.axialPitchBig, d.arc / 360, d.bigGrooveZ0 + k * d.stripeSpacing, d.grooveR, true);
    t = t.rotate(a0 + d.arc, [0, 0, 0], [0, 0, 1]);
    tools.push(t);
  }
  onProgress?.("cutting big-drum grooves");
  drum = fuzzyCut(drum, makeCompound(tools));

  // center bore
  if (p.big_center_bore_d > 0) {
    drum = drum.cut(makeCylinder(p.big_center_bore_d / 2, bodyH + 2, [0, 0, -1]));
  }
  // bearing seats, both faces
  if (p.big_bearing_pocket_d > 0) {
    const pr = p.big_bearing_pocket_d / 2;
    const pt = p.big_bearing_pocket_t;
    drum = drum.cut(makeCylinder(pr, pt + 1, [0, 0, -1]));
    drum = drum.cut(makeCylinder(pr, pt + 1, [0, 0, bodyH - pt]));
  }
  // link-mounting bolt circle (clocked 45° off the wedge)
  if (p.big_bolt_circle_d > 0 && p.big_bolt_count > 0) {
    const r = p.big_bolt_circle_d / 2;
    for (let i = 0; i < p.big_bolt_count; i++) {
      const a = (2 * Math.PI * i) / p.big_bolt_count + Math.PI / 4;
      drum = drum.cut(
        makeCylinder(p.big_bolt_d / 2, bodyH + 2, [r * Math.cos(a), r * Math.sin(a), -1])
      );
    }
  }
  return drum;
}

export function buildDrum(part = "small", params = {}, onProgress) {
  const p = { ...DEFAULTS, ...params };
  const d = derive(p);

  if (part === "small") return buildSmallDrum(p, d, onProgress);
  if (part === "big") return buildBigDrum(p, d, onProgress);

  // both — two separate drums shown side by side along X (a compound, not a
  // boolean union — they're disjoint).
  onProgress?.("building small drum");
  const small = buildSmallDrum(p, d, onProgress);
  onProgress?.("building big drum");
  const big = buildBigDrum(p, d, onProgress);
  const dx = d.smallBlankR + d.bigBlankR + 8;
  return makeCompound([
    small.translate([-dx / 2, 0, 0]),
    big.translate([dx / 2, 0, 0]),
  ]);
}
