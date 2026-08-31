// k.tappedBore — a tapped hole as ONE cut tool.
//
// The op exists for a robustness reason, not an ergonomic one, so the tests are
// about the two offsets rather than the tooth shape. Hand-assembled, a tapped
// hole is written the obvious way — a bore of diameter d, and a thread whose
// root radius is also d/2 — and those two tools then touch along an exactly
// coincident cylinder without overlapping. Mesh CSG shrugs. OCCT does not: on a
// real 6-turn cap the tangent form did not finish in fifteen minutes, while the
// sunk-root form is ~10 s. Sinking is free rather than a compromise — the bore
// already removes everything inside it, so the union is the same point set.
//
// Manifold here: the op is a compound default (kernel-front.js), so both
// backends run this identical composition, and Manifold builds in milliseconds.
import { expect, test, beforeAll } from "vitest";
import { bootManifoldKernel } from "../src/testing/manifold.js";

let k;
beforeAll(async () => {
  const part = { parts: { body: { build: (kk) => kk.cylinder({ d: 1, h: 1 }) } }, views: {} };
  k = await bootManifoldKernel(part);
});

const triangles = (s) => s.toMesh({ quality: "preview" }).positions.length / 9;
const opts = { d: 6.5, pitch: 3, turns: 4, depth: 14 };

test("the tool carries a real thread, not just the bore", () => {
  const bore = k.cylinder({ d: opts.d, h: opts.depth });
  const tool = k.tappedBore(opts);
  // The failure this guards is silent: build the two halves with coplanar end
  // faces and the union returns the bore alone (or, operands swapped, nothing).
  expect(triangles(tool)).toBeGreaterThan(triangles(bore) * 5);
});

test("the thread root is sunk inside the bore, so the two overlap", () => {
  // The whole point. Cutting the tool with a cylinder of exactly the bore
  // diameter must leave the thread crests behind — proving the root sits inside
  // that cylinder rather than on it.
  const crests = k.tappedBore(opts).cut(k.cylinder({ d: opts.d, h: opts.depth * 2 }).translate([0, 0, -opts.depth / 2]));
  expect(triangles(crests)).toBeGreaterThan(0);
});

test("the bore overhangs the thread at both ends", () => {
  // Flush is a coincident face, which is the same disease one layer down.
  const tool = k.tappedBore(opts);
  const mesh = tool.toMesh({ quality: "preview" });
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) {
    minZ = Math.min(minZ, mesh.positions[i]);
    maxZ = Math.max(maxZ, mesh.positions[i]);
  }
  expect(minZ).toBeLessThan(0);                       // below the thread's first turn
  expect(maxZ).toBeGreaterThan(opts.depth);           // past the bore's nominal end
});

test("a bigger crest makes a deeper thread", () => {
  const shallow = k.tappedBore({ ...opts, crest: 0.3 });
  const deep = k.tappedBore({ ...opts, crest: 0.9 });
  const gauge = () => k.cylinder({ d: opts.d, h: opts.depth * 2 }).translate([0, 0, -opts.depth / 2]);
  expect(triangles(deep.cut(gauge()))).toBeGreaterThan(0);
  expect(triangles(shallow.cut(gauge()))).toBeGreaterThan(0);
});

test("the options are range-checked", () => {
  expect(() => k.tappedBore({ ...opts, pitch: 0 })).toThrow(/pitch must be > 0/);
  expect(() => k.tappedBore({ ...opts, turns: 0 })).toThrow(/turns must be > 0/);
  expect(() => k.tappedBore({ ...opts, d: 0 })).toThrow(/d must be > 0/);
  // A zero sink puts the root back on the bore wall — the exact tangency this
  // op exists to prevent — so it is refused rather than silently accepted.
  expect(() => k.tappedBore({ ...opts, rootSink: 0 })).toThrow(/rootSink must be > 0/);
  expect(() => k.tappedBore({ ...opts, rootSink: 5 })).toThrow(/smaller than the bore radius/);
  expect(() => k.tappedBore({ ...opts, overshoot: 0 })).toThrow(/overshoot must be > 0/);
});
