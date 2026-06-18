// Parameter model for the capstan drum generator — ported from the PARAMS dict
// + derive() in cad/capstan_drum_generator.py.
//
// DEFAULTS  : flat param object (the source of truth for geometry).
// SECTIONS  : UI grouping — each section has named presets (simple choice) and
//             an `advanced` list (the full controls, revealed on expand).
// derive()  : computes dependent geometry (pitch radii, lead, stripe field…).

export const DEFAULTS = {
  // rope + groove
  rope_d: 1.0,
  groove_clearance: 1.2,
  groove_spacing: 1.4, // axial centre-to-centre spacing between grooves (mm)
  groove_depth_factor: 0.6,

  // reduction stage
  ratio: 9.6,
  small_pitch_d: 10.0,
  output_range_deg: 300.0,
  contact_wraps: 3.0,

  // small drum
  small_bore_d: 3.2, // motor-stalk pocket Ø (EaglePower stalk Ø3 + clearance)
  small_bore_depth: 7.0, // blind depth from the rotor face (stalk is 6 mm long;
  // 0 = auto: blind just below the rope-lock hole)
  small_match_big_h: true, // span the big-drum height so the coil covers travel
  rope_lock_hole_d: 1.5, // mid-rope lock weave hole diameter (0 disables)
  top_stub_d: 8.0,
  top_stub_len: 7.5,

  // motor mount (bottom of small drum)
  motor_mount: true,
  motor_bolt_circle_d: 31.0, // EaglePower 8308 — measured 30, +1 for fit
  motor_bolt_count: 4,
  motor_bolt_d: 3.95, // M3 clearance, opened up after a test fit (was 3.4)
  motor_cbore_d: 6.0, // counterbore Ø so an M3 socket head sits flush
  motor_cbore_depth: 3.0, // = M3 socket-head height
  motor_flange_t: 6.0,
  motor_flange_margin: 4.0,
  motor_standoff_h: 3.0,

  // big drum
  big_edge_margin: 4.0,
  big_stripe_count: 0, // 0 = auto
  big_groove_arc_deg: 0, // 0 = auto
  big_sector_deg: 360,
  big_center_bore_d: 40.0,
  big_bearing_pocket_d: 52.0,
  big_bearing_pocket_t: 7.0,
  big_bolt_circle_d: 64.0,
  big_bolt_count: 4,
  big_bolt_d: 3.2,

  // big-drum features (set the primary key to 0 to disable that feature)
  load_socket_pipe_od: 21.34, // 1/2" PVC load-test socket; 0 = off
  load_socket_fit: 0.4,
  load_socket_stop_r: 22.0,
  load_socket_pin_d: 2.5,
  end_stop_arc: 6.0, // current-spike homing stops; 0 = off
  stop_root_depth: 2.0,
  stop_tip_extra: 1.2,
  tensioner_pocket_depth: 7.0, // sliding-block tensioner pockets; 0 = off
  tensioner_pocket_l: 18.0,
  tensioner_pocket_w: 10.0,
  tensioner_travel: 8.0, // block is this much shorter than the pocket (slide range)
  tensioner_screw_d: 3.0,
  tensioner_head_d: 6.0,
  tensioner_angle_deg: 20.0,
  tensioner_nut_af: 5.5, // captured nut across-flats
  tensioner_nut_t: 2.4, // captured nut thickness
  tensioner_screw_offset: 2.0, // axial shift of the jack-screw bore + its access
  // cutout away from the rope plane, toward the nearer drum face, so the bolt
  // hole clears the rope feed/knot hole (the rope hole stays at the groove)
};

