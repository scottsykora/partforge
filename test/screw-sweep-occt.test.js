import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

// OCCT and Manifold must not boot in the same process — hence this separate file.
let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const PITCH = 1.5, MAJOR_R = 5, TURNS = 6;
const H = (Math.sqrt(3) / 2) * PITCH;
const ROOT_R = MAJOR_R - (5 / 8) * H;
const CREST_FLAT = PITCH / 8, ROOT_FLAT = PITCH / 4;
const RISE = (PITCH - CREST_FLAT - ROOT_FLAT) / 2;
const ISO = [
  [ROOT_R,  0],
  [ROOT_R,  ROOT_FLAT],
  [MAJOR_R, ROOT_FLAT + RISE],
  [MAJOR_R, ROOT_FLAT + RISE + CREST_FLAT],
  [ROOT_R,  PITCH],
];

test("volume agrees with the Manifold reference within 0.5%", () => {
  // Manifold measured 585.54 for these exact parameters (design spec, finding 4).
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(Math.abs(rod.volume() - 585.54) / 585.54).toBeLessThan(0.005);
});

test("the rod exports to STEP as real geometry, not an empty shell", () => {
  // An empty solid exports happily at ~2KB; a real threaded rod is orders larger.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(rod.volume()).toBeGreaterThan(500);
  return k.toSTEP([{ name: "rod", solid: rod }]).then((step) => {
    expect(step.byteLength).toBeGreaterThan(100_000);
  });
}, 60000);

test("a rod unioned with a head keeps both volumes", () => {
  // The carried risk: the sliver-shaped operand destroyed OCCT booleans. A filled
  // rod should not. If this fails, the docs must forbid the union and the reference
  // part must model the head as a separate sub-part instead.
  //
  // The head OVERLAPS the rod by 1mm rather than sitting flush on top: a flush
  // union shares a coincident face, which is its own OCCT failure mode and would
  // confound the result we are actually after.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const rodVol = rod.volume();
  const headVol = Math.PI * 8 ** 2 * 4;
  const head = k.cylinder({ r: 8, h: 4 }).translate([0, 0, PITCH * TURNS - 1]);
  const bolt = k.union([rod, head]);
  // Overlap makes the exact sum unavailable, so bracket it: the union must contain
  // essentially all of both solids, and cannot exceed their sum.
  expect(bolt.volume()).toBeGreaterThan(rodVol + headVol * 0.8);
  expect(bolt.volume()).toBeLessThanOrEqual(rodVol + headVol);
}, 60000);

test("a head landing FLUSH on the shank top unions exactly, coincident face and all", () => {
  // What the reference part actually does — .at([0, 0, length]) puts the head's
  // base exactly on the rod's top plane. A coincident face is its own OCCT
  // boolean hazard, and STEP export is the only thing that routes a part here,
  // so nothing else would catch it. Disjoint solids: volumes must simply add.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const headR = 17 / Math.sqrt(3);   // hex across flats 17 → circumradius
  const hexPoints = Array.from({ length: 6 }, (_, i) =>
    [headR * Math.cos((Math.PI / 3) * i), headR * Math.sin((Math.PI / 3) * i)]);
  const head = k.prism({ points: hexPoints, h: 6.4 }).at([0, 0, PITCH * TURNS]);
  const rodVol = rod.volume(), headVol = head.volume();
  // Precision 4 (1e-4 mm³ on ~2187 mm³), not 6: OCCT integrates volume over re-split
  // B-spline faces and does not guarantee 1e-10 relative agreement across builds or
  // platforms. This still fails decisively on what the test is for — a dropped
  // operand or a swallowed coincident face move the total by hundreds of mm³.
  expect(k.union([rod, head]).volume()).toBeCloseTo(rodVol + headVol, 4);
}, 60000);
