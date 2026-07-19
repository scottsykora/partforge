import { describe, it, expect, beforeAll } from "vitest";
import Module from "manifold-3d";
import opentype from "opentype.js";
import { DEFAULT_FONT_BYTES } from "../src/framework/geometry/fonts/default-font.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { resolveCurveFill } from "../src/framework/geometry/curve-fill.js";

// Build a glyph's raw cubic contours (y-up), mirroring text2d's glyph reader.
function glyphContours(font, ch) {
  const cmds = font.charToGlyph(ch).getPath(0, 0, font.unitsPerEm).commands;
  const cs = []; let pen = null, cur = null; const P = ([x, y]) => [x, -y];
  for (const c of cmds) {
    if (c.type === "M") { if (pen) cs.push(pen.close()); cur = P([c.x, c.y]); pen = pathProfile(cur); }
    else if (c.type === "L") { cur = P([c.x, c.y]); pen.lineTo(cur); }
    else if (c.type === "C") { pen.cubicTo(P([c.x, c.y]), P([c.x1, c.y1]), P([c.x2, c.y2])); cur = P([c.x, c.y]); }
    else if (c.type === "Q") { const p0 = cur, q = P([c.x1, c.y1]), e = P([c.x, c.y]);
      pen.cubicTo(e, [p0[0] + 2/3*(q[0]-p0[0]), p0[1] + 2/3*(q[1]-p0[1])], [e[0] + 2/3*(q[0]-e[0]), e[1] + 2/3*(q[1]-e[1])]); cur = e; }
    else if (c.type === "Z") { if (pen) { cs.push(pen.close()); pen = null; } }
  }
  if (pen) cs.push(pen.close());
  return cs;
}

let font, wasm, CrossSection;
beforeAll(async () => {
  const { buffer, byteOffset, byteLength } = DEFAULT_FONT_BYTES;
  font = opentype.parse(buffer.slice(byteOffset, byteOffset + byteLength));
  wasm = await Module(); wasm.setup(); CrossSection = wasm.CrossSection;
});

// Reconstruct exactly what k.text2d does: each {outer,holes} region goes through
// k.shape2d's EvenOdd region semantics, then all regions are unioned.
function resolvedArea(regions) {
  const parts = regions.map((r) => CrossSection.ofPolygons(
    [r.outer, ...r.holes].map((c) => tessellateContour(c, 120)), "EvenOdd"));
  if (parts.length === 0) return 0;
  let acc = parts[0];
  for (const part of parts.slice(1)) {
    const next = acc.add(part); acc.delete?.(); part.delete?.(); acc = next;
  }
  const a = acc.area(); acc.delete?.(); return a;
}
function oracleArea(contours, fillRule = "nonzero") {
  const cs = CrossSection.ofPolygons(
    contours.map((c) => tessellateContour(c, 300)),
    fillRule === "nonzero" ? "NonZero" : "EvenOdd");
  const a = cs.area(); cs.delete?.(); return a;
}

describe("resolveCurveFill", () => {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&%@#!?.,-+=$".split("");
  it("matches the Manifold NonZero fill for the bundled TrueType charset", () => {
    for (const ch of CHARS) {
      const contours = glyphContours(font, ch);
      const got = resolvedArea(resolveCurveFill(contours, { fillRule: "nonzero" }));
      const want = oracleArea(contours, "nonzero");
      expect(Math.abs(got - want) / want, `glyph '${ch}'`).toBeLessThan(0.01);
    }
  });

  it("resolves B into one outer with two counters (holes), curves preserved", () => {
    const regions = resolveCurveFill(glyphContours(font, "B"), { fillRule: "nonzero" });
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(2);
    const hasCubic = [regions[0].outer, ...regions[0].holes].some((c) => c.segments.some((s) => s.c1));
    expect(hasCubic).toBe(true);
  });

  it("resolves i into two disjoint filled regions (dot + stem), no holes", () => {
    const regions = resolveCurveFill(glyphContours(font, "i"), { fillRule: "nonzero" });
    expect(regions.length).toBe(2);
    expect(regions.every((r) => r.holes.length === 0)).toBe(true);
  });

  it("distinguishes nonzero from even-odd for same-winding nested contours", () => {
    const rect = (x0, y0, x1, y1) => pathProfile([x0, y0])
      .lineTo([x1, y0]).lineTo([x1, y1]).lineTo([x0, y1]).close();
    const sameWinding = [rect(0, 0, 10, 10), rect(2, 2, 8, 8)];
    expect(resolveCurveFill(sameWinding, { fillRule: "nonzero" })[0].holes).toHaveLength(0);
    expect(resolveCurveFill(sameWinding, { fillRule: "evenodd" })[0].holes).toHaveLength(1);
  });

  it("groups by actual cubic geometry, not the endpoint polygon", () => {
    // Each oval has only two distinct endpoints, so its endpoint polygon has zero area.
    const oval = (r, reverse = false) => ({
      start: [0, -r],
      segments: reverse
        ? [
            { to: [0, r], c1: [-4*r/3, -r], c2: [-4*r/3, r] },
            { to: [0, -r], c1: [4*r/3, r], c2: [4*r/3, -r] },
          ]
        : [
            { to: [0, r], c1: [4*r/3, -r], c2: [4*r/3, r] },
            { to: [0, -r], c1: [-4*r/3, r], c2: [-4*r/3, -r] },
          ],
    });
    const regions = resolveCurveFill([oval(10), oval(4, true)], { fillRule: "nonzero" });
    expect(regions).toHaveLength(1);
    expect(regions[0].holes).toHaveLength(1);
  });

  it("rejects an unknown fill rule", () => {
    expect(() => resolveCurveFill(glyphContours(font, "O"), { fillRule: "wut" }))
      .toThrow(/fillRule/);
  });

  it("returns [] for empty input and is deterministic across repeated calls", () => {
    expect(resolveCurveFill([], { fillRule: "nonzero" })).toEqual([]);
    const a = resolvedArea(resolveCurveFill(glyphContours(font, "O"), { fillRule: "nonzero" }));
    const b = resolvedArea(resolveCurveFill(glyphContours(font, "O"), { fillRule: "nonzero" }));
    expect(a).toBeCloseTo(b, 3);
  });
});
