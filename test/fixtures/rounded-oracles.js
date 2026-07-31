// test/fixtures/rounded-oracles.js
// Analytic volume oracles for the rounded primitives: numeric quadrature over
// the spec's exact closed-form cross-sections. The all-equal Minkowski form is
// an independent anchor the quadrature is checked against.

export function simpson(f, a, b, n = 8192) {
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

// Round-over inset at distance zFromFace ∈ [0, R] into a rim zone of radius R.
const inset = (R, zFromFace) =>
  R <= 0 ? 0 : R - Math.sqrt(Math.max(0, R * R - (R - zFromFace) ** 2));

// Normative roundedBox cross-section area at height z (spec §Semantics).
export function roundedBoxSection([w, d, h], { side, top, bottom }, z) {
  const delta = z < bottom ? inset(bottom, z) : z > h - top ? inset(top, h - z) : 0;
  const rc = Math.max(side - delta, 0);
  return (w - 2 * delta) * (d - 2 * delta) - (4 - Math.PI) * rc * rc;
}

export const roundedBoxVolume = (size, round) =>
  simpson((z) => roundedBoxSection(size, round, z), 0, size[2]);

export function roundedCylinderRadius(r, h, { top, bottom }, z) {
  const delta = z < bottom ? inset(bottom, z) : z > h - top ? inset(top, h - z) : 0;
  return r - delta;
}

export const roundedCylinderVolume = (r, h, round) =>
  simpson((z) => Math.PI * roundedCylinderRadius(r, h, round, z) ** 2, 0, h);

export const torusVolume = (rMajor, rMinor) => 2 * Math.PI ** 2 * rMajor * rMinor * rMinor;

// Exact Minkowski closed form for the ALL-EQUAL rounded box.
export function minkowskiRoundedBoxVolume([w, d, h], r) {
  const a = w - 2 * r, b = d - 2 * r, c = h - 2 * r;
  return a * b * c + 2 * r * (a * b + a * c + b * c)
    + Math.PI * r * r * (a + b + c) + (4 / 3) * Math.PI * r ** 3;
}
