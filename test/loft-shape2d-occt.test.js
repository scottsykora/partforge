// OCCT-only file (vitest isolates per file; never boot Manifold here). Parity with the
// Manifold numbers is asserted against shared ANALYTIC values, not a co-booted kernel:
//  - curve mode: exact rounded-square prismatoid (OCCT is curve-exact ⇒ tight tolerance);
//  - resample mode: the prismatoid estimate V = h/6 · (A0 + 4·A½ + A1) over the SAME
//    resolved rings both backends consume. Not exact for either backend (OCCT's ruled
//    faces between skew edges are saddle patches; Manifold splits each wall quad into
//    two triangles), but both land within a fraction of a percent of it — and of each
//    other — because they loft the identical vertex correspondence. Both files pin the
//    same formula at the same tolerance; that shared anchor is the parity assertion.
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import { resolveLoftRings } from "../src/framework/geometry/loft-rings.js";
import { roundedProfile, circleProfile } from "../src/framework/geometry/polygon.js";

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

const SQ = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
const shoelace = (ring) => ring.reduce((a, [x, y], i) => {
  const [nx, ny] = ring[(i + 1) % ring.length];
  return a + x * ny - nx * y;
}, 0) / 2;

test("curve mode: rounded-square rings loft as EXACT B-rep — analytic prism volume", () => {
  const rsq = roundedProfile(SQ, 2);
  const v = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }] }).volume();
  const exact = (100 - (4 - Math.PI) * 4) * 10;   // 965.6637061…
  expect(v).toBeCloseTo(exact, 3);                 // curve-exact, not faceted
});

test("curve mode: STEP export keeps true CIRCLE edges", async () => {
  const rsq = roundedProfile(SQ, 2);
  const solid = k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10, scale: 0.5 }] });
  const step = await k.toSTEP([{ name: "loft", solid }]);
  const text = typeof step === "string" ? step : new TextDecoder().decode(step);
  expect(text).toMatch(/CIRCLE/);
});

test("resample mode: volume tracks the prismatoid of the shared resolved rings (parity anchor)", () => {
  const rings = [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }];
  const { resolved } = resolveLoftRings(rings);
  const mid = resolved[0].pts2d.map((p, i) => [
    (p[0] + resolved[1].pts2d[i][0]) / 2, (p[1] + resolved[1].pts2d[i][1]) / 2]);
  const expected = (10 / 6) * (shoelace(resolved[0].pts2d) + 4 * shoelace(mid) + shoelace(resolved[1].pts2d));
  const v = k.loft({ rings }).volume();
  expect(Math.abs(v - expected) / expected).toBeLessThan(0.005); // same anchor+tolerance as loft-mesh.test.js
});

test("resample mode: STEP export is faceted (no CIRCLE edges) — the documented trade", async () => {
  const solid = k.loft({ rings: [{ polygon: SQ, z: 0 }, { polygon: circleProfile(4), z: 10 }] });
  const step = await k.toSTEP([{ name: "loft", solid }]);
  const text = typeof step === "string" ? step : new TextDecoder().decode(step);
  expect(text).not.toMatch(/CIRCLE/);
});

test("closed:true still throws on OCCT in every mode", () => {
  const rsq = roundedProfile(SQ, 2);
  expect(() => k.loft({ rings: [{ polygon: rsq, z: 0 }, { polygon: rsq, z: 10 }], closed: true }))
    .toThrow(/Manifold backend/);
});
