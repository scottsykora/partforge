import { describe, expect, it, test } from "vitest";
import { validateVectorDocument, toInternalDocument, fromInternalRegions, VECTOR_FORMAT, VECTOR_VERSION }
  from "../src/framework/geometry/vector-format.js";
import { profileArea, profileBounds } from "../src/framework/geometry/contour-ops.js";

const doc = (over = {}) => ({
  format: VECTOR_FORMAT,
  version: VECTOR_VERSION,
  units: "mm",
  source: "x.svg",
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  shapes: { body: [{
    outer: { kind: "path", start: [0, 0], segments: [
      { kind: "line", to: [10, 0] },
      { kind: "line", to: [10, 10] },
      { kind: "line", to: [0, 10] },
    ] },
    holes: [],
  }] },
  ...over,
});

const bad = (over, re) => expect(() => validateVectorDocument(doc(over), "emblem")).toThrow(re);

test("a well-formed document validates", () => {
  expect(() => validateVectorDocument(doc(), "emblem")).not.toThrow();
});

test("every message names the svgs key", () => {
  bad({ format: "something-else" }, /"emblem"/);
});

test("a wrong format is refused and names both formats", () => {
  bad({ format: "svg-json" }, /svg-json.*partforge-vector|partforge-vector.*svg-json/s);
});

test("a future version is refused and names both versions", () => {
  bad({ version: 99 }, /99/);
});

test("an unknown segment kind is refused, with the position", () => {
  const d = doc();
  d.shapes.body[0].outer.segments[1] = { kind: "spiral", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/shape "body" region 1.*outer.*segment 2.*spiral/s);
});

test("an arc without `through` is refused and the message says what through is", () => {
  const d = doc();
  d.shapes.body[0].outer.segments[1] = { kind: "arc", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/through/);
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/passes through/);
});

test("a cubic missing c2 is refused", () => {
  const d = doc();
  d.shapes.body[0].outer.segments[1] = { kind: "cubic", to: [1, 1], c1: [0, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/c2/);
});

test("a non-numeric coordinate is refused, with the position", () => {
  const d = doc();
  d.shapes.body[0].outer.segments[0].to = [10, "x"];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/shape "body" region 1.*segment 1/s);
});

test("a contour with a single STRAIGHT segment is refused — it encloses nothing", () => {
  const d = doc();
  d.shapes.body[0].outer.segments = [{ kind: "line", to: [1, 1] }];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/at least two segments|encloses no area/i);
});

test("a contour with no segments at all is refused", () => {
  const d = doc();
  d.shapes.body[0].outer.segments = [];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/too few segments/i);
});

// A half-disc: one ≤180° arc plus the implicit closing chord bounds real area.
// The old "at least two segments" rule was justified by the triangle — true of
// STRAIGHT edges only — and it refused documents this repo's own ingest emits.
test("a contour with a single CURVED segment is accepted (half-disc, lens, petal)", () => {
  const half = doc({ bbox: null });
  delete half.bbox;
  half.shapes.body[0].outer = { kind: "path", start: [-10, 0], segments: [
    { kind: "arc", to: [10, 0], through: [0, 10] },
  ] };
  expect(() => validateVectorDocument(half, "emblem")).not.toThrow();
  const [region] = toInternalDocument(half, "emblem").shapes.get("body").regions;
  expect(Math.abs(profileArea([region]))).toBeCloseTo(Math.PI * 100 / 2, 1);
});

test("a single cubic segment is accepted too", () => {
  const d = doc();
  delete d.bbox;
  d.shapes.body[0].outer = { kind: "path", start: [0, 0], segments: [
    { kind: "cubic", to: [10, 0], c1: [2, 8], c2: [8, 8] },
  ] };
  expect(() => validateVectorDocument(d, "emblem")).not.toThrow();
});

test("no shapes at all is refused", () => {
  bad({ shapes: {} }, /no shapes/i);
});

test("a bbox that disagrees with the geometry is refused", () => {
  bad({ bbox: { minX: 0, minY: 0, maxX: 999, maxY: 10 } }, /bbox/i);
});

