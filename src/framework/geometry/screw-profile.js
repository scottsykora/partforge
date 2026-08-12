// Screw motion as a transverse cross-section. A profile point (r, z) in the axial
// half-plane travels to (r·cos θ, r·sin θ, z + pitch·θ/2π) under screw motion, and
// that whole solid is reproduced EXACTLY by extruding a polar-remapped section with
// twist = 360°·turns — one full turn of twist per pitch of height. So screwSweep
// needs no backend op: it is k.extrude in disguise (see kernel-front.js).
//
// The subtlety that makes this correct rather than nearly-correct: the map sends
// profile POINTS to polar, but the EDGES between them become straight chords where
// the true surface needs spiral arcs. Undensified, an ISO tooth loses ~42% of its
// volume. So every segment is subdivided to a fixed 5° polar step — fixed, not a
// per-call tolerance, so both backends see the identical polygon and the solid
// cache keys stay stable.

// Degrees of polar sweep per emitted point. Matches Manifold's twist division
// resolution (nDiv = ceil(|twist|/5) in manifold-backend.js), so the angular and
// axial sampling of the same solid agree. Converges to 0.03% of the exact volume.
export const SCREW_STEP_DEG = 5;

const EPS = 1e-9;

export function screwCrossSection(profile, pitch, { lefthand = false } = {}) {
  if (!Array.isArray(profile) || profile.length < 2)
    throw new Error("screwSweep: profile must be an array of at least 2 [r, z] points");
  if (!(pitch > 0)) throw new Error("screwSweep: pitch must be > 0");
  for (const p of profile) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new Error("screwSweep: every profile point must be a finite [r, z]");
    if (p[0] < 0) throw new Error("screwSweep: profile radius must be ≥ 0");
  }

  const zs = profile.map(([, z]) => z);
  const extent = Math.max(...zs) - Math.min(...zs);
  if (extent > pitch + EPS)
    throw new Error(
      `screwSweep: profile axial extent ${extent} exceeds pitch ${pitch} — consecutive ` +
      "turns would interpenetrate; reduce the profile height or increase pitch");

  // Subdivide by POLAR span, not by length: a segment with no z change sweeps no
  // angle and needs no extra points.
  const dense = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[i + 1];
    const span = Math.abs((360 * (z1 - z0)) / pitch);
    const n = Math.max(1, Math.ceil(span / SCREW_STEP_DEG));
    for (let j = 0; j < n; j++)
      dense.push([r0 + ((r1 - r0) * j) / n, z0 + ((z1 - z0) * j) / n]);
  }
  dense.push(profile[profile.length - 1]);

  // A profile spanning exactly one pitch closes on itself by periodicity: its last
  // point maps to the same polar angle as its first, so it must agree in radius and
  // the duplicate is dropped (a zero-length edge would otherwise reach the backend).
  let pts = dense;
  if (extent > pitch - EPS) {
    const r0 = profile[0][0], rN = profile[profile.length - 1][0];
    if (Math.abs(r0 - rN) > 1e-6)
      throw new Error(
        `screwSweep: a full-pitch profile must be periodic — first radius ${r0} ` +
        `must equal last radius ${rN}`);
    pts = dense.slice(0, -1);
  }

  const sign = lefthand ? 1 : -1;
  return pts.map(([r, z]) => {
    const psi = (sign * 2 * Math.PI * z) / pitch;
    const x = r * Math.cos(psi);
    let y = r * Math.sin(psi);
    if (y === 0) y = 0; // Normalize -0 to 0
    return [x, y];
  });
}
