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
  makeBox,
  loft,
  draw,
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

// An annular sector (ring slice) rootR..tipR spanning arcDeg, height h at z0 —
// a pie sketch extruded, minus the inner cylinder. (makeCylinder has no sector.)
function annularSector(rootR, tipR, arcDeg, h, z0) {
  const a = (arcDeg * Math.PI) / 180;
  const pie = draw([0, 0])
    .lineTo([tipR, 0])
    .threePointsArcTo(
      [tipR * Math.cos(a), tipR * Math.sin(a)],
      [tipR * Math.cos(a / 2), tipR * Math.sin(a / 2)]
    )
    .lineTo([0, 0])
    .close()
    .sketchOnPlane("XY", z0)
    .extrude(h);
  return pie.cut(makeCylinder(rootR, h + 2, [0, 0, z0 - 1]));
}

// Cutting tools for one sliding-block jack-screw tensioner, built at angle 0
// with the rope departing along +Y, tilted inward about the groove-end point.
function tensionerTools(p, d, bodyH, grooveZ, top) {
  const L = p.tensioner_pocket_l;
  const W = p.tensioner_pocket_w;
  const H = p.tensioner_pocket_depth;
  const hd = p.tensioner_head_d;
  const rp = d.bigPitchR;
  const y0 = -0.5;
  const y1 = 0.5 + L;
  const zb = top ? bodyH - H : -1.0;
  const tools = [
    makeBox([rp - (W - 4), y0, zb], [rp + 4, y1, zb + H + 1]), // pocket
    makeCylinder((p.tensioner_screw_d + 0.4) / 2, 4.5, [rp, y1 - 0.5, grooveZ], [0, 1, 0]), // screw bore
    makeCylinder(hd / 2, 30, [rp, y1 + 3, grooveZ], [0, 1, 0]), // head access bore
    makeBox([rp, y1 + 3, grooveZ - hd / 2], [rp + 15, y1 + 33, grooveZ + hd / 2]), // head clearance
  ];
  return tools.map((t) => t.rotate(p.tensioner_angle_deg, [rp, 0, 0], [0, 0, 1]));
}