// regionsBbox used to walk a FIXED 64-segment tessellation of each curve
// (BBOX_SEGS) rather than computing exact bounds, and a 64-segment sampling
// grid can undershoot a true arc extremum by roughly 1.2e-3 × radius —
// comfortably past BBOX_TOL. This circle is "phase-shifted" specifically to
// expose that: it is three 120°-sweep arcs starting at 10°/130°/250°, so none
// of the four axis-aligned extrema (0°, 90°, 180°, 270° — where a naive
// sampling grid is most likely to land a point) coincide with a segment
// endpoint or `through` point; each one falls strictly inside an arc's span,
// where the OLD sampler had to interpolate across its grid and would
// undershoot far enough to fail this exact check. A hand-authored bbox of
// exactly [-10, 10] on both axes — the mathematically correct tight bounds of
// a radius-10 circle — must validate now that regionsBbox computes exact
// bounds (contour-ops.js's profileBounds, built on paper.js's own analytic
// curve bounds) instead of sampling.
test("a hand-authored exact bbox for a phase-shifted circle validates", () => {
  const d = {
    format: VECTOR_FORMAT,
    version: VECTOR_VERSION,
    units: "artwork",
    source: "circle.svg",
    bbox: { minX: -10, minY: -10, maxX: 10, maxY: 10 },
    shapes: { artwork: [{
      outer: {
        kind: "path",
        start: [9.848078, 1.736482],
        segments: [
          { kind: "arc", to: [-6.427876, 7.660444], through: [3.420201, 9.396926] },
          { kind: "arc", to: [-3.420201, -9.396926], through: [-9.848078, -1.736482] },
          { kind: "arc", to: [9.848078, 1.736482], through: [6.427876, -7.660444] },
        ],
      },
      holes: [],
    }] },
  };
  expect(() => validateVectorDocument(d, "circle")).not.toThrow();
});

test("note is optional and ignored", () => {
  expect(() => validateVectorDocument(doc({ note: "anything at all" }), "emblem")).not.toThrow();
  const d = doc(); delete d.note;
  expect(() => validateVectorDocument(d, "emblem")).not.toThrow();
});

test("toInternalDocument maps kind/through onto the implicit IR", () => {
  const d = doc();
  d.shapes.body[0].outer.segments[1] = { kind: "arc", to: [10, 10], through: [11, 5] };
  d.shapes.body[0].outer.segments[2] = { kind: "cubic", to: [0, 10], c1: [8, 12], c2: [4, 12] };
  // The arc/cubic swap bulges the contour past the base fixture's 10x10 bbox
  // (the arc through [11,5] peaks at exactly x=11 — the via point IS the arc's
  // extremum here, by construction; the cubic's control points pull y to
  // 11.5) — update the header to the actual tight bbox so this test isolates
  // the kind/through mapping instead of tripping the (separately tested)
  // bbox-consistency check.
  d.bbox = { minX: 0, minY: 0, maxX: 11, maxY: 11.5 };
  const [r] = toInternalDocument(d).shapes.get("body").regions;
  expect(r.outer.start).toEqual([0, 0]);
  expect(r.outer.segments[0]).toEqual({ to: [10, 0] });
  expect(r.outer.segments[1]).toEqual({ to: [10, 10], via: [11, 5] });
  expect(r.outer.segments[2]).toEqual({ to: [0, 10], c1: [8, 12], c2: [4, 12] });
});

test("toInternalDocument drops a redundant closing segment equal to start", () => {
  const d = doc();
  d.shapes.body[0].outer.segments.push({ kind: "line", to: [0, 0] });
  const [r] = toInternalDocument(d).shapes.get("body").regions;
  expect(r.outer.segments).toHaveLength(3);
});

