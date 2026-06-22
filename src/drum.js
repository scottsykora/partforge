// Capstan drum geometry — builds all geometry through an injected GeometryKernel
// instead of calling replicad directly. Same geometry as before; the kernel
// abstracts the backend (OCCT via replicad, or Manifold).
//
// Public API:
//   buildSubPart(kernel, name, params)  → Solid   name ∈ "small"|"big"|"block"
//   buildParts(kernel, part, params)    → {name, shape}[]

import { piePolygon, hexPolygon } from "./framework/geometry/polygon.js";
import { DEFAULTS, derive } from "./params.js";

// A helical groove cutter: a circle profile swept along a helix.
// lefthand + partial turns supported (big-drum stripes are left-handed;
// the small-drum coil is right-handed).
function grooveTool(kernel, pathR, axialPitch, turns, z0, grooveR, lefthand) {
  return kernel.helixSweptTube({
    pathR,
    profileR: grooveR,
    pitch: axialPitch,
    turns,
    z0,
    lefthand,
  });
}

// An annular sector (ring slice) rootR..tipR spanning arcDeg, height h at z0 —
// a pie polygon extruded, minus the inner cylinder.
function annularSector(kernel, rootR, tipR, arcDeg, h, z0) {
  return kernel
    .prism(piePolygon(tipR, arcDeg), h)
    .translate([0, 0, z0])
    .cut(kernel.cylinder(rootR, rootR, h + 2).translate([0, 0, z0 - 1]));
}

// Hexagonal prism (nut trap) — cross-section in the X–Z plane centred at
// (cx, cz), running along Y from yLo for length nt. A vertex-up hexagon has
// its flats facing ±X so the captured nut can't spin.
function hexPrism(kernel, cx, cz, r, yLo, nt) {
  return kernel
    .prism(hexPolygon(r), nt)
    .rotate(-90, [0, 0, 0], [1, 0, 0])
    .translate([cx, yLo, cz]);
}

// Cutting tools for one sliding-block jack-screw tensioner, built at angle 0
// with the rope departing along +Y, tilted inward about the groove-end point.
function tensionerTools(kernel, p, d, bodyH, grooveZ, top) {
  const L = p.tensioner_pocket_l;
  const W = p.tensioner_pocket_w;
  const H = p.tensioner_pocket_depth;
  const hd = p.tensioner_head_d;
  const rp = d.bigPitchR;
  const y0 = -0.5;
  const y1 = 0.5 + L;
  const zb = top ? bodyH - H : -1.0;
  // Screw axis sits offset from the rope-groove plane toward the nearer drum
  // face, so the bolt bore + its access cutout clear the rope hole.
  const sz = grooveZ + (top ? p.tensioner_screw_offset : -p.tensioner_screw_offset);
  const tools = [
    kernel.box([rp - (W - 4), y0, zb], [rp + 4, y1, zb + H + 1]), // pocket
    kernel.cylinder((p.tensioner_screw_d + 0.4) / 2, (p.tensioner_screw_d + 0.4) / 2, 4.5)
      .rotate(-90, [0, 0, 0], [1, 0, 0])
      .translate([rp, y1 - 0.5, sz]), // screw bore along +Y
    kernel.cylinder(hd / 2, hd / 2, 30)
      .rotate(-90, [0, 0, 0], [1, 0, 0])
      .translate([rp, y1 + 3, sz]), // head access bore along +Y
    kernel.box([rp, y1 + 3, sz - hd / 2], [rp + 15, y1 + 33, sz + hd / 2]), // head clearance
  ];
  return tools.map((t) => t.rotate(p.tensioner_angle_deg, [rp, 0, 0], [0, 0, 1]));
}

