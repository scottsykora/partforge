// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { ingestSvg } from "../src/framework/ingest/svg-ingest.js";
import { toInternalRegions } from "../src/framework/geometry/vector-format.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const svg = (body, attrs = 'viewBox="0 0 48 48"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const netArea = (doc) => toInternalRegions(doc).reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

test("a filled rect ingests to a valid document with the right bbox and area", () => {
  const doc = ingestSvg(svg('<rect x="4" y="6" width="20" height="10" fill="#111"/>'), { source: "r.svg" });
  expect(doc.format).toBe("partforge-vector");
  expect(doc.source).toBe("r.svg");
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.maxY - doc.bbox.minY).toBeCloseTo(10, 3);
  expect(netArea(doc)).toBeCloseTo(200, 1);
});

test("y is flipped from SVG's y-down to model y-up", () => {
  // a wide bar at SVG y=0 (the top) and a small square at SVG y=40 (the bottom)
  const doc = ingestSvg(svg('<rect x="0" y="0" width="40" height="4" fill="#111"/><rect x="0" y="40" width="4" height="4" fill="#111"/>'));
  const regions = toInternalRegions(doc);
  const widest = regions.map((r) => tessellateContour(r.outer, 8))
    .map((pts) => ({ w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
                     top: Math.max(...pts.map((p) => p[1])) }))
    .sort((a, b) => b.w - a.w)[0];
  expect(widest.top).toBeCloseTo(doc.bbox.maxY, 3);   // the wide bar is the HIGH one
});

test("ancestor transforms are baked in", () => {
  const doc = ingestSvg(svg('<g transform="translate(2 0) scale(2)"><rect width="10" height="10" fill="#111"/></g>'));
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(20, 3);
  expect(doc.bbox.minX).toBeCloseTo(2, 3);
});

test("fill=none with a stroke yields the stroke outline only", () => {
  const doc = ingestSvg(svg('<path fill="none" stroke="#111" stroke-width="2" stroke-linecap="butt" d="M0,0 L10,0"/>'));
  expect(netArea(doc)).toBeCloseTo(20, 1);
});

test("strokes:'ignore' drops stroke geometry", () => {
  const body = '<rect width="10" height="10" fill="#111" stroke="#111" stroke-width="4"/>';
  expect(netArea(ingestSvg(svg(body), { strokes: "ignore" }))).toBeCloseTo(100, 1);
  expect(netArea(ingestSvg(svg(body)))).toBeGreaterThan(100);
});

test("evenodd makes a hole where nonzero does not", () => {
  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`)))).toBeCloseTo(800, 1);
  expect(netArea(ingestSvg(svg(`<path fill="#111" fill-rule="nonzero" d="${d}"/>`)))).toBeCloseTo(900, 1);
});

test("overlapping filled shapes union rather than double-count", () => {
  const doc = ingestSvg(svg('<rect width="10" height="10" fill="#111"/><rect x="5" width="10" height="10" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(150, 1);
});

// KNOWN DEFECT — pins the current WRONG answer, not desired behaviour.
//
// The same two overlapping squares as the test above, but as two subpaths of
// ONE <path> element instead of two separate elements. resolveCurveFill
// (src/framework/geometry/curve-fill.js) is what ingest calls per-ITEM to
// resolve an element's own subpaths under its fill rule, and it drops the
// overlap between two same-winding subpaths instead of merging them — so this
// comes back as area 100 / bbox width 10 (the *first* subpath alone) instead
// of the true union, area 150 / bbox width 15, that the two-element version
// above correctly produces via booleanRegions. Because k.svg2d sizes on the
// bbox, this silently scales the whole artwork wrong with no error — see
// docs/ERROR-PATTERNS.md's svg-overlapping-subpaths entry. Fixing
// resolveCurveFill itself is a separate task (nonzero winding legitimately
// forms holes, so subpaths can't simply be unioned locally); this test only
// records the defect so a fix there is caught by a red test, not silence.
test("KNOWN DEFECT: overlapping same-winding subpaths within one <path> lose their union", () => {
  const d = "M0,0 L10,0 L10,10 L0,10 Z M5,0 L15,0 L15,10 L5,10 Z";
  const doc = ingestSvg(svg(`<path fill="#111" d="${d}"/>`));
  expect(netArea(doc)).toBeCloseTo(100, 1);                    // WRONG — truth is 150
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(10, 1);     // WRONG — truth is 15
});

test("a circle survives as symbolic arcs, not cubics", () => {
  const doc = ingestSvg(svg('<circle cx="24" cy="24" r="10" fill="#111"/>'));
  const [region] = toInternalRegions(doc);
  expect(region.outer.segments.every((s) => s.via)).toBe(true);
  expect(netArea(doc)).toBeCloseTo(Math.PI * 100, 0);
});

test("<use> and <defs> resolve — the capability this architecture bought (bare href)", () => {
  const doc = ingestSvg(svg(
    '<defs><rect id="r" width="10" height="10"/></defs>'
    + '<use href="#r" fill="#111"/><use href="#r" x="20" fill="#111"/>'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("<use> and <defs> resolve with the legacy xlink:href spelling too", () => {
  const doc = ingestSvg(svg(
    '<defs><rect id="r" width="10" height="10"/></defs>'
    + '<use xlink:href="#r" fill="#111"/><use xlink:href="#r" x="20" fill="#111"/>',
    'viewBox="0 0 48 48" xmlns:xlink="http://www.w3.org/1999/xlink"'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("<symbol> + <use> resolves", () => {
  const doc = ingestSvg(svg(
    '<symbol id="s"><rect width="10" height="10" fill="#111"/></symbol>'
    + '<use href="#s"/><use href="#s" x="20"/>'));
  expect(netArea(doc)).toBeCloseTo(200, 1);
  expect(doc.bbox.maxX - doc.bbox.minX).toBeCloseTo(30, 1);
});

test("a CSS class in a <style> block resolves", () => {
  const doc = ingestSvg(svg('<style>.a { fill: #111; }</style><rect class="a" width="10" height="10"/>'));
  expect(netArea(doc)).toBeCloseTo(100, 1);
});

test("an SVG with no painted geometry throws", () => {
  expect(() => ingestSvg(svg('<rect width="10" height="10" fill="none"/>'))).toThrow(/svg: /);
});

test("the emitted document always validates", () => {
  const doc = ingestSvg(svg('<circle cx="10" cy="10" r="5" fill="#111"/><path fill="none" stroke="#111" stroke-width="2" d="M0,30 L40,30"/>'));
  expect(() => toInternalRegions(doc, "x")).not.toThrow();
});

test("emitted regions carry the storage winding invariant: outer CCW, holes CW", () => {
  const signed = (c) => ringArea(tessellateContour(c, 64));

  const rect = toInternalRegions(ingestSvg(svg('<rect width="20" height="10" fill="#111"/>')));
  expect(signed(rect[0].outer)).toBeGreaterThan(0);

  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  const [donut] = toInternalRegions(ingestSvg(svg(`<path fill="#111" fill-rule="evenodd" d="${d}"/>`)));
  expect(signed(donut.outer)).toBeGreaterThan(0);
  expect(signed(donut.holes[0])).toBeLessThan(0);
});
