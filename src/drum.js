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
  loft,
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

// A truncated cone (frustum) from r1 at z0 to r2 at z0+h, via a loft of two
// circles — replicad has no makeCone.
function frustum(r1, r2, h, z0) {
  const w1 = assembleWire([makeCircle(r1, [0, 0, z0])]);
  const w2 = assembleWire([makeCircle(r2, [0, 0, z0 + h])]);
  return loft([w1, w2]);
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
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      // through clearance hole
      drum = drum.cut(makeCylinder(p.motor_bolt_d / 2, p.motor_flange_t + 2, [x, y, -1]));
      // counterbore from the flange top so the M3 socket head sits flush
      if (p.motor_cbore_d > 0 && p.motor_cbore_depth > 0) {
        drum = drum.cut(
          makeCylinder(p.motor_cbore_d / 2, p.motor_cbore_depth + 1, [
            x, y, p.motor_flange_t - p.motor_cbore_depth,
          ])
        );
      }
    }
  }

  // mid-rope lock: one tilted diametral weave hole near mid-height, entering
  // the groove on one side and leaving it half a pitch higher on the other.
  let lockZ = null;
  const lockR = (p.rope_lock_hole_d ?? 0) / 2;
  if (lockR > 0) {
    const pitch = d.axialPitch;
    const br = d.smallBlankR;
    const t1 = Math.round((bodyH / 2 - pitch / 4 - margin) / pitch);
    if (t1 >= 1) {
      lockZ = baseH + margin + t1 * pitch;
      const inX = br;
      const dz = pitch / 2;
      const len = Math.hypot(2 * br, dz);
      const ax = [-2 * br / len, 0, dz / len]; // p_in -> p_out, normalized
      const start = [inX - ax[0] * 2, 0, lockZ - ax[2] * 2];
      drum = drum.cut(makeCylinder(lockR, len + 4, start, ax));
    }
  }

  // motor-stalk bore — BLIND, opens at the rotor face. Use the explicit depth
  // if set; otherwise auto-stop 1.5 mm below the lock hole.
  if (p.small_bore_d > 0) {
    const boreTop =
      p.small_bore_depth > 0
        ? p.small_bore_depth
        : lockZ != null
        ? lockZ - lockR - 1.5
        : baseH + bodyH + 1;
    drum = drum.cut(makeCylinder(p.small_bore_d / 2, boreTop + 1, [0, 0, -1]));
  }

  // 608ZZ support stub on top: root cone (body -> stub) · cylinder · tip chamfer
  if (p.top_stub_d > 0) {
    const stubR = p.top_stub_d / 2;
    const rootH = 1.2;
    const ch = Math.min(0.8, stubR - 0.5);
    const z = baseH + bodyH;
    drum = drum.fuse(frustum(d.smallBlankR, stubR, rootH, z - 0.01));
    const cylH = Math.max(0.1, p.top_stub_len - ch);
    drum = drum.fuse(makeCylinder(stubR, cylH + 0.02, [0, 0, z + rootH - 0.01]));
    drum = drum.fuse(frustum(stubR, stubR - ch, ch, z + rootH + cylH - 0.005));
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

  // both — show the real meshing relationship: parallel axes at the gear
  // centre distance (small_pitch_r + big_pitch_r, so the pitch circles touch),
  // with the small drum dropped by its motor-mount stack so its groove body
  // lines up with the big drum's groove band and the motor tucks underneath.
  onProgress?.("building small drum");
  const small = buildSmallDrum(p, d, onProgress);
  onProgress?.("building big drum");
  const big = buildBigDrum(p, d, onProgress);
  const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;
  const centerDist = d.smallPitchR + d.bigPitchR;
  return makeCompound([small.translate([-centerDist, 0, -baseH]), big]);
}