// The sliding block the rope ties to (print 2 per joint).
function buildTensionerBlock(kernel, p, d) {
  const L = Math.max(4, p.tensioner_pocket_l - p.tensioner_travel);
  const fit = 0.3;
  const W = p.tensioner_pocket_w - fit;
  const H = p.tensioner_pocket_depth - 0.4;
  const cz = p.tensioner_pocket_depth - d.bigGrooveZ0 + p.tensioner_screw_offset;
  let blk = kernel.box([0, 0, 0], [W, L, H]);

  const sx = p.tensioner_pocket_w - 4 - fit / 2;
  // screw bore along +Y
  blk = blk.cut(
    kernel.cylinder((p.tensioner_screw_d + 0.4) / 2, (p.tensioner_screw_d + 0.4) / 2, L + 2)
      .rotate(-90, [0, 0, 0], [1, 0, 0])
      .translate([sx, -1, cz])
  );

  // captured-nut hex trap + slide-in slot
  const af = p.tensioner_nut_af + 0.3;
  const hexR = af / Math.sqrt(3);
  const nt = p.tensioner_nut_t + 0.5;
  const ny = L / 2;
  blk = blk.cut(hexPrism(kernel, sx, cz, hexR, ny - nt / 2, nt));
  blk = blk.cut(kernel.box([sx - af / 2, ny - nt / 2, cz], [sx + af / 2, ny + nt / 2, H + 1]));

  // rope feed hole (snug) + knot pocket behind
  const rx = 2.3;
  const rz = 2.4;
  // rope feed along +Y
  blk = blk.cut(
    kernel.cylinder(0.55 * p.rope_d, 0.55 * p.rope_d, L + 2)
      .rotate(-90, [0, 0, 0], [1, 0, 0])
      .translate([rx, -1, rz])
  );
  // knot pocket along -Y
  blk = blk.cut(
    kernel.cylinder(1.5 * p.rope_d, 1.5 * p.rope_d, 2 * p.rope_d)
      .rotate(90, [0, 0, 0], [1, 0, 0])
      .translate([rx, L + 0.01, rz])
  );
  return blk;
}

// Seat a standalone block into tensioner pocket A for the assembly view.
function seatBlock(kernel, block, p, d) {
  const rp = d.bigPitchR;
  const sx = p.tensioner_pocket_w - 4 - 0.15;
  const L = Math.max(4, p.tensioner_pocket_l - p.tensioner_travel);
  const y0 = -0.5;
  const y1 = 0.5 + p.tensioner_pocket_l;
  const deepEnd = p.tensioner_pocket_depth;
  return block
    .mirror("XY")
    .translate([rp - sx, (y0 + y1) / 2 - L / 2, deepEnd])
    .rotate(p.tensioner_angle_deg, [rp, 0, 0], [0, 0, 1])
    .rotate(d.anchorA.ang, [0, 0, 0], [0, 0, 1]);
}

function buildSmallDrum(kernel, p, d, onProgress) {
  const margin = d.axialPitch;
  const bodyH = d.smallBodyH;
  const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;

  let drum = kernel.cylinder(d.smallBlankR, d.smallBlankR, bodyH).translate([0, 0, baseH]);

  // continuous right-handed groove across the body
  onProgress?.("cutting small-drum groove");
  const gturns = Math.max(1, (bodyH - 2 * margin) / d.axialPitch);
  const pathR = d.smallBlankR - d.grooveDepth + d.grooveR;
  const tool = grooveTool(kernel, pathR, d.axialPitch, gturns, baseH + margin, d.grooveR, false);
  drum = drum.cut(tool);

  // motor flange + standoff neck + bolt holes (z = 0 is the rotor face)
  if (p.motor_mount) {
    const flangeR = p.motor_bolt_circle_d / 2 + p.motor_flange_margin;
    drum = kernel.union([drum, kernel.cylinder(flangeR, flangeR, p.motor_flange_t)]);
    drum = kernel.union([
      drum,
      kernel.cylinder(d.smallBlankR, d.smallBlankR, p.motor_standoff_h + 0.05)
        .translate([0, 0, p.motor_flange_t - 0.05]),
    ]);
    const r = p.motor_bolt_circle_d / 2;
    for (let i = 0; i < p.motor_bolt_count; i++) {
      const a = (2 * Math.PI * i) / p.motor_bolt_count;
      const x = r * Math.cos(a);
      const y = r * Math.sin(a);
      // through clearance hole
      drum = drum.cut(
        kernel.cylinder(p.motor_bolt_d / 2, p.motor_bolt_d / 2, p.motor_flange_t + 2)
          .translate([x, y, -1])
      );
      // counterbore from the flange top
      if (p.motor_cbore_d > 0 && p.motor_cbore_depth > 0) {
        drum = drum.cut(
          kernel.cylinder(p.motor_cbore_d / 2, p.motor_cbore_d / 2, p.motor_cbore_depth + 1)
            .translate([x, y, p.motor_flange_t - p.motor_cbore_depth])
        );
      }
    }
  }

  // mid-rope lock: one tilted diametral weave hole near mid-height
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
      const ax = [-2 * br / len, 0, dz / len]; // normalized direction (in XZ plane)
      const start = [inX - ax[0] * 2, 0, lockZ - ax[2] * 2];
      // lock hole: axis in XZ plane — rotate around Y by atan2(ax[0], ax[2])
      drum = drum.cut(
        kernel.cylinder(lockR, lockR, len + 4)
          .rotate(Math.atan2(ax[0], ax[2]) * 180 / Math.PI, [0, 0, 0], [0, 1, 0])
          .translate(start)
      );
    }
  }

  // motor-stalk bore — BLIND, opens at the rotor face
  if (p.small_bore_d > 0) {
    const boreTop =
      p.small_bore_depth > 0
        ? p.small_bore_depth
        : lockZ != null
        ? lockZ - lockR - 1.5
        : baseH + bodyH + 1;
    drum = drum.cut(
      kernel.cylinder(p.small_bore_d / 2, p.small_bore_d / 2, boreTop + 1).translate([0, 0, -1])
    );
  }

  // 608ZZ support stub on top: root cone (body -> stub) · cylinder · tip chamfer
  if (p.top_stub_d > 0) {
    const stubR = p.top_stub_d / 2;
    const rootH = 1.2;
    const ch = Math.min(0.8, stubR - 0.5);
    const z = baseH + bodyH;
    drum = kernel.union([drum, kernel.cylinder(d.smallBlankR, stubR, rootH).translate([0, 0, z - 0.01])]);
    const cylH = Math.max(0.1, p.top_stub_len - ch);
    drum = kernel.union([drum, kernel.cylinder(stubR, stubR, cylH + 0.02).translate([0, 0, z + rootH - 0.01])]);
    drum = kernel.union([drum, kernel.cylinder(stubR, stubR - ch, ch).translate([0, 0, z + rootH + cylH - 0.005])]);
  }

  return drum;
}

