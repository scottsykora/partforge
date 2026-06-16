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
  groove_pitch_factor: 1.4,
  groove_depth_factor: 0.6,

  // reduction stage
  ratio: 9.6,
  small_pitch_d: 10.0,
  output_range_deg: 300.0,
  contact_wraps: 3.0,

  // small drum
  small_bore_d: 5.1,
  small_match_big_h: false, // viewer default: groove covers the working band
  // (faster); the production small drum matches the big-drum height
  top_stub_d: 8.0,
  top_stub_len: 7.5,

  // motor mount (bottom of small drum)
  motor_mount: true,
  motor_bolt_circle_d: 20.0,
  motor_bolt_count: 4,
  motor_bolt_d: 3.4,
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
};

export const SECTIONS = [
  {
    id: "rope",
    title: "Rope",
    presets: {
      "1 mm Dyneema": { rope_d: 1.0, groove_clearance: 1.2, groove_pitch_factor: 1.4, groove_depth_factor: 0.6 },
      "1.5 mm": { rope_d: 1.5, groove_clearance: 1.15, groove_pitch_factor: 1.4, groove_depth_factor: 0.6 },
      "2 mm": { rope_d: 2.0, groove_clearance: 1.1, groove_pitch_factor: 1.4, groove_depth_factor: 0.6 },
    },
    advanced: [
      { key: "rope_d", label: "Rope Ø", unit: "mm", min: 0.5, max: 3, step: 0.1 },
      { key: "groove_clearance", label: "Groove clearance", unit: "×", min: 1.0, max: 1.5, step: 0.05 },
      { key: "groove_pitch_factor", label: "Groove pitch", unit: "×d", min: 1.1, max: 2.0, step: 0.1 },
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
      { key: "small_pitch_d", label: "Small pitch Ø", unit: "mm", min: 6, max: 16, step: 0.2 },
      { key: "output_range_deg", label: "Joint travel", unit: "°", min: 90, max: 340, step: 5 },
      { key: "contact_wraps", label: "Contact wraps", unit: "", min: 2, max: 5, step: 0.5 },
    ],
  },
  {
    id: "motor",
    title: "Motor mount",
    presets: {
      "Eagle Power 8308 (Ø20 BC)": { motor_mount: true, motor_bolt_circle_d: 20, motor_bolt_count: 4 },
      "None": { motor_mount: false },
    },
    advanced: [
      { key: "motor_bolt_circle_d", label: "Bolt circle Ø", unit: "mm", min: 10, max: 40, step: 1 },
      { key: "motor_bolt_count", label: "Bolt count", unit: "", min: 3, max: 8, step: 1 },
      { key: "motor_flange_t", label: "Flange thickness", unit: "mm", min: 3, max: 10, step: 0.5 },
      { key: "motor_flange_margin", label: "Flange margin", unit: "mm", min: 2, max: 8, step: 0.5 },
      { key: "motor_standoff_h", label: "Standoff", unit: "mm", min: 0, max: 8, step: 0.5 },
    ],
  },
  {
    id: "small",
    title: "Small drum",
    presets: {
      "608ZZ stub + Ø5 shaft": { small_bore_d: 5.1, top_stub_d: 8.0, top_stub_len: 7.5 },
      "No stub / no bore": { small_bore_d: 0, top_stub_d: 0 },
    },
    advanced: [
      { key: "small_bore_d", label: "Shaft bore Ø", unit: "mm", min: 0, max: 10, step: 0.1 },
      { key: "top_stub_d", label: "Bearing stub Ø", unit: "mm", min: 0, max: 12, step: 0.1 },
      { key: "top_stub_len", label: "Stub length", unit: "mm", min: 0, max: 12, step: 0.5 },
    ],
  },
  {
    id: "big",
    title: "Big drum",
    presets: {
      "6808 bearing (Ø52)": { big_bearing_pocket_d: 52, big_bearing_pocket_t: 7, big_center_bore_d: 40, big_bolt_circle_d: 64 },
      "Plain (no bearing)": { big_bearing_pocket_d: 0, big_center_bore_d: 0, big_bolt_circle_d: 0 },
    },
    advanced: [
      { key: "big_edge_margin", label: "Rim margin", unit: "mm", min: 2, max: 8, step: 0.5 },
      { key: "big_center_bore_d", label: "Center bore Ø", unit: "mm", min: 0, max: 60, step: 1 },
      { key: "big_bearing_pocket_d", label: "Bearing seat Ø", unit: "mm", min: 0, max: 70, step: 1 },
      { key: "big_bearing_pocket_t", label: "Seat depth", unit: "mm", min: 0, max: 12, step: 0.5 },
      { key: "big_bolt_circle_d", label: "Bolt circle Ø", unit: "mm", min: 0, max: 80, step: 1 },
      { key: "big_bolt_count", label: "Bolt count", unit: "", min: 0, max: 8, step: 1 },
      { key: "big_stripe_count", label: "Groove count (0=auto)", unit: "", min: 0, max: 24, step: 1 },
    ],
  },
];

export function derive(p) {
  const ropeR = p.rope_d / 2;
  const grooveR = p.groove_clearance * ropeR;
  const grooveDepth = p.groove_depth_factor * p.rope_d;
  const axialPitch = p.groove_pitch_factor * p.rope_d;

  const smallPitchR = p.small_pitch_d / 2;
  const smallBlankR = smallPitchR + grooveDepth - ropeR;

  const bigPitchD = p.ratio * p.small_pitch_d;
  const bigBlankR = bigPitchD / 2 + grooveDepth - ropeR;
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

  // small drum body height: match big drum, or just cover the working band
  const smallBodyH = p.small_match_big_h
    ? bigBodyH
    : bandSmallMin + 2 * axialPitch;

  return {
    ropeR, grooveR, grooveDepth, axialPitch,
    smallPitchR, smallBlankR, smallBodyH,
    bigPitchD, bigBlankR, axialPitchBig,
    wrapsSmall, bandSmallMin,
    arc, stripes, stripeSpacing, stripeRise, bandBig, sector,
    bigBodyH, bigGrooveZ0,
  };
}