// Hexagonal prism (nut trap) — cross-section in the X–Z plane centred at
// (cx, cz), running along Y from yLo for length nt. A vertex-up hexagon has its
// flats facing ±X (the block side walls), so the captured nut can't spin.
function hexPrism(cx, cz, r, yLo, nt) {
  let pen = draw([0, r]); // first vertex at top
  for (let i = 1; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    pen = pen.lineTo([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pen
    .close()
    .sketchOnPlane("XY")
    .extrude(nt) // prism along +Z
    .rotate(-90, [0, 0, 0], [1, 0, 0]) // stand it up along +Y
    .translate([cx, yLo, cz]);
}

// The sliding block the rope ties to (print 2 per joint): box sized to the
// pocket, with a jack-screw clearance bore, a captured-nut hex trap + slide-in
// slot, and a snug rope feed hole with a knot pocket behind. Ported from
// build_tensioner_block() in the FreeCAD generator.
function buildTensionerBlock(p, d) {
  const L = p.tensioner_pocket_l - 5.0; // leaves ~5 mm of tensioning travel
  const W = p.tensioner_pocket_w - 0.4;
  const H = p.tensioner_pocket_depth - 0.4;
  const cz = p.tensioner_pocket_depth - d.bigGrooveZ0; // screw axis above floor
  let blk = makeBox([0, 0, 0], [W, L, H]);

  const sx = W - 4.2; // screw axis off-centre toward the outboard face
  blk = blk.cut(makeCylinder((p.tensioner_screw_d + 0.4) / 2, L + 2, [sx, -1, cz], [0, 1, 0]));

  // captured-nut hex trap + slide-in slot up to the open face
  const af = p.tensioner_nut_af + 0.3;
  const hexR = af / Math.sqrt(3);
  const nt = p.tensioner_nut_t + 0.5;
  const ny = L / 2;
  blk = blk.cut(hexPrism(sx, cz, hexR, ny - nt / 2, nt));
  blk = blk.cut(makeBox([sx - af / 2, ny - nt / 2, cz], [sx + af / 2, ny + nt / 2, H + 1]));

  // rope feed hole (snug) + knot pocket behind
  const rx = 2.3;
  const rz = 2.4;
  blk = blk.cut(makeCylinder(0.55 * p.rope_d, L + 2, [rx, -1, rz], [0, 1, 0]));
  blk = blk.cut(makeCylinder(1.5 * p.rope_d, 2 * p.rope_d, [rx, L + 0.01, rz], [0, -1, 0]));
  return blk;
}

// Seat a standalone block into tensioner pocket A for the assembly view. The
// block's screw axis is placed at the pocket's local screw position (rp,*,
// groove z) with the floor toward the pocket's deep end, then given the SAME
// tilt + anchor rotation the pocket got — so the block bore is collinear with
// the pocket bore (the screw runs straight through).
function seatBlock(block, p, d) {
  const rp = d.bigPitchR;
  const sx = p.tensioner_pocket_w - 0.4 - 4.2; // block screw x (local)
  const L = p.tensioner_pocket_l - 5;
  const y0 = -0.5;
  const y1 = 0.5 + p.tensioner_pocket_l;
  const deepEnd = p.tensioner_pocket_depth; // side A pocket deep-end z (zb+H+1)
  return block
    .mirror("XY") // flip so the floor faces the pocket's deep end
    .translate([rp - sx, (y0 + y1) / 2 - L / 2, deepEnd])
    .rotate(p.tensioner_angle_deg, [rp, 0, 0], [0, 0, 1]) // same tilt as the pocket
    .rotate(d.anchorA.ang, [0, 0, 0], [0, 0, 1]); // anchor A azimuth
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

  // --- travel end stops (for current-spike homing) ---
  let stopTipR = d.bigBlankR;
  if (p.end_stop_arc > 0) {
    onProgress?.("adding end stops");
    const bandLo = p.tensioner_pocket_depth > 0 ? p.tensioner_pocket_depth + 1 : 0;
    const rootR = d.bigBlankR - p.stop_root_depth;
    stopTipR = Math.sqrt(d.centerDist ** 2 - d.smallBlankR ** 2) + p.stop_tip_extra;
    const specs = [
      { ang: d.a0 + d.arc, z0: bandLo, z1: bodyH }, // side A: above its pocket
      { ang: d.a0 - p.end_stop_arc, z0: 0, z1: bodyH - bandLo }, // side B: below its pocket
    ];
    for (const s of specs) {
      const stop = annularSector(rootR, stopTipR, p.end_stop_arc, s.z1 - s.z0, s.z0);
      drum = drum.fuse(stop.rotate(s.ang, [0, 0, 0], [0, 0, 1]));
    }
  }

  // --- load-test pipe socket (radial, wedge centre, mid-height) ---
  if (p.load_socket_pipe_od > 0) {
    const sr = (p.load_socket_pipe_od + p.load_socket_fit) / 2;
    const freeLo = p.tensioner_pocket_depth > 0 ? p.tensioner_pocket_depth : 1;
    const freeHi = bodyH - freeLo;
    const zc = bodyH / 2;
    if (zc - sr >= freeLo + 0.3 && zc + sr <= freeHi - 0.3) {
      onProgress?.("cutting load socket");
      const length = stopTipR - p.load_socket_stop_r + 2;
      let sock = makeCylinder(sr, length, [p.load_socket_stop_r, 0, zc], [1, 0, 0]);
      if (p.load_socket_pin_d > 0) {
        const pinR = Math.min(38, d.bigBlankR - 6);
        sock = sock.fuse(makeCylinder(p.load_socket_pin_d / 2, bodyH, [pinR, 0, zc], [0, 0, 1]));
      }
      drum = drum.cut(sock.rotate(d.wedgeCenterDeg, [0, 0, 0], [0, 0, 1]));
    }
  }

  // --- sliding-block tensioner pockets at each rope anchor ---
  if (p.tensioner_pocket_depth > 0) {
    onProgress?.("cutting tensioner pockets");
    for (const s of [{ a: d.anchorA, top: false }, { a: d.anchorB, top: true }]) {
      for (let t of tensionerTools(p, d, bodyH, s.a.z, s.top)) {
        if (s.top) t = t.mirror("XZ");
        drum = drum.cut(t.rotate(s.a.ang, [0, 0, 0], [0, 0, 1]));
      }
    }
  }

  return drum;
}

// Returns the drum(s) as a list of named parts: one entry for "small"/"big",
// two for "both". Each part is a single solid, so each exports cleanly on its
// own (a compound trips up the STEP/STL writers).
export function buildParts(part = "small", params = {}, onProgress) {
  const p = { ...DEFAULTS, ...params };
  const d = derive(p);

  const parts = [];
  if (part === "small") {
    parts.push({ name: "small_drum", shape: buildSmallDrum(p, d, onProgress) });
  } else if (part === "big") {
    parts.push({ name: "big_drum", shape: buildBigDrum(p, d, onProgress) });
  } else {
    // both — real meshing relationship: parallel axes at the gear centre
    // distance (pitch circles touch), the small drum dropped by its motor-mount
    // stack so its groove body lines up with the big drum's band.
    onProgress?.("building small drum");
    const small = buildSmallDrum(p, d, onProgress);
    onProgress?.("building big drum");
    const big = buildBigDrum(p, d, onProgress);
    const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;
    parts.push({ name: "small_drum", shape: small.translate([-d.centerDist, 0, -baseH]) });
    parts.push({ name: "big_drum", shape: big });
  }

  // Tensioner block (print 2 per joint): shown SEATED in pocket A so the screw
  // path lines up, but exported as a standalone solid (at origin) for printing.
  if (part !== "small" && p.tensioner_pocket_depth > 0) {
    onProgress?.("building tensioner block");
    const block = buildTensionerBlock(p, d);
    parts.push({
      name: "tensioner_block",
      shape: block, // standalone, for export / slicing
      display: seatBlock(block, p, d), // seated in pocket A, for the render
    });
  }

  return parts;
}

// Display shape: a single solid, or a compound of the parts' display geometry
// (meshes fine). Uses each part's seated `display` if present, else `shape`.
export function buildDrum(part = "small", params = {}, onProgress) {
  const shapes = buildParts(part, params, onProgress).map((x) => x.display ?? x.shape);
  return shapes.length === 1 ? shapes[0] : makeCompound(shapes);
}