function buildBigDrum(kernel, p, d, onProgress) {
  const bodyH = d.bigBodyH;
  let drum = kernel.cylinder(d.bigBlankR, d.bigBlankR, bodyH);

  const stopTipR =
    p.end_stop_arc > 0
      ? Math.sqrt(d.centerDist ** 2 - d.smallBlankR ** 2) + p.stop_tip_extra
      : d.bigBlankR;

  // --- interior / wedge features FIRST, on the plain blank ---
  // Booleans against a plain cylinder are ~30x cheaper than against the grooved
  // solid — cut them before the grooves.
  onProgress?.("boring + mounting");

  // center bore
  if (p.big_center_bore_d > 0) {
    drum = drum.cut(
      kernel.cylinder(p.big_center_bore_d / 2, p.big_center_bore_d / 2, bodyH + 2).translate([0, 0, -1])
    );
  }
  // bearing seats, both faces
  if (p.big_bearing_pocket_d > 0) {
    const pr = p.big_bearing_pocket_d / 2;
    const pt = p.big_bearing_pocket_t;
    drum = drum.cut(kernel.cylinder(pr, pr, pt + 1).translate([0, 0, -1]));
    drum = drum.cut(kernel.cylinder(pr, pr, pt + 1).translate([0, 0, bodyH - pt]));
  }
  // link-mounting bolt circle (clocked 45° off the wedge)
  if (p.big_bolt_circle_d > 0 && p.big_bolt_count > 0) {
    const r = p.big_bolt_circle_d / 2;
    for (let i = 0; i < p.big_bolt_count; i++) {
      const a = (2 * Math.PI * i) / p.big_bolt_count + Math.PI / 4;
      drum = drum.cut(
        kernel.cylinder(p.big_bolt_d / 2, p.big_bolt_d / 2, bodyH + 2)
          .translate([r * Math.cos(a), r * Math.sin(a), -1])
      );
    }
  }
  // load-test pipe socket (radial, in the groove-free wedge, mid-height)
  if (p.load_socket_pipe_od > 0) {
    const sr = (p.load_socket_pipe_od + p.load_socket_fit) / 2;
    const freeLo = p.tensioner_pocket_depth > 0 ? p.tensioner_pocket_depth : 1;
    const freeHi = bodyH - freeLo;
    const zc = bodyH / 2;
    if (zc - sr >= freeLo + 0.3 && zc + sr <= freeHi - 0.3) {
      const length = stopTipR - p.load_socket_stop_r + 2;
      // socket cylinder along +X
      let sock = kernel.cylinder(sr, sr, length)
        .rotate(90, [0, 0, 0], [0, 1, 0])
        .translate([p.load_socket_stop_r, 0, zc]);
      if (p.load_socket_pin_d > 0) {
        const pinR = Math.min(38, d.bigBlankR - 6);
        sock = kernel.union([
          sock,
          kernel.cylinder(p.load_socket_pin_d / 2, p.load_socket_pin_d / 2, bodyH)
            .translate([pinR, 0, zc]),
        ]);
      }
      drum = drum.cut(sock.rotate(d.wedgeCenterDeg, [0, 0, 0], [0, 0, 1]));
    }
  }

  // --- groove field (the expensive cut; done once, after cheap cuts) ---
  const pathR = d.bigBlankR - d.grooveDepth + d.grooveR;
  const a0 = (d.sector - d.arc) / 2;
  onProgress?.("building groove field");
  const grooveTools = [];
  for (let ki = 0; ki < d.stripes; ki++) {
    let t = grooveTool(
      kernel, pathR, d.axialPitchBig, d.arc / 360,
      d.bigGrooveZ0 + ki * d.stripeSpacing, d.grooveR, true
    );
    t = t.rotate(a0 + d.arc, [0, 0, 0], [0, 0, 1]);
    grooveTools.push(t);
  }
  onProgress?.("cutting big-drum grooves");
  drum = drum.cut(kernel.union(grooveTools));

  // --- travel end stops (for current-spike homing) — at band edges ---
  if (p.end_stop_arc > 0) {
    onProgress?.("adding end stops");
    const bandLo = p.tensioner_pocket_depth > 0 ? p.tensioner_pocket_depth + 1 : 0;
    const rootR = d.bigBlankR - p.stop_root_depth;
    const specs = [
      { ang: d.a0 + d.arc, z0: bandLo, z1: bodyH }, // side A: above its pocket
      { ang: d.a0 - p.end_stop_arc, z0: 0, z1: bodyH - bandLo }, // side B: below its pocket
    ];
    const stops = specs.map((s) =>
      annularSector(kernel, rootR, stopTipR, p.end_stop_arc, s.z1 - s.z0, s.z0)
        .rotate(s.ang, [0, 0, 0], [0, 0, 1])
    );
    drum = kernel.union([drum, ...stops]);
  }

  // --- sliding-block tensioner pockets at each rope anchor ---
  if (p.tensioner_pocket_depth > 0) {
    onProgress?.("cutting tensioner pockets");
    const anchorTools = [];
    for (const s of [{ a: d.anchorA, top: false }, { a: d.anchorB, top: true }]) {
      let tools = tensionerTools(kernel, p, d, bodyH, s.a.z, s.top);
      if (s.top) tools = tools.map((t) => t.mirror("XZ"));
      tools = tools.map((t) => t.rotate(s.a.ang, [0, 0, 0], [0, 0, 1]));
      // union one anchor's overlapping tools into a single solid;
      // the two anchors are disjoint, so all of it comes out in one boolean
      anchorTools.push(tools.reduce((acc, t) => kernel.union([acc, t])));
    }
    drum = drum.cutAll(anchorTools);
  }

  return drum;
}

