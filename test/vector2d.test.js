import { expect, test, describe, it, beforeAll } from "vitest";
import { placeRegions } from "../src/framework/geometry/vector2d.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { profileBounds } from "../src/framework/geometry/contour-ops.js";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { toInternalDocument } from "../src/framework/geometry/vector-format.js";

// a 20 x 10 box in artwork units
const BOX = [{ outer: { start: [0, 0], segments: [
  { to: [20, 0] }, { to: [20, 10] }, { to: [0, 10] },
] }, holes: [] }];

const bbox = (rs) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rs) for (const [x, y] of tessellateContour(r.outer, 128)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

test("width sizes the tight bbox and preserves aspect", () => {
  const b = bbox(placeRegions(BOX, "artwork", { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect(b.h).toBeCloseTo(20, 4);
});

test("height sizes the other axis", () => {
  const b = bbox(placeRegions(BOX, "artwork", { height: 5 }));
  expect(b.h).toBeCloseTo(5, 4);
  expect(b.w).toBeCloseTo(10, 4);
});

test("fit sizes the longer edge", () => {
  expect(Math.max(...Object.values({ w: bbox(placeRegions(BOX, "artwork", { fit: 30 })).w, h: bbox(placeRegions(BOX, "artwork", { fit: 30 })).h })))
    .toBeCloseTo(30, 4);
});

test("omitting all three size options throws and names them", () => {
  expect(() => placeRegions(BOX, "artwork", {})).toThrow(/width.*height.*fit/s);
});

test("a non-positive size throws", () => {
  expect(() => placeRegions(BOX, "artwork", { width: 0 })).toThrow(/vector2d: /);
  expect(() => placeRegions(BOX, "artwork", { height: -3 })).toThrow(/vector2d: /);
});

test("placement ignores where the artwork sits in its own coordinate space", () => {
  const far = [{ outer: { start: [400, 700], segments: [
    { to: [420, 700] }, { to: [420, 710] }, { to: [400, 710] },
  ] }, holes: [] }];
  const b = bbox(placeRegions(far, "artwork", { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
});

test("default alignment centres on the origin", () => {
  const b = bbox(placeRegions(BOX, "artwork", { width: 20 }));
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
  expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
});

test("align left and valign bottom put those edges on the origin", () => {
  const b = bbox(placeRegions(BOX, "artwork", { width: 20, align: "left", valign: "bottom" }));
  expect(b.minX).toBeCloseTo(0, 6);
  expect(b.minY).toBeCloseTo(0, 6);
});

test("align right and valign top put the far edges on the origin", () => {
  const b = bbox(placeRegions(BOX, "artwork", { width: 20, align: "right", valign: "top" }));
  expect(b.maxX).toBeCloseTo(0, 6);
  expect(b.maxY).toBeCloseTo(0, 6);
});

// An unrecognized align/valign used to fall through both ternaries straight
// to the middle/center case with no error at all — "centre" (the British
// spelling) silently mis-placed the artwork instead of failing loudly. Every
// other option here (scaleFor's width/height/fit) already refuses garbage
// rather than guessing; this closes the one silent-default gap.
test("an unrecognized align throws instead of silently centring", () => {
  expect(() => placeRegions(BOX, "artwork", { width: 20, align: "centre" })).toThrow(/align/);
});

test("an unrecognized valign throws instead of silently centring", () => {
  expect(() => placeRegions(BOX, "artwork", { width: 20, valign: "centre" })).toThrow(/valign/);
});

// `v > 0` alone lets Infinity through — a non-finite size must not silently
// produce Infinity-scaled coordinates. Refuse rather than guess.
test("a non-finite size throws instead of scaling to Infinity", () => {
  expect(() => placeRegions(BOX, "artwork", { width: Infinity })).toThrow(/width must be a positive number/);
});

test("holes are scaled and aligned with their outer", () => {
  const withHole = [{
    outer: BOX[0].outer,
    holes: [{ start: [5, 2], segments: [{ to: [5, 8] }, { to: [15, 8] }, { to: [15, 2] }] }],
  }];
  const [r] = placeRegions(withHole, "artwork", { width: 40, align: "left", valign: "bottom" });
  expect(r.holes).toHaveLength(1);
  expect(r.holes[0].start).toEqual([10, 4]);          // scale 2, origin at the corner
});

test("arcs stay symbolic through placement", () => {
  const arcs = [{ outer: { start: [2, 0], segments: [
    { to: [-2, 0], via: [0, 2] }, { to: [2, 0], via: [0, -2] },
  ] }, holes: [] }];
  const [r] = placeRegions(arcs, "artwork", { width: 8 });
  expect(r.outer.segments.every((s) => s.via)).toBe(true);
  expect(r.outer.segments[0].via).toEqual([0, 4]);
});

// A 20x10 rect whose bottom-left corner sits at (5, 5) — deliberately off-origin,
// so "as authored" is distinguishable from "centred".
const boxAt = () => [{ outer: { start: [5, 5], segments: [
  { to: [25, 5] }, { to: [25, 15] }, { to: [5, 15] },
] }, holes: [] }];

describe("placement", () => {
  it("mm with no size is the identity", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", {}));
    expect(min).toEqual([5, 5]);
    expect(max).toEqual([25, 15]);
  });

  it("mm with a width scales about the origin, not the bbox centre", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", { width: 40 }));
    expect(min).toEqual([10, 10]);
    expect(max).toEqual([50, 30]);
  });

  it("mm still honours an explicit align", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "mm", { align: "center", valign: "middle" }));
    expect(min).toEqual([-10, -5]);
    expect(max).toEqual([10, 5]);
  });

  it("artwork centres by default, as before", () => {
    const { min, max } = profileBounds(placeRegions(boxAt(), "artwork", { width: 20 }));
    expect(min).toEqual([-10, -5]);
    expect(max).toEqual([10, 5]);
  });

  it("artwork still requires a size", () => {
    expect(() => placeRegions(boxAt(), "artwork", {})).toThrow(/a size is required/);
  });

  it("refuses more than one size option in either mode", () => {
    expect(() => placeRegions(boxAt(), "mm", { width: 10, fit: 10 })).toThrow(/only one of width, height, or fit — got width, fit/);
    expect(() => placeRegions(boxAt(), "artwork", { width: 10, height: 10 })).toThrow(/only one of width, height, or fit/);
  });

  it("still refuses an unrecognized align or valign", () => {
    expect(() => placeRegions(boxAt(), "mm", { align: "centre" })).toThrow(/align must be/);
    expect(() => placeRegions(boxAt(), "mm", { valign: "centre" })).toThrow(/valign must be/);
  });
});

const TWO_SHAPE = {
  format: "partforge-vector", version: 1, units: "mm",
  shapes: {
    body:  [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }],
    holes: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }],
  },
};

