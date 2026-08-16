// The committed offset corpus: deterministic, seeded shape families shared by the fuzz
// test (test/offset-fuzz.test.js) and the rate sweep (scripts/offset-rates.mjs).
//
// Why this file exists: every quantitative claim this branch's docs make about the offset
// engine — throw rates per corner style, accuracy against the oracle — used to come from
// scratch scripts that were never committed, so nobody could re-run them and a reviewer who
// tried got different answers. Anything a doc asserts about rates must be reproducible by
// running something in the repo; this is the input side of that instrument, and
// `scripts/offset-rates.mjs` is the measuring side.
//
// Determinism is the whole point: `Math.random` is never called here. Every case is a pure
// function of its integer seed, so a failure reported as "seed 4173" is reproducible forever
// with `node scripts/offset-rates.mjs --seed 4173`.

// mulberry32 — 32-bit, seedable, ~2^32 period. Not cryptographic and does not need to be;
// it needs to be identical on every machine and every Node version, which a hand-written
// integer PRNG is and `Math.random` is not.
export function rng(seed) {
  let a = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ring = (pts) => ({ start: [pts[0][0], pts[0][1]],
  segments: [...pts.slice(1).map((p) => ({ to: [p[0], p[1]] })), { to: [pts[0][0], pts[0][1]] }] });
const translate = (r, dx, dy) => ({
  start: [r.start[0] + dx, r.start[1] + dy],
  segments: r.segments.map((s) => (s.via
    ? { via: [s.via[0] + dx, s.via[1] + dy], to: [s.to[0] + dx, s.to[1] + dy] }
    : { to: [s.to[0] + dx, s.to[1] + dy] })),
});

// ── families ────────────────────────────────────────────────────────────────────────────
//
// 1. notched plate — a rectangle with 1…4 slots cut down from its top edge, at CONTINUOUS
//    (non-grid) coordinates. This is the family the chain-incomplete failure lives in: an
//    inward offset severs the plate at the web between two notch floors. The 12-vertex
//    two-notch plate that falsified this branch's "sharp never throws" claim is a member
//    (32 x 9, notches at x 1.869…5.132 depth 7.459 and x 8.404…9.429 depth 2.493).
function notchedPlate(r) {
  const W = 20 + r() * 20, H = 8 + r() * 6;
  const n = 1 + Math.floor(r() * 4);
  // Lay the notches out left to right in disjoint lanes so they never overlap, then walk
  // the top edge right to left (CCW ring).
  const lane = W / n;
  const notches = [];
  for (let i = 0; i < n; i++) {
    const w = 0.8 + r() * Math.min(4, lane * 0.5);
    const x0 = i * lane + 0.6 + r() * Math.max(0.1, lane - w - 1.2);
    notches.push({ x0, x1: x0 + w, d: H * (0.25 + r() * 0.65) });
  }
  const pts = [[0, 0], [W, 0], [W, H]];
  for (const nt of notches.slice().reverse())
    pts.push([nt.x1, H], [nt.x1, H - nt.d], [nt.x0, H - nt.d], [nt.x0, H]);
  pts.push([0, H]);
  return { outer: ring(pts), holes: [] };
}

// 2. pocket plate — a rectangle with 1…3 rectangular or CIRCULAR pockets. Exercises hole
//    merge, hole breakthrough, and (for the circular ones) arcs on the hole side.
function pocketPlate(r) {
  const W = 24 + r() * 16, H = 14 + r() * 10;
  const k = 1 + Math.floor(r() * 3);
  const holes = [];
  const lane = W / k;
  for (let i = 0; i < k; i++) {
    const cx = i * lane + lane * (0.25 + r() * 0.5), cy = H * (0.25 + r() * 0.5);
    if (r() < 0.4) {
      const rad = 1 + r() * Math.min(4, Math.min(cy, H - cy) - 0.5);
      if (rad < 0.6) continue;
      // CW (hole winding) circle as two half-arcs.
      holes.push({ start: [cx + rad, cy],
        segments: [{ via: [cx, cy - rad], to: [cx - rad, cy] }, { via: [cx, cy + rad], to: [cx + rad, cy] }] });
    } else {
      const hw = 0.5 + r() * Math.min(4, lane * 0.35), hh = 0.5 + r() * Math.min(5, H * 0.3);
      holes.push(ring([[cx - hw, cy - hh], [cx - hw, cy + hh], [cx + hw, cy + hh], [cx + hw, cy - hh]]));
    }
  }
  return { outer: ring([[0, 0], [W, 0], [W, H], [0, H]]), holes };
}

// 3. radial polygon — 5…12 vertices at jittered angles and radii. Where the ACUTE corners
//    are: a spike whose neighbouring radii differ by 3x has a ~30 degree interior angle, so
//    this is the family that separates a real chamfer from Clipper2's Round@4 proxy.
function radialPolygon(r) {
  const n = 5 + Math.floor(r() * 8);
  const base = 4 + r() * 6;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + (r() - 0.5) * (Math.PI / n) * 0.8;
    const rad = base * (0.35 + r() * 0.9);
    pts.push([rad * Math.cos(a), rad * Math.sin(a)]);
  }
  return { outer: ring(pts), holes: [] };
}

