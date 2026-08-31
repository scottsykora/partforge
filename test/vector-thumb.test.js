// @vitest-environment happy-dom
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { vectorThumb } from "../src/framework/panel/widgets/vector-thumb.js";

// A minimal internal-form document: y-up model coordinates, one square region.
const square = {
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  shapes: {
    art: [{
      outer: { kind: "path", start: [0, 0], segments: [
        { kind: "line", to: [10, 0] }, { kind: "line", to: [10, 10] }, { kind: "line", to: [0, 10] },
      ] },
      holes: [],
    }],
  },
};

const withHole = {
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  shapes: {
    art: [{
      outer: square.shapes.art[0].outer,
      holes: [{ kind: "path", start: [3, 3], segments: [
        { kind: "line", to: [7, 3] }, { kind: "line", to: [7, 7] }, { kind: "line", to: [3, 7] },
      ] }],
    }],
  },
};

describe("vectorThumb", () => {
  test("renders an <svg> with a viewBox derived from the document bbox", () => {
    const svg = vectorThumb(square);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    const [x, y, w, h] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    expect(w).toBe(10);
    expect(h).toBe(10);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  test("emits one path per region", () => {
    expect(vectorThumb(square).querySelectorAll("path").length).toBe(1);
  });

  test("flips Y — the model's y-up becomes SVG's y-down", () => {
    // The model square spans y 0..10. After the flip the SVG y coordinates must
    // be the negation, so the point at model y=10 is ABOVE the one at y=0.
    const d = vectorThumb(square).querySelector("path").getAttribute("d");
    const ys = [...d.matchAll(/-?[\d.]+\s+(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBe(-10);
    expect(Math.max(...ys)).toBe(0);
  });

  test("a hole is cut, not painted — same path, evenodd fill rule", () => {
    const svg = vectorThumb(withHole);
    const paths = svg.querySelectorAll("path");
    expect(paths.length).toBe(1);
    expect(paths[0].getAttribute("fill-rule")).toBe("evenodd");
    // outer subpath + hole subpath = two "M" commands in one path
    expect((paths[0].getAttribute("d").match(/M/g) ?? []).length).toBe(2);
  });

  test("expands rect sugar without needing the geometry's expander", () => {
    const doc = { bbox: { minX: -5, minY: -2, maxX: 5, maxY: 2 },
      shapes: { art: [{ outer: { kind: "rect", center: [0, 0], width: 10, height: 4 }, holes: [] }] } };
    expect(vectorThumb(doc).querySelectorAll("path, rect").length).toBe(1);
  });

  test("expands circle sugar", () => {
    const doc = { bbox: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
      shapes: { art: [{ outer: { kind: "circle", center: [0, 0], r: 5 }, holes: [] }] } };
    expect(vectorThumb(doc).querySelectorAll("path, circle").length).toBe(1);
  });

  test("expands polygon sugar", () => {
    const doc = { bbox: { minX: 0, minY: 0, maxX: 4, maxY: 4 },
      shapes: { art: [{ outer: { kind: "polygon", points: [[0, 0], [4, 0], [2, 4]] }, holes: [] }] } };
    expect(vectorThumb(doc).querySelectorAll("path, polygon").length).toBe(1);
  });

  test("tessellates curves rather than emitting an SVG arc command", () => {
    // The format's arc is a point ON the arc ({to, through}); SVG's A takes radii
    // and flags. Tessellating avoids a second, divergent interpretation.
    const doc = { bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: { art: [{ outer: { kind: "path", start: [0, 0], segments: [
        { kind: "arc", to: [10, 10], via: [10, 0] }, { kind: "line", to: [0, 0] },
      ] }, holes: [] }] } };
    const d = vectorThumb(doc).querySelector("path").getAttribute("d");
    expect(d).not.toMatch(/[Aa]/);
    expect((d.match(/L/g) ?? []).length).toBeGreaterThan(3);
  });

  test("tessellates an arc written the way a FILE writes it — `through`, not `via`", () => {
    // The external format names the arc point `through`; the internal contour IR
    // names it `via`, and tessellateContour reads `via`. A document straight off
    // disk or out of ingestSvg therefore uses `through`, and treating it as a
    // line silently turns every curve into a chord. The test above uses `via`,
    // which is why it could not catch this.
    const doc = { bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: { art: [{ outer: { kind: "path", start: [0, 0], segments: [
        { kind: "arc", to: [10, 10], through: [10, 0] }, { kind: "line", to: [0, 0] },
      ] }, holes: [] }] } };
    const d = vectorThumb(doc).querySelector("path").getAttribute("d");
    expect((d.match(/L/g) ?? []).length, "an arc must become many segments, not one chord").toBeGreaterThan(3);
  });

  test("returns null for a document with no renderable geometry", () => {
    expect(vectorThumb({ bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, shapes: {} })).toBe(null);
    expect(vectorThumb(null)).toBe(null);
    expect(vectorThumb({})).toBe(null);
  });

  test("refuses a non-finite coordinate rather than emitting NaN path data", () => {
    const doc = { bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      shapes: { art: [{ outer: { kind: "path", start: [0, NaN], segments: [
        { kind: "line", to: [10, 0] }, { kind: "line", to: [10, 10] },
      ] }, holes: [] }] } };
    expect(vectorThumb(doc)).toBe(null);
  });

  // The fixtures above are hand-written, so they can only ever agree with the
  // implementation. These two are the artwork the repo actually ships — an
  // INGESTED document (paths, an explicit bbox) and an AUTHORED one (rect/circle/
  // polygon sugar, `{role, regions}` shapes, and NO bbox at all). Both forms were
  // missed by the invented fixtures and each broke the first implementation.
  test("renders the ingested emblem artwork", () => {
    const doc = JSON.parse(readFileSync("src/parts/assets/emblem.vector.json", "utf8"));
    const svg = vectorThumb(doc);
    expect(svg, "emblem should render").toBeTruthy();
    expect(svg.querySelector("path").getAttribute("d")).not.toMatch(/NaN|undefined|Infinity/);
    // emblem.svg is a filled CIRCLE plus a stroked bar. A circle reduced to a few
    // straight chords is what a missed `through` looks like, and it renders as a
    // triangle — visible in the panel, invisible to a "does not contain NaN" check.
    const pts = (svg.querySelector("path").getAttribute("d").match(/L/g) ?? []).length;
    expect(pts, "the circle must be tessellated, not chorded").toBeGreaterThan(20);
  });

  test("renders the authored plate artwork — sugar kinds, {role, regions}, and no bbox", () => {
    const doc = JSON.parse(readFileSync("src/parts/assets/plate.vector.json", "utf8"));
    expect(doc.bbox, "fixture premise: this document has no bbox").toBeUndefined();
    const svg = vectorThumb(doc);
    expect(svg, "authored artwork should render without a declared bbox").toBeTruthy();
    const [, , w, h] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    expect(svg.querySelector("path").getAttribute("d")).not.toMatch(/NaN|undefined|Infinity/);
  });

  test("a subtract shape cuts rather than paints", () => {
    // plate.vector.json's `holes` shape has role "subtract". Every region lands
    // in one evenodd path, so those holes must appear as additional subpaths.
    const doc = JSON.parse(readFileSync("src/parts/assets/plate.vector.json", "utf8"));
    const d = vectorThumb(doc).querySelector("path").getAttribute("d");
    expect((d.match(/M/g) ?? []).length).toBeGreaterThan(1);
  });
});
