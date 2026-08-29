import { expect, test } from "vitest";
import { validateVectorDocument, toInternalRegions, fromInternalRegions, VECTOR_FORMAT, VECTOR_VERSION }
  from "../src/framework/geometry/vector-format.js";

const doc = (over = {}) => ({
  format: VECTOR_FORMAT,
  version: VECTOR_VERSION,
  source: "x.svg",
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  regions: [{
    outer: { start: [0, 0], segments: [
      { kind: "line", to: [10, 0] },
      { kind: "line", to: [10, 10] },
      { kind: "line", to: [0, 10] },
    ] },
    holes: [],
  }],
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
  d.regions[0].outer.segments[1] = { kind: "spiral", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/region 1.*outer.*segment 2.*spiral/s);
});

test("an arc without `through` is refused and the message says what through is", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "arc", to: [1, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/through/);
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/passes through/);
});

test("a cubic missing c2 is refused", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "cubic", to: [1, 1], c1: [0, 1] };
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/c2/);
});

test("a non-numeric coordinate is refused, with the position", () => {
  const d = doc();
  d.regions[0].outer.segments[0].to = [10, "x"];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/region 1.*segment 1/s);
});

test("a contour with fewer than two segments is refused", () => {
  const d = doc();
  d.regions[0].outer.segments = [{ kind: "line", to: [1, 1] }];
  expect(() => validateVectorDocument(d, "emblem")).toThrow(/at least two segments|too few/i);
});

test("no regions at all is refused", () => {
  bad({ regions: [] }, /no regions|empty/i);
});

test("a bbox that disagrees with the geometry is refused", () => {
  bad({ bbox: { minX: 0, minY: 0, maxX: 999, maxY: 10 } }, /bbox/i);
});

test("note is optional and ignored", () => {
  expect(() => validateVectorDocument(doc({ note: "anything at all" }), "emblem")).not.toThrow();
  const d = doc(); delete d.note;
  expect(() => validateVectorDocument(d, "emblem")).not.toThrow();
});

test("toInternalRegions maps kind/through onto the implicit IR", () => {
  const d = doc();
  d.regions[0].outer.segments[1] = { kind: "arc", to: [10, 10], through: [11, 5] };
  d.regions[0].outer.segments[2] = { kind: "cubic", to: [0, 10], c1: [8, 12], c2: [4, 12] };
  // The arc/cubic swap bulges the contour past the base fixture's 10x10 bbox
  // (arc via [11,5] reaches x≈10.9875; the cubic's control points pull y to
  // 11.5) — update the header to the actual tight bbox so this test isolates
  // the kind/through mapping instead of tripping the (separately tested)
  // bbox-consistency check.
  d.bbox = { minX: 0, minY: 0, maxX: 10.987495, maxY: 11.5 };
  const [r] = toInternalRegions(d);
  expect(r.outer.start).toEqual([0, 0]);
  expect(r.outer.segments[0]).toEqual({ to: [10, 0] });
  expect(r.outer.segments[1]).toEqual({ to: [10, 10], via: [11, 5] });
  expect(r.outer.segments[2]).toEqual({ to: [0, 10], c1: [8, 12], c2: [4, 12] });
});

test("toInternalRegions drops a redundant closing segment equal to start", () => {
  const d = doc();
  d.regions[0].outer.segments.push({ kind: "line", to: [0, 0] });
  const [r] = toInternalRegions(d);
  expect(r.outer.segments).toHaveLength(3);
});

test("fromInternalRegions round-trips back through toInternalRegions", () => {
  const regions = [{
    outer: { start: [0, 0], segments: [
      { to: [10, 0] }, { to: [10, 10], via: [11, 5] }, { to: [0, 10], c1: [8, 12], c2: [4, 12] },
    ] },
    holes: [{ start: [3, 3], segments: [{ to: [3, 6] }, { to: [6, 6] }, { to: [6, 3] }] }],
  }];
  const out = fromInternalRegions(regions, { source: "x.svg" });
  expect(out.format).toBe(VECTOR_FORMAT);
  expect(out.version).toBe(VECTOR_VERSION);
  expect(typeof out.note).toBe("string");
  expect(out.regions[0].outer.segments[1]).toEqual({ kind: "arc", to: [10, 10], through: [11, 5] });
  expect(() => validateVectorDocument(out, "rt")).not.toThrow();
  const back = toInternalRegions(out);
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
  expect(out.regions[0].outer.segments[0].to[0]).toBe(0.333333);
});