// Returns the drum(s) as a list of named parts: one entry for "small"/"big",
// two for "both". Each part is a single solid, so each exports cleanly.
export function buildParts(kernel, part = "small", params = {}, onProgress) {
  const p = { ...DEFAULTS, ...params };
  const d = derive(p);

  const parts = [];
  if (part === "small") {
    parts.push({ name: "small_drum", shape: buildSmallDrum(kernel, p, d, onProgress) });
  } else if (part === "big") {
    parts.push({ name: "big_drum", shape: buildBigDrum(kernel, p, d, onProgress) });
  } else {
    onProgress?.("building small drum");
    const small = buildSmallDrum(kernel, p, d, onProgress);
    onProgress?.("building big drum");
    const big = buildBigDrum(kernel, p, d, onProgress);
    const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;
    parts.push({ name: "small_drum", shape: small.translate([-d.centerDist, 0, -baseH]) });
    parts.push({ name: "big_drum", shape: big });
  }

  // Tensioner block (print 2 per joint), standalone for export / slicing.
  // (The seated-in-pocket render is built separately via buildSubPart("block");
  // we must NOT seat it here — seatBlock() transforms consume the shape on the
  // OCCT backend, which would free the very block we're exporting.)
  if (part !== "small" && p.tensioner_pocket_depth > 0) {
    onProgress?.("building tensioner block");
    parts.push({ name: "tensioner_block", shape: buildTensionerBlock(kernel, p, d) });
  }

  return parts;
}

// Build ONE display sub-part in the shared "both" assembly frame, so views can
// be composed from independently-cached meshes:
//   small  — small drum, dropped + offset to its meshing position
//   big    — big drum at the origin
//   block  — tensioner block seated in pocket A on the big drum
export function buildSubPart(kernel, name, params = {}, onProgress) {
  const p = { ...DEFAULTS, ...params };
  const d = derive(p);
  if (name === "small") {
    const baseH = p.motor_mount ? p.motor_flange_t + p.motor_standoff_h : 0;
    return buildSmallDrum(kernel, p, d, onProgress).translate([-d.centerDist, 0, -baseH]);
  }
  if (name === "big") return buildBigDrum(kernel, p, d, onProgress);
  if (name === "block") return seatBlock(kernel, buildTensionerBlock(kernel, p, d), p, d);
  throw new Error(`unknown sub-part: ${name}`);
}