export const SECTIONS = [
  {
    id: "rope",
    title: "Rope",
    presets: {
      "1 mm Dyneema": { rope_d: 1.0, groove_clearance: 1.2, groove_spacing: 1.4, groove_depth_factor: 0.6 },
      "1.5 mm": { rope_d: 1.5, groove_clearance: 1.15, groove_spacing: 2.1, groove_depth_factor: 0.6 },
      "2 mm": { rope_d: 2.0, groove_clearance: 1.1, groove_spacing: 2.8, groove_depth_factor: 0.6 },
    },
    advanced: [
      { key: "rope_d", label: "Rope diameter", unit: "mm", min: 0.5, max: 3, step: 0.1 },
      { key: "groove_clearance", label: "Groove clearance", unit: "×", min: 1.0, max: 1.5, step: 0.05 },
      { key: "groove_spacing", label: "Groove spacing", unit: "mm", min: 1.0, max: 4.0, step: 0.1 },
      { key: "groove_depth_factor", label: "Groove depth", unit: "×d", min: 0.4, max: 0.8, step: 0.05 },
    ],
  },
  {
    id: "reduction",
    title: "Reduction",
    presets: {
      "9.6:1 · light (J5)": { ratio: 9.6 },
      "12:1 · elbow (J3/J4)": { ratio: 12 },
      "14:1 · shoulder (J1/J2)": { ratio: 14 },
    },
    advanced: [
      { key: "ratio", label: "Reduction", unit: ":1", min: 6, max: 16, step: 0.1 },
      { key: "small_pitch_d", label: "Small pitch diameter", unit: "mm", min: 6, max: 16, step: 0.2 },
      { key: "output_range_deg", label: "Joint travel", unit: "°", min: 90, max: 340, step: 5 },
      { key: "contact_wraps", label: "Contact wraps", unit: "", min: 2, max: 5, step: 0.5 },
    ],
  },
  {
    id: "motor",
    title: "Motor mount",
    presets: {
      "Eagle Power 8308 (31 mm bolt circle)": { motor_mount: true, motor_bolt_circle_d: 31, motor_bolt_count: 4, motor_bolt_d: 3.95 },
      "None": { motor_mount: false },
    },
    advanced: [
      { key: "motor_bolt_circle_d", label: "Bolt circle diameter", unit: "mm", min: 10, max: 40, step: 1 },
      { key: "motor_bolt_count", label: "Bolt count", unit: "", min: 3, max: 8, step: 1 },
      { key: "motor_cbore_d", label: "Counterbore diameter", unit: "mm", min: 0, max: 10, step: 0.5 },
      { key: "motor_cbore_depth", label: "Counterbore depth", unit: "mm", min: 0, max: 6, step: 0.5 },
      { key: "motor_flange_t", label: "Flange thickness", unit: "mm", min: 3, max: 10, step: 0.5 },
      { key: "motor_flange_margin", label: "Flange margin", unit: "mm", min: 2, max: 8, step: 0.5 },
      { key: "motor_standoff_h", label: "Standoff", unit: "mm", min: 0, max: 8, step: 0.5 },
    ],
  },
  {
    id: "small",
    title: "Small drum",
    presets: {
      "608ZZ stub + EaglePower stalk": { small_bore_d: 3.2, small_bore_depth: 7, top_stub_d: 8.0, top_stub_len: 7.5 },
      "No stub / no bore": { small_bore_d: 0, top_stub_d: 0 },
    },
    advanced: [
      { key: "small_bore_d", label: "Motor-stalk bore diameter", unit: "mm", min: 0, max: 12, step: 0.1 },
      { key: "small_bore_depth", label: "Bore depth (0=auto)", unit: "mm", min: 0, max: 30, step: 0.5 },
      { key: "rope_lock_hole_d", label: "Rope-lock hole diameter", unit: "mm", min: 0, max: 3, step: 0.1 },
      { key: "top_stub_d", label: "Bearing stub diameter", unit: "mm", min: 0, max: 12, step: 0.1 },
      { key: "top_stub_len", label: "Stub length", unit: "mm", min: 0, max: 12, step: 0.5 },
    ],
  },
  {
    id: "big",
    title: "Big drum",
    presets: {
      "6808 bearing (52 mm)": { big_bearing_pocket_d: 52, big_bearing_pocket_t: 7, big_center_bore_d: 40, big_bolt_circle_d: 64 },
      "Plain (no bearing)": { big_bearing_pocket_d: 0, big_center_bore_d: 0, big_bolt_circle_d: 0 },
    },
    advanced: [
      { key: "big_edge_margin", label: "Rim margin", unit: "mm", min: 2, max: 8, step: 0.5 },
      { key: "big_center_bore_d", label: "Center bore diameter", unit: "mm", min: 0, max: 60, step: 1 },
      { key: "big_bearing_pocket_d", label: "Bearing seat diameter", unit: "mm", min: 0, max: 70, step: 1 },
      { key: "big_bearing_pocket_t", label: "Seat depth", unit: "mm", min: 0, max: 12, step: 0.5 },
      { key: "big_bolt_circle_d", label: "Bolt circle diameter", unit: "mm", min: 0, max: 80, step: 1 },
      { key: "big_bolt_count", label: "Bolt count", unit: "", min: 0, max: 8, step: 1 },
      { key: "big_stripe_count", label: "Groove count (0=auto)", unit: "", min: 0, max: 24, step: 1 },
    ],
  },
  {
    id: "features",
    title: "Big-drum features",
    presets: {
      "Socket + stops + tensioners": { load_socket_pipe_od: 21.34, end_stop_arc: 6, tensioner_pocket_depth: 7 },
      "Tensioners + stops (no socket)": { load_socket_pipe_od: 0, end_stop_arc: 6, tensioner_pocket_depth: 7 },
      "None": { load_socket_pipe_od: 0, end_stop_arc: 0, tensioner_pocket_depth: 0 },
    },
    advanced: [
      { key: "load_socket_pipe_od", label: "Load-socket pipe diameter (0=off)", unit: "mm", min: 0, max: 30, step: 0.1 },
      { key: "end_stop_arc", label: "End-stop arc (0=off)", unit: "°", min: 0, max: 15, step: 1 },
      { key: "tensioner_pocket_depth", label: "Tensioner pocket depth (0=off)", unit: "mm", min: 0, max: 12, step: 0.5 },
      { key: "tensioner_angle_deg", label: "Tensioner tilt", unit: "°", min: 10, max: 35, step: 1 },
      { key: "tensioner_screw_offset", label: "Screw axial offset", unit: "mm", min: 0, max: 4, step: 0.5 },
      { key: "tensioner_pocket_l", label: "Pocket length", unit: "mm", min: 10, max: 26, step: 1 },
      { key: "tensioner_travel", label: "Tensioner travel", unit: "mm", min: 3, max: 16, step: 0.5 },
    ],
  },
];

