// test/boolean-hoist-kernel.test.js — transform hoisting through the real Manifold
// kernel. A repeated sub-assembly placed at many positions must evaluate its boolean
// ONCE and reuse it, and the reused copies must be geometrically identical to
// building each one in place.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

// a two-solid "cell" whose pieces end at DIFFERENT z, so exact suffix matching alone
// would hoist nothing — this is the reported part's hub/support shape.
const cell = (x, y) => k.union([
  k.cylinder({ r: 3, h: 4 }).at([x, y, 0]).label("hub"),
  k.box({ size: [8, 2, 3], center: true }).at([x, y, 2]).label("rib"),
]);

test("a repeated cell at a new position costs no new evaluation", () => {
  k.beginSubPart("repeat");
  try {
    cell(0, 0)._m.numTri();          // build the first one, warming the cache
    k.resetCacheStats();
    cell(20, 0)._m.numTri();         // same geometry, elsewhere
    cell(40, 15)._m.numTri();
    expect(k.cacheStats().misses).toBe(0);
  } finally { k.endSubPart(); }
});

test("a hoisted copy is the same solid, exactly translated", () => {
  k.beginSubPart("geom");
  try {
    const a = cell(0, 0)._m, b = cell(20, 0)._m;
    expect(b.volume()).toBeCloseTo(a.volume(), 9);
    expect(b.genus()).toBe(a.genus());
    expect(b.numTri()).toBe(a.numTri());
    const pa = a.boundingBox(), pb = b.boundingBox();
    expect(pb.min[0] - pa.min[0]).toBeCloseTo(20, 9);
    expect(pb.min[1]).toBeCloseTo(pa.min[1], 9);
    expect(pb.min[2]).toBeCloseTo(pa.min[2], 9);
  } finally { k.endSubPart(); }
});

test("a polar copy costs no new evaluation either", () => {
  // every piece ends with the same .rotateZ — the bolt-circle / gear-tooth idiom
  const boss = (ang) => k.union([
    k.cylinder({ r: 3, h: 4 }).at([40, 0, 0]).rotateZ(ang).label("pad"),
    k.box({ size: [8, 2, 3], center: true }).at([40, 0, 2]).rotateZ(ang).label("rib"),
  ]);
  k.beginSubPart("polar");
  try {
    boss(0)._m.numTri();
    k.resetCacheStats();
    boss(30)._m.numTri();
    boss(60)._m.numTri();
    expect(k.cacheStats().misses).toBe(0);
  } finally { k.endSubPart(); }
});
