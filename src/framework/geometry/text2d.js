// Pure (kernel-free) text layout: an opentype.js font + string → per-glyph curve-
// contour region specs ({outer, holes}, pathProfile contours), positioned + scaled
// so uppercase letters are `size` mm tall, in math (y-up, CCW) coordinates. The
// kernel's text2d maps these to k.shape2d and unions them. No WASM, no DOM.
import { pathProfile } from "./polygon.js";
import { pointInRing } from "./shape2d-regions.js";

const capHeightUnits = (font) =>
  font.tables?.os2?.sCapHeight || font.charToGlyph("H").getBoundingBox().y2 || font.unitsPerEm * 0.7;

// opentype path commands (font units, y-DOWN) → array of pathProfile contours
// (y flipped to math up). Each M starts a new contour; Q elevates to cubic.
function glyphContours(glyph, font) {
  const cmds = glyph.getPath(0, 0, font.unitsPerEm).commands;
  const contours = [];
  let pen = null, cur = null, start = null;
  const P = ([x, y]) => [x, -y];                       // y-down → y-up
  for (const c of cmds) {
    if (c.type === "M") { if (pen) contours.push(pen.close()); start = cur = P([c.x, c.y]); pen = pathProfile(start); }
    else if (c.type === "L") { cur = P([c.x, c.y]); pen.lineTo(cur); }
    else if (c.type === "C") { pen.cubicTo(P([c.x, c.y]), P([c.x1, c.y1]), P([c.x2, c.y2])); cur = P([c.x, c.y]); }
    else if (c.type === "Q") {                          // quadratic → cubic elevation
      const p0 = cur, q = P([c.x1, c.y1]), end = P([c.x, c.y]);
      const c1 = [p0[0] + (2/3)*(q[0]-p0[0]), p0[1] + (2/3)*(q[1]-p0[1])];
      const c2 = [end[0] + (2/3)*(q[0]-end[0]), end[1] + (2/3)*(q[1]-end[1])];
      pen.cubicTo(end, c1, c2); cur = end;
    }
    else if (c.type === "Z") { if (pen) { contours.push(pen.close()); pen = null; } }
  }
  if (pen) contours.push(pen.close());
  return contours;
}

// Coarse-flatten a pathProfile contour to a ring for containment testing only.
function flatten(contour) {
  const ring = [contour.start.slice()];
  for (const s of contour.segments) ring.push(s.to.slice());   // controls omitted — endpoints suffice for inside/outside
  return ring;
}

// Group a glyph's contours into {outer, holes} by even-odd containment depth
// (font winding is unreliable). Returns region specs referencing the ORIGINAL
// curve contours.
function groupContours(contours) {
  const rings = contours.map(flatten);
  const depth = rings.map((r, i) =>
    rings.reduce((n, o, j) => (i !== j && pointInRing(r[0], o) ? n + 1 : n), 0));
  const regions = [];
  contours.forEach((c, i) => { if (depth[i] % 2 === 0) regions.push({ outer: c, holes: [], _i: i }); });
  contours.forEach((c, i) => {
    if (depth[i] % 2 === 1) {                            // hole → nearest containing outer
      const home = regions.find((rg) => pointInRing(rings[i][0], rings[rg._i]));
      (home ?? regions[0])?.holes.push(c);
    }
  });
  return regions.map(({ outer, holes }) => ({ outer, holes }));
}

// Translate a pathProfile contour by (dx,dy) and scale by s (about origin, post-translate order: scale then translate).
const xform = (contour, s, dx, dy) => {
  const T = ([x, y]) => [x * s + dx, y * s + dy];
  const out = { start: T(contour.start), segments: contour.segments.map((seg) => {
    const m = { to: T(seg.to) };
    if (seg.via) m.via = T(seg.via);
    if (seg.c1) { m.c1 = T(seg.c1); m.c2 = T(seg.c2); }
    return m;
  }) };
  return out;
};

export function textGlyphs(font, string, { size = 10, align = "center", valign = "middle",
    lineHeight, tracking = 0, kerning = true } = {}) {
  const upm = font.unitsPerEm;
  const s = size / capHeightUnits(font);                        // font units → mm (cap height)
  const lineAdv = (lineHeight ?? (font.ascender - font.descender) / upm * size * 1.0);
  const kern = (a, b) => { if (!kerning || !a || !b) return 0; try { return font.getKerningValue(a, b); } catch { return 0; } };

  const lines = string.split("\n");
  // 1) lay out each line in font-unit x, collect glyph region specs + line width (mm)
  const laid = lines.map((line) => {
    const glyphs = font.stringToGlyphs(line);
    let penX = 0; const specs = [];
    glyphs.forEach((g, i) => {
      if (i > 0) penX += kern(glyphs[i - 1], g);
      for (const region of groupContours(glyphContours(g, font)))
        specs.push({ region, penX });                          // remember this glyph's pen origin (font units)
      penX += g.advanceWidth + (tracking / s);                  // tracking is mm → font units
    });
    return { specs, widthMm: penX * s };
  });

  const totalH = (lines.length - 1) * lineAdv + size;          // block height (mm), caps as the line box
  const blockDy = valign === "top" ? -size : valign === "bottom" ? totalH - size
    : valign === "middle" ? (totalH / 2 - size) : 0;           // "baseline" → 0

  const out = [];
  laid.forEach(({ specs, widthMm }, li) => {
    const alignDx = align === "center" ? -widthMm / 2 : align === "right" ? -widthMm : 0;
    const dy = -li * lineAdv + blockDy;                         // lines stack downward
    for (const { region, penX } of specs) {
      const dx = penX * s + alignDx;
      out.push({ outer: xform(region.outer, s, dx, dy), holes: region.holes.map((h) => xform(h, s, dx, dy)) });
    }
  });
  return out;
}