test("fromInternalRegions round-trips back through toInternalDocument", () => {
  const regions = [{
    outer: { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 10], via: [11, 5] }, { to: [0, 10], c1: [8, 12], c2: [4, 12] },
    ] },
    holes: [{ start: [3, 3], segments: [{ to: [3, 6] }, { to: [6, 6] }, { to: [6, 3] }] }],
  }];
  const out = fromInternalRegions(regions, { source: "x.svg", units: "mm", shape: "body" });
  expect(out.format).toBe(VECTOR_FORMAT);
  expect(out.version).toBe(VECTOR_VERSION);
  expect(out.units).toBe("mm");
  expect(typeof out.note).toBe("string");
  expect(out.shapes.body[0].outer.segments[1]).toEqual({ kind: "arc", to: [10, 10], through: [11, 5] });
  expect(() => validateVectorDocument(out, "rt")).not.toThrow();
  const back = toInternalDocument(out).shapes.get("body").regions;
  expect(back[0].outer.segments).toEqual(regions[0].outer.segments);
  expect(back[0].holes).toHaveLength(1);
});

test("fromInternalRegions computes the tight bbox including curve extents", () => {
  const regions = [{ outer: { start: [0, 0], segments: [
    { to: [10, 0] }, { to: [10, 10] }, { to: [0, 10] },
  ] }, holes: [] }];
  const out = fromInternalRegions(regions, { source: null });
  expect(out.bbox).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  expect(out.source).toBe(null);
});

test("fromInternalRegions rounds coordinates to 6 decimals", () => {
  const regions = [{ outer: { start: [0, 0], segments: [
    { to: [1 / 3, 0] }, { to: [1, 1] }, { to: [0, 1] },
  ] }, holes: [] }];
  const out = fromInternalRegions(regions, { source: null });
  expect(out.shapes.artwork[0].outer.segments[0].to[0]).toBe(0.333333);
});

const square = (n) => ({
  outer: { kind: "path", start: [0, 0], segments: [
    { kind: "line", to: [n, 0] }, { kind: "line", to: [n, n] }, { kind: "line", to: [0, n] },
  ] },
});
const envelopeDoc = (over = {}) => ({
  format: "partforge-vector", version: 1, units: "mm",
  shapes: { body: [square(10)] }, ...over,
});