describe("shape selection", () => {
  let k;
  beforeAll(async () => {
    k = await bootManifoldKernel();
    k._vectors.set("plate", toInternalDocument(TWO_SHAPE, "plate"));
  });

  it("unions every shape by default", () => {
    expect(k.vector2d("plate").area()).toBeCloseTo(400, 2);   // circle is inside the rect
  });

  it("selects one shape by name", () => {
    // Precision 1 (not 2): a circle contour is symbolic arcs until this boolean
    // meshes it at preview quality (116 segs), which biases area by ~1e-2 for
    // r=4 — a pre-existing property of the mesh backend, not of shape selection.
    expect(k.vector2d("plate", { shape: "holes" }).area()).toBeCloseTo(Math.PI * 16, 1);
  });

  it("composes shapes with ordinary booleans, in the drawing's own frame", () => {
    const cut = k.vector2d("plate", { shape: "body" }).cut(k.vector2d("plate", { shape: "holes" }));
    expect(cut.area()).toBeCloseTo(400 - Math.PI * 16, 1);
  });

  it("names the available shapes when one is unknown", () => {
    expect(() => k.vector2d("plate", { shape: "rim" }))
      .toThrow(/"plate" has no shape "rim" — it declares: body, holes/);
  });
});

const ROLE_DOC = {
  format: "partforge-vector", version: 1, units: "mm",
  shapes: {
    body:  { role: "add", regions: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }] },
    holes: { role: "subtract", regions: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }] },
  },
};

describe("roles compose", () => {
  let k;
  beforeAll(async () => {
    k = await bootManifoldKernel();
    k._vectors.set("roled", toInternalDocument(ROLE_DOC, "roled"));
  });

  it("subtracts by default instead of unioning", () => {
    expect(k.vector2d("roled").area()).toBeCloseTo(400 - Math.PI * 16, 1);
  });

  it("still hands back a subtract shape when it is named explicitly", () => {
    expect(k.vector2d("roled", { shape: "holes" }).area()).toBeCloseTo(Math.PI * 16, 1);
  });
});

// The add group is 20 x 20 and the subtract circle only 8 x 8. Deriving each
// group's transform from its OWN bounds — which the composed path used to do,
// because it calls placeRegions once per group — scales the hole 5x while the
// body scales 2x, and the hole then swallows the plate. Nothing throws and the
// composed bbox is still exactly the requested size, because the add group
// governs it, so only the AREA catches this.
describe("a size or align option places a composed document on ONE transform", () => {
  let k;
  beforeAll(async () => {
    k = await bootManifoldKernel();
    k._vectors.set("roled", toInternalDocument(ROLE_DOC, "roled"));
  });

  it("scales a composed result by exactly the linear factor squared", () => {
    // 20 -> 40 is 2x linear, so 4x area. Measuring per group would give
    // 1600 - pi*20^2 = 343, not 4 * (400 - pi*16) = 1399.
    expect(k.vector2d("roled", { width: 40 }).area())
      .toBeCloseTo(k.vector2d("roled").area() * 4, 1);
  });

  it("still sizes the composed result to the requested width", () => {
    const b = k.vector2d("roled", { width: 40 }).boundingBox();
    expect(b.max[0] - b.min[0]).toBeCloseTo(40, 6);
  });

  it("aligns both groups together, so the hole keeps its place in the drawing", () => {
    // align "left" shifts the whole document by +10 (its minX is -10), carrying
    // the centred hole to x=10. Measuring the hole group alone would shift it by
    // +4 instead, leaving it at x=4 — a hole that moved relative to its plate.
    const s = k.vector2d("roled", { align: "left" });
    expect(s.contains([10, 0])).toBe(false);   // inside the hole
    expect(s.contains([4, 0])).toBe(true);     // solid plate, where the bug put the hole
  });

  it("still sizes a single named shape against its own bounds", () => {
    // { shape } is a request for THAT geometry: nothing else is in the frame.
    const b = k.vector2d("roled", { shape: "holes", width: 40 }).boundingBox();
    expect(b.max[0] - b.min[0]).toBeCloseTo(40, 1);
  });
});
