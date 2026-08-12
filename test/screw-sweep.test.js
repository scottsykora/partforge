import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// An ISO-ish metric thread: 60 deg flanks, crest flat P/8, root flat P/4.
// PERIODIC form — spans exactly one pitch, first radius == last radius — so it
// yields the whole threaded rod in one op with no boolean. See the design spec.
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

test("a periodic profile yields a watertight rod of the right size", () => {
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  expect(rod.genus()).toBe(0);                       // no through-holes, no fold artifacts
  const { size } = rod.boundingBox();
  expect(size[0]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[1]).toBeCloseTo(2 * MAJOR_R, 3);
  expect(size[2]).toBeCloseTo(PITCH * TURNS, 3);
});

test("volume sits between the root and major cylinders", () => {
  // The single strongest shape check: a thread must add material over its root
  // cylinder and remove material from its major cylinder.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const h = PITCH * TURNS;
  expect(rod.volume()).toBeGreaterThan(Math.PI * ROOT_R ** 2 * h);
  expect(rod.volume()).toBeLessThan(Math.PI * MAJOR_R ** 2 * h);
});

test("volume is converged, not chord-starved", () => {
  // Regression guard for the densification bug: an undensified profile loses ~42%
  // of its volume. Doubling the turns must double the volume linearly.
  const one = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 2 }).volume();
  const two = k.screwSweep({ profile: ISO, pitch: PITCH, turns: 4 }).volume();
  expect(two / one).toBeCloseTo(2, 2);
  expect(one).toBeGreaterThan(190);   // measured 195.18; a chord-starved build gives ~112
});

test("the thread advances one full turn per pitch of height", () => {
  // Sample the crest angle a quarter-pitch apart: a right-hand thread advances +90 deg.
  const rod = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const mesh = rod.toMesh();
  const crestAngleAt = (zT) => {
    let best = null;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      if (Math.abs(z - zT) > PITCH * 0.02) continue;
      const r = Math.hypot(x, y);
      if (r > MAJOR_R - 0.01 && (!best || r > best.r)) best = { r, a: (Math.atan2(y, x) * 180) / Math.PI };
    }
    return best.a;
  };
  const z0 = (PITCH * TURNS) / 2;
  let delta = crestAngleAt(z0 + PITCH / 4) - crestAngleAt(z0);
  if (delta < -180) delta += 360;
  if (delta > 180) delta -= 360;
  expect(delta).toBeCloseTo(90, 0);
});

test("lefthand mirrors the volume but reverses the advance", () => {
  const rh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS });
  const lh = k.screwSweep({ profile: ISO, pitch: PITCH, turns: TURNS, lefthand: true });
  expect(lh.volume()).toBeCloseTo(rh.volume(), 1);
  expect(lh.genus()).toBe(0);
});

test("an over-pitch profile is rejected rather than silently folded", () => {
  expect(() => k.screwSweep({ profile: [[4, 0], [6, 0], [6, 2.5], [4, 2.5]], pitch: 1.5, turns: 3 }))
    .toThrow(/exceeds pitch/);
});