describe("envelope", () => {
  it("accepts a document with no bbox and no source", () => {
    const d = toInternalDocument(envelopeDoc(), "plate");
    expect(d.units).toBe("mm");
    expect([...d.shapes.keys()]).toEqual(["body"]);
    expect(d.shapes.get("body").role).toBe("add");
    expect(d.shapes.get("body").regions).toHaveLength(1);
  });

  it("places identically with and without a bbox", () => {
    // "Optional" must mean "recomputed", not "ignored" — an implementation that
    // skipped the geometry when the header was absent would pass every other
    // test here and silently mis-size every authored file.
    const withBox = envelopeDoc({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
    expect(toInternalDocument(withBox, "plate").shapes.get("body"))
      .toEqual(toInternalDocument(envelopeDoc(), "plate").shapes.get("body"));
  });

  it("still validates a bbox when one is present", () => {
    expect(() => validateVectorDocument(envelopeDoc({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }), "plate")).not.toThrow();
    expect(() => validateVectorDocument(envelopeDoc({ bbox: { minX: 0, minY: 0, maxX: 99, maxY: 10 } }), "plate"))
      .toThrow(/disagrees with its geometry \(maxX: header 99, actual 10\)/);
  });

  it("refuses a missing or unknown units", () => {
    const { units, ...noUnits } = envelopeDoc();
    expect(() => validateVectorDocument(noUnits, "plate")).toThrow(/has no valid `units`.*"mm".*"artwork"/s);
    expect(() => validateVectorDocument(envelopeDoc({ units: "inches" }), "plate")).toThrow(/"inches"/);
  });

  it("refuses version below 1 as well as above", () => {
    expect(() => validateVectorDocument(envelopeDoc({ version: 0 }), "plate")).toThrow(/has version 0/);
    expect(() => validateVectorDocument(envelopeDoc({ version: -1 }), "plate")).toThrow(/has version -1/);
    expect(() => validateVectorDocument(envelopeDoc({ version: 2 }), "plate")).toThrow(/has version 2/);
  });

  it("refuses an empty or non-object shapes", () => {
    expect(() => validateVectorDocument(envelopeDoc({ shapes: {} }), "plate")).toThrow(/has no shapes/);
    expect(() => validateVectorDocument(envelopeDoc({ shapes: [] }), "plate")).toThrow(/has no shapes/);
    expect(() => validateVectorDocument(envelopeDoc({ shapes: { body: [] } }), "plate")).toThrow(/shape "body" is empty/);
  });

  it("names the old flat regions array specifically", () => {
    const { shapes, ...old } = envelopeDoc();
    expect(() => validateVectorDocument({ ...old, regions: [square(10)] }, "plate"))
      .toThrow(/has a "regions" array, which this build does not read/);
  });

  it("round-trips through fromInternalRegions", () => {
    const internal = toInternalDocument(envelopeDoc(), "plate");
    const out = fromInternalRegions(internal.shapes.get("body").regions, { units: "mm", shape: "body" });
    expect(out.units).toBe("mm");
    expect(Object.keys(out.shapes)).toEqual(["body"]);
    expect(toInternalDocument(out, "plate").shapes.get("body").regions).toHaveLength(1);
  });
});

const withShape = (contour) => ({
  format: "partforge-vector", version: 1, units: "mm",
  shapes: { s: [{ outer: contour }] },
});
const regions = (contour) => toInternalDocument(withShape(contour), "t").shapes.get("s").regions;

describe("contour kinds", () => {
  it("requires kind on a path", () => {
    expect(() => regions({ start: [0, 0], segments: [{ kind: "line", to: [1, 0] }, { kind: "line", to: [1, 1] }] }))
      .toThrow(/has no "kind"/);
  });

  it("expands a circle to two arcs with the right area and bounds", () => {
    const r = regions({ kind: "circle", center: [3, 4], r: 5 });
    expect(r[0].outer.segments).toHaveLength(2);
    expect(r[0].outer.segments.every((s) => s.via)).toBe(true);
    // profileArea goes through the shared arc->cubic tessellation (arcToCubicSegments,
    // <=90 degrees/piece); a 180 degree arc becomes two quarter-circle beziers, carrying
    // the standard ~0.03% circle-approximation area error other suites already tolerate
    // (e.g. test/contour-ops-queries.test.js's circle-area check uses 0 digits).
    expect(profileArea(r)).toBeCloseTo(Math.PI * 25, 1);
    const { min, max } = profileBounds(r);
    expect(min).toEqual([-2, -1]);
    expect(max).toEqual([8, 9]);
  });

  it("expands a square rect to three line segments", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 4 });
    expect(r[0].outer.segments).toHaveLength(3);
    expect(profileArea(r)).toBeCloseTo(40, 6);
    expect(profileBounds(r).min).toEqual([-5, -2]);
  });

  it("expands a rounded rect and matches the analytic area", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 6, radius: 2 });
    expect(r[0].outer.segments).toHaveLength(8);
    // 10*6 minus four corner squares plus the quarter-discs that replace them.
    // (2 digits, not 3: each 90-degree corner arc carries the same bezier-tessellation
    // area error as the circle test above, just over a quarter of the perimeter.)
    expect(profileArea(r)).toBeCloseTo(60 - 4 * 4 + Math.PI * 4, 2);
  });

  it("omits zero-length edges at the maximum radius", () => {
    const r = regions({ kind: "rect", center: [0, 0], width: 10, height: 10, radius: 5 });
    expect(r[0].outer.segments).toHaveLength(4);
    expect(r[0].outer.segments.every((s) => s.via)).toBe(true);
    // Same bezier-tessellation tolerance as the circle test above — at the maximum
    // radius this rounded rect degenerates to a plain circle.
    expect(profileArea(r)).toBeCloseTo(Math.PI * 25, 1);
  });

  it("refuses a radius past half the shorter side, naming the maximum", () => {
    expect(() => regions({ kind: "rect", center: [0, 0], width: 10, height: 6, radius: 3.5 }))
      .toThrow(/radius 3\.5 exceeds the maximum 3/);
  });

  it("expands a polygon and refuses fewer than three points", () => {
    const r = regions({ kind: "polygon", points: [[0, 0], [4, 0], [4, 3]] });
    expect(r[0].outer.segments).toHaveLength(2);
    expect(profileArea(r)).toBeCloseTo(6, 6);
    expect(() => regions({ kind: "polygon", points: [[0, 0], [4, 0]] })).toThrow(/needs at least 3 points/);
  });

  it("refuses an unknown contour kind, naming the four", () => {
    expect(() => regions({ kind: "blob", center: [0, 0], r: 1 }))
      .toThrow(/kind must be "path", "circle", "rect", or "polygon"/);
  });

  it("matches the hand-written path equivalent of each primitive", () => {
    // Pins the normative expansions in the spec: a primitive is exactly the
    // contour an author would have written out by hand, never an approximation.
    const handRect = { kind: "path", start: [-5, -2], segments: [
      { kind: "line", to: [5, -2] }, { kind: "line", to: [5, 2] }, { kind: "line", to: [-5, 2] },
    ] };
    expect(regions({ kind: "rect", center: [0, 0], width: 10, height: 4 })).toEqual(regions(handRect));

    const handCircle = { kind: "path", start: [5, 0], segments: [
      { kind: "arc", to: [-5, 0], through: [0, 5] }, { kind: "arc", to: [5, 0], through: [0, -5] },
    ] };
    expect(regions({ kind: "circle", center: [0, 0], r: 5 })).toEqual(regions(handCircle));
  });

  it("gives a primitive hole the same geometry as its hand-written path", () => {
    const doc = (hole) => toInternalDocument({
      format: "partforge-vector", version: 1, units: "mm",
      shapes: { s: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 }, holes: [hole] }] },
    }, "t").shapes.get("s").regions;
    const prim = doc({ kind: "circle", center: [0, 0], r: 4 });
    // Same bezier-tessellation tolerance as the other circle-area checks above.
    expect(profileArea(prim)).toBeCloseTo(400 - Math.PI * 16, 1);
  });
});