export function derive(p) {
  const ropeR = p.rope_d / 2;
  const grooveR = p.groove_clearance * ropeR;
  const grooveDepth = p.groove_depth_factor * p.rope_d;
  const axialPitch = p.groove_spacing; // pitch = the chosen groove spacing

  const smallPitchR = p.small_pitch_d / 2;
  const smallBlankR = smallPitchR + grooveDepth - ropeR;

  const bigPitchD = p.ratio * p.small_pitch_d;
  const bigPitchR = bigPitchD / 2;
  const bigBlankR = bigPitchR + grooveDepth - ropeR;
  const axialPitchBig = axialPitch * p.ratio;

  const wrapsSmall = (p.ratio * p.output_range_deg) / 360 + p.contact_wraps;
  const bandSmallMin = wrapsSmall * axialPitch;

  // Big-drum stripe field (worm-gear clearance grooves)
  const arc = p.big_groove_arc_deg || Math.min(350, p.output_range_deg + 30);
  const stripes = p.big_stripe_count || Math.ceil(wrapsSmall + 1);
  const stripeSpacing = axialPitch;
  const stripeRise = (axialPitchBig * arc) / 360;
  const bandBig = (stripes - 1) * stripeSpacing + stripeRise;
  const sector = p.big_sector_deg || Math.min(360, arc + 30);

  const bigBodyH = bandBig + 2 * (p.big_edge_margin + axialPitch / 2);
  const bigGrooveZ0 = (bigBodyH - bandBig) / 2;

  // anchors + groove-free wedge (where the load socket / tensioners live)
  const a0 = (sector - arc) / 2;
  const wedgeCenterDeg = (2 * a0 + arc) % 360;
  const centerDist = smallPitchR + bigPitchR; // gear centre distance
  const anchorA = { ang: a0 + arc, z: bigGrooveZ0 }; // bottom groove end
  const anchorB = { ang: a0, z: bigGrooveZ0 + bandBig }; // top groove end

  // small drum body height: match the big drum (so the coil covers the full
  // groove travel), or just cover its own working band.
  const smallBodyH = p.small_match_big_h ? bigBodyH : bandSmallMin + 2 * axialPitch;

  return {
    ropeR, grooveR, grooveDepth, axialPitch,
    smallPitchR, smallBlankR, smallBodyH,
    bigPitchD, bigPitchR, bigBlankR, axialPitchBig,
    wrapsSmall, bandSmallMin,
    arc, stripes, stripeSpacing, stripeRise, bandBig, sector,
    bigBodyH, bigGrooveZ0,
    a0, wedgeCenterDeg, centerDist, anchorA, anchorB,
  };
}
