// Cost bounds for the mesh fillet — the properties that keep it usable in the browser.
// A blend of radius r needs only enough facets to keep its chord sagitta invisible
// (~2 µm), never the kernel's full per-circle quality: at preview segs (116) a 0.5 mm
// fillet was tessellated to 0.2 µm sagitta, and a text rim's hundred-tool boolean
// carried ~300k tool triangles into the union — 12 s and 4 GB on the profiled Scotty
// lettering. These tests pin the output-size half of that fix (triangle budgets on the
// standard fixtures) plus the kernel plumbing it rides on (a revolve density override
// for free-standing corner arcs). Wall-time itself is not asserted — too flaky — but
// triangle counts are deterministic and the boolean's cost tracks them.
import { describe, it, expect, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const relErr = (v, expected) => Math.abs(v - expected) / Math.abs(expected);

const wavySquare = (L = 30, amp = 1.5, n = 24) => {
  const side = [];
  for (let i = 0; i < n; i++) side.push([(L * i) / n, amp * Math.sin((Math.PI * i) / n)]);
  const pts = [];
  for (const [c, s, ox, oy] of [[1, 0, 0, 0], [0, 1, L, 0], [-1, 0, L, L], [0, -1, 0, L]]) {
    for (const [x, y] of side) pts.push([ox + c * x - s * y, oy + s * x + c * y]);
  }
  return pts;
};

describe("blend tessellation is sagitta-bounded, not kernel-quality-bounded", () => {
  it("wavy-square rim r=1: result stays within the triangle budget at unchanged volume", () => {
    // pre-fix baseline: 29,076 tris, volume 6257.15 (preview quality, segs 116)
    const out = k.extrude({ profile: wavySquare(), h: 8 }).fillet(1, { inPlane: "XY", at: 8 });
    expect(out._m.numTri()).toBeLessThan(18_000);
    expect(relErr(out.volume(), 6257.15)).toBeLessThan(2e-3);
    expect(out.genus()).toBe(0);
  });

  it("box top rim r=3: result stays within the triangle budget at OCCT-parity volume", () => {
    // pre-fix baseline: 31,578 tris; OCCT native fillet reference volume 18939.956.
    // The budget carries ~2k of run-boundary residue: blend surfaces keep their
    // originalIDs for the boundary-line overlay, and simplify() cannot collapse
    // across the surviving run boundaries.
    const out = k.box({ min: [0, 0, 0], max: [40, 30, 16] }).fillet(3, { inPlane: "XY", at: 16 });
    expect(out._m.numTri()).toBeLessThan(27_000);
    expect(relErr(out.volume(), 18939.956)).toBeLessThan(2e-3);
    expect(out.genus()).toBe(0);
  });
});

describe("k.revolve honors a per-call segment override", () => {
  it("a coarse override produces fewer triangles than kernel quality, same volume class", () => {
    const poly = [[5, 0], [6, 0], [6, 1], [5, 1]];
    const fine = k.revolve(poly, { degrees: 90 });
    const coarse = k.revolve(poly, { degrees: 90, segs: 16 });
    expect(coarse._m.numTri()).toBeLessThan(fine._m.numTri());
    // both inscribe the same ring — coarse only loses chord sagitta, ~0.5% here
    expect(relErr(coarse.volume(), fine.volume())).toBeLessThan(2e-2);
  });
});