describe("roles", () => {
  const doc = (shapes) => ({ format: "partforge-vector", version: 1, units: "mm", shapes });
  const body = { role: "add", regions: [{ outer: { kind: "rect", center: [0, 0], width: 20, height: 20 } }] };
  const hole = { role: "subtract", regions: [{ outer: { kind: "circle", center: [0, 0], r: 4 } }] };

  it("defaults a bare region array to the add role", () => {
    const d = toInternalDocument(doc({ s: [{ outer: { kind: "circle", center: [0, 0], r: 3 } }] }), "t");
    expect(d.shapes.get("s").role).toBe("add");
    expect(d.shapes.get("s").regions).toHaveLength(1);
  });

  it("reads an explicit role", () => {
    const d = toInternalDocument(doc({ body, hole }), "t");
    expect(d.shapes.get("body").role).toBe("add");
    expect(d.shapes.get("hole").role).toBe("subtract");
  });

  it("refuses an unknown role", () => {
    expect(() => toInternalDocument(doc({ s: { role: "erase", regions: body.regions } }), "t"))
      .toThrow(/has an unknown `role` "erase".*"add".*"subtract"/s);
  });

  // The default applies when `role` is ABSENT, not when it is present and
  // null (or any other falsy-but-present value) — a silent default here is
  // exactly what "refuse rather than guess" forbids.
  it("refuses an explicit null role instead of silently defaulting it", () => {
    expect(() => toInternalDocument(doc({ s: { role: null, regions: body.regions } }), "t"))
      .toThrow(/has an unknown `role`/);
  });

  it("refuses a file with no add shape", () => {
    expect(() => toInternalDocument(doc({ hole }), "t"))
      .toThrow(/has no shape with role "add"/);
  });
});
