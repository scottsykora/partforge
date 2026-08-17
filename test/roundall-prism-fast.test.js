// The prism fast path for roundAll. Ball close-then-open via native Minkowski is
// seconds-per-thousand-triangles (measured 21 s on a 1.6k-tri text-outline prism —
// unusable in the browser), but on a Z-prism the SAME morphology decomposes exactly:
// the 2-D close-open of the cross-section (Clipper2 miter offsets +r, −2r, +r)
// handles wall melting and hole sealing, and a selector-free fillet of the
// re-extruded section at r supplies every rounded surface — vertical edges, both
// rims, and the corner treatments (miter keeps corners sharp on purpose: the true
// morphology mints r-radius outline corners, which pinch a radius-r rim fillet;
// filleting a sharp vertical edge at r reproduces the same rounding without the
// pinch). Non-prisms and degenerate cases (h ≤ 2r, a
// section that melts away entirely) keep the Minkowski path — the fast path may
// only ever substitute for it, never widen or narrow what roundAll accepts.
import { beforeAll, expect, it, describe } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { meshRoundAll, prismSection } from "../src/framework/geometry/mesh-roundall.js";
import { meshVolume, bboxSize } from "../src/framework/oracle/mesh.js";

let wasm, k;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
  k = createManifoldKernel(wasm, { quality: "preview" });
});

const blob = (nPts, R = 20) => {
  const p = [];
  for (let i = 0; i < nPts; i++) {
    const th = (2 * Math.PI * i) / nPts;
    const rr = R * (1 + 0.25 * Math.sin(7 * th) + 0.1 * Math.cos(13 * th));
    p.push([rr * Math.cos(th), rr * Math.sin(th)]);
  }
  return p;
};

const meshOf = (m) => {
  const g = m.getMesh();
  const n = g.vertProperties.length / g.numProp;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) positions[i * 3 + c] = g.vertProperties[i * g.numProp + c];
  const out = { positions, indices: Uint32Array.from(g.triVerts) };
  g.delete?.();
  return out;
};

describe("prismSection detection", () => {
  it("detects a Z-prism (translated included) and returns its constant section", () => {
    const m = k.extrude({ profile: blob(60), h: 2.5 }).at([3, -4, 7])._m;
    const got = prismSection(wasm, m);
    expect(got).not.toBeNull();
    expect(got.h).toBeCloseTo(2.5, 6);
    expect(got.z0).toBeCloseTo(7, 6);
    expect(got.cs.area()).toBeGreaterThan(0);
    got.cs.delete?.();
  });

  it("rejects a sphere and a stack of two different prisms", () => {
    expect(prismSection(wasm, k.sphere({ r: 5 })._m)).toBeNull();
    const stack = k.box({ min: [0, 0, 0], max: [10, 10, 4] })
      .union(k.box({ min: [2, 2, 4], max: [8, 8, 8] }));
    expect(prismSection(wasm, stack._m)).toBeNull();
  });
});

describe("roundAll rides the fast path on prisms", () => {
  it("rounds a text-scale outline prism interactively", () => {
    // pre-fast-path: ~12 s through the kernel on this fixture (native Minkowski)
    const solid = k.extrude({ profile: blob(200), h: 2.5 });
    const t0 = performance.now();
    const out = solid.roundAll({ r: 0.3 });
    out._m.numTri();
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(out.genus()).toBe(0);
    const size = bboxSize(meshOf(out._m).positions);
    expect(Math.abs(size[2] - 2.5)).toBeLessThan(0.05); // faces stay in place
  });

  it("matches the Minkowski morphology on a small prism", () => {
    const solid = k.extrude({ profile: blob(36), h: 3 });
    const fast = solid.roundAll({ r: 0.4 });
    const slow = meshRoundAll(wasm, solid._m, 0.4, "preview");
    const fm = meshOf(fast._m), sm = meshOf(slow);
    const fv = meshVolume(fm.positions, fm.indices), sv = meshVolume(sm.positions, sm.indices);
    expect(Math.abs(fv - sv) / sv).toBeLessThan(0.015);
    expect(fast.genus()).toBe(slow.genus());
    const fs = bboxSize(fm.positions), ss = bboxSize(sm.positions);
    for (let i = 0; i < 3; i++) expect(Math.abs(fs[i] - ss[i])).toBeLessThan(0.06);
    slow.delete();
  });
});

describe("the morphological contract survives the fast path", () => {
  it("melts a wall thinner than 2r", () => {
    // two 8mm-radius discs joined by a 0.4mm-wide neck; r=0.3 → ball 0.6 > 0.4
    const pts = [];
    const disc = (cx, s0, s1, n = 24) => {
      for (let i = 0; i <= n; i++) {
        const th = s0 + ((s1 - s0) * i) / n;
        pts.push([cx + 8 * Math.cos(th), 8 * Math.sin(th)]);
      }
    };
    const a = Math.asin(0.2 / 8);
    disc(-9, a, 2 * Math.PI - a);
    disc(9, Math.PI + a, 3 * Math.PI - a);
    const out = k.extrude({ profile: pts, h: 2 }).roundAll({ r: 0.3 });
    expect(out._m.decompose().length).toBe(2);
  });

  it("seals a hole narrower than 2r, keeps a wider one", () => {
    const plate = () => k.box({ min: [0, 0, 0], max: [20, 20, 2] });
    const sealed = plate()
      .cut(k.cylinder({ d: 0.5, h: 4 }).at([10, 10, -1]))
      .roundAll({ r: 0.3 });
    expect(sealed.genus()).toBe(0);
    const kept = plate()
      .cut(k.cylinder({ d: 3, h: 4 }).at([10, 10, -1]))
      .roundAll({ r: 0.3 });
    expect(kept.genus()).toBe(1);
  });
});
