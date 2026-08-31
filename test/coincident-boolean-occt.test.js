import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";

// OCCT and Manifold must not boot in the same process — hence this separate file.
//
// The coincident-boolean guard (occt-coincidence.js): a swept face lying
// exactly on a cylindrical face makes OCCT's boolean grind for minutes with no
// error, so the backend refuses it up front with coaching. These tests pin
// both halves — the refusal fires on the degenerate construction (at more than
// one scale), and every neighboring LEGITIMATE construction still builds:
// plain coincident cylinders (OCCT handles those same-domain, instantly), a
// thread with real clearance, and k.tappedBore's own composition.
let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 60000);

const PITCH = 1.5, MAJOR_R = 5, TURNS = 3;
const H = (Math.sqrt(3) / 2) * PITCH;
const ROOT_R = MAJOR_R - (5 / 8) * H;
const CREST_FLAT = PITCH / 8, ROOT_FLAT = PITCH / 4;
const RISE = (PITCH - CREST_FLAT - ROOT_FLAT) / 2;

// A female thread whose root sits at `rootR` — rootR === bore radius is the
// degenerate authoring mistake the guard exists for.
const thread = (rootR) => k.screwSweep({
  profile: [
    [rootR, 0],
    [rootR, ROOT_FLAT],
    [MAJOR_R, ROOT_FLAT + RISE],
    [MAJOR_R, ROOT_FLAT + RISE + CREST_FLAT],
    [rootR, PITCH],
  ],
  pitch: PITCH, turns: TURNS,
});
const bore = () => k.cylinder({ r: ROOT_R, h: PITCH * TURNS + 2 }).translate([0, 0, -1]);
const stock = () => k.cylinder({ r: MAJOR_R + 3, h: PITCH * TURNS + 4 }).translate([0, 0, -2]);

test("cutAll refuses the bore + coincident thread instead of hanging", () => {
  let error = null;
  const start = Date.now();
  try {
    stock().cutAll([bore(), thread(ROOT_R)]).volume();
  } catch (e) { error = e; }
  // The whole point: this used to grind past 15 minutes. Refusal is immediate
  // (the budget below is slack for CI, not an expectation).
  expect(Date.now() - start).toBeLessThan(30_000);
  expect(error).not.toBeNull();
  expect(error.code).toBe("COINCIDENT_BOOLEAN");
  // The coaching the model acts on: name the contact, the radius, and the fix.
  expect(error.message).toContain("exactly-touching surfaces");
  expect(error.message).toContain(`radius ${Number(ROOT_R.toFixed(4))}`);
  expect(error.message).toContain("k.tappedBore");
});

test("a direct union of the coincident pair is refused too", () => {
  expect(() => bore().union(thread(ROOT_R)).volume()).toThrow(/exactly-touching/);
});

test("the guard scales with the part: 4x larger still refused", () => {
  const bigThread = k.screwSweep({
    profile: [
      [ROOT_R * 4, 0],
      [ROOT_R * 4, ROOT_FLAT * 4],
      [MAJOR_R * 4, (ROOT_FLAT + RISE) * 4],
      [MAJOR_R * 4, (ROOT_FLAT + RISE + CREST_FLAT) * 4],
      [ROOT_R * 4, PITCH * 4],
    ],
    pitch: PITCH * 4, turns: TURNS,
  });
  const bigBore = k.cylinder({ r: ROOT_R * 4, h: (PITCH * TURNS + 2) * 4 }).translate([0, 0, -4]);
  expect(() => bigBore.union(bigThread).volume()).toThrow(/exactly-touching/);
});

test("a thread with real clearance builds", () => {
  // 0.05 is the documented minimum clearance; the guard must not flag it —
  // authors following the guidance would otherwise be refused.
  const result = stock().cutAll([bore(), thread(ROOT_R + 0.05)]);
  expect(result.volume()).toBeGreaterThan(0);
});

test("plain coincident cylinders still build — OCCT handles those same-domain", () => {
  // The three benign idioms measured instant on the real kernel: overlapping
  // coaxial same-radius rods, a flush stack, and re-cutting an existing hole.
  const overlap = k.cylinder({ r: 3.25, h: 10 }).union(k.cylinder({ r: 3.25, h: 10 }).translate([0, 0, 5]));
  expect(overlap.volume()).toBeGreaterThan(0);
  const flush = k.cylinder({ r: 3.25, h: 10 }).union(k.cylinder({ r: 3.25, h: 10 }).translate([0, 0, 10]));
  expect(flush.volume()).toBeGreaterThan(0);
  const holed = k.box({ size: [20, 20, 10] }).cut(k.cylinder({ r: 3.25, h: 12 }).translate([0, 0, -1]));
  const recut = holed.cut(k.cylinder({ r: 3.25, h: 12 }).translate([0, 0, -1]));
  expect(recut.volume()).toBeGreaterThan(0);
});

test("k.tappedBore's own composition passes the guard", () => {
  // The op the refusal coaches toward must never trip the refusal itself.
  const tapped = stock().cut(k.tappedBore({ d: ROOT_R * 2, pitch: PITCH, turns: TURNS }));
  expect(tapped.volume()).toBeGreaterThan(0);
  expect(tapped.volume()).toBeLessThan(stock().volume());
});