// 4. multi-region — two shapes from the families above in ONE offset call, far enough apart
//    that they never interact. The multi-region code path is otherwise barely exercised.
function multiRegion(r) {
  const a = r() < 0.5 ? notchedPlate(r) : radialPolygon(r);
  const b = r() < 0.5 ? pocketPlate(r) : radialPolygon(r);
  return [a, { outer: translate(b.outer, 70, 0), holes: b.holes.map((h) => translate(h, 70, 0)) }];
}

const FAMILIES = [
  ["notched-plate", (r) => [notchedPlate(r)]],
  ["pocket-plate", (r) => [pocketPlate(r)]],
  ["radial-polygon", (r) => [radialPolygon(r)]],
  ["multi-region", multiRegion],
];

/** The deltas every generated case is swept at: 16 inward (where severing lives) + 4 outward. */
export const CORPUS_DELTAS = [
  -0.25, -0.5, -0.75, -1, -1.25, -1.5, -1.75, -2, -2.25, -2.5, -2.75, -3, -3.25, -3.5, -3.75, -4,
  0.25, 0.5, 1, 2,
];
export const CORNER_STYLES = ["round", "chamfer", "sharp"];

/** One case from one integer seed. Pure: the same seed always gives the same geometry. */
export function caseFor(seed) {
  const r = rng(seed);
  const [family, build] = FAMILIES[seed % FAMILIES.length];
  return { seed, family, regions: build(r) };
}

/** `count` cases starting at `from` (default 0). */
export function corpus(count, from = 0) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(caseFor(from + i));
  return out;
}

// The reviewer's counter-example to "sharp never throws", kept as a named fixture so both
// the fuzz test and the rate script can assert it explicitly rather than hoping a random
// seed lands on it. At delta -3.25 BOTH sharp and chamfer throw chain-incomplete and the
// fallback ladder does not rescue either; -3.2 and -3.3 both build.
export const TWO_NOTCH_PLATE = [{ outer: ring([[0, 0], [32, 0], [32, 9],
  [9.428889, 9], [9.428889, 6.506983], [8.403683, 6.506983], [8.403683, 9],
  [5.132466, 9], [5.132466, 1.541126], [1.86893, 1.541126], [1.86893, 9], [0, 9]]), holes: [] }];

/** Glyph cases, given a parsed opentype font and the framework's textGlyphs. */
export function glyphCases(textGlyphs, font, chars = ["o", "e", "a", "p", "t", "Scott"]) {
  return chars.map((ch) => ({ seed: `glyph:${ch}`, family: "glyph", text: ch,
    regions: textGlyphs(font, ch, { size: 10 }) }));
}

/** Parse the framework's bundled default font (Roboto) with opentype.js. */
export async function loadDefaultFont() {
  const opentype = (await import("opentype.js")).default;
  const { DEFAULT_FONT_BYTES: b } = await import("../../src/framework/geometry/fonts/default-font.js");
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
