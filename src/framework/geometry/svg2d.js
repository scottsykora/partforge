// Place ingested vector regions: one uniform scale to the requested millimetre
// size, then an alignment translate. That is the entire runtime half of
// k.svg2d — everything else happened once, at ingest.
//
// The transform is uniform by construction, so arcs stay arcs and the OCCT
// backend still gets true circular B-rep edges.
//
// Pure leaf: DOM-free, node:-free.
import { regionsBbox } from "./vector-format.js";

const EXTENT_EPS = 1e-9;
const ALIGN = new Set(["left", "center", "right"]);
const VALIGN = new Set(["bottom", "middle", "top"]);

function scaleFor({ width, height, fit }, w, h) {
  const need = (extent, label) => {
    if (!(extent > EXTENT_EPS)) throw new Error(`svg2d: artwork has no ${label} to size against`);
  };
  const positive = (v, name) => {
    if (!(v > 0)) throw new Error(`svg2d: ${name} must be a positive number of millimetres`);
  };
  if (width != null) { positive(width, "width"); need(w, "width"); return width / w; }
  if (height != null) { positive(height, "height"); need(h, "height"); return height / h; }
  if (fit != null) { positive(fit, "fit"); need(Math.max(w, h), "extent"); return fit / Math.max(w, h); }
  // No honest default exists: an artwork's units have no physical meaning, unlike
  // a font's cap height — which is why k.text2d can default `size` and this cannot.
  throw new Error("svg2d: a size is required — pass one of { width }, { height }, or { fit } in millimetres");
}

const place = (c, s, dx, dy) => {
  const T = ([x, y]) => [x * s + dx, y * s + dy];
  return {
    start: T(c.start),
    segments: c.segments.map((seg) => {
      const m = { to: T(seg.to) };
      if (seg.via) m.via = T(seg.via);
      if (seg.c1) { m.c1 = T(seg.c1); m.c2 = T(seg.c2); }
      return m;
    }),
  };
};

export function placeRegions(regions, opts = {}) {
  const { align = "center", valign = "middle" } = opts;
  // No silent default for a bad value: align/valign each pick their branch by
  // string equality below, and any value that fails all three comparisons
  // (a typo — "centre" for "center" — or any other garbage) would otherwise
  // fall through to the middle/center case with no error, placing the artwork
  // somewhere the caller never asked for. Every other op in this feature
  // refuses instead of guessing (scaleFor above, right on this same function);
  // this closes the one silent-default gap.
  if (!ALIGN.has(align)) throw new Error(`svg2d: align must be "left", "center", or "right" — got ${JSON.stringify(align)}`);
  if (!VALIGN.has(valign)) throw new Error(`svg2d: valign must be "bottom", "middle", or "top" — got ${JSON.stringify(valign)}`);
  const { minX, minY, maxX, maxY } = regionsBbox(regions);
  const s = scaleFor(opts, maxX - minX, maxY - minY);
  const dx = align === "left" ? -minX * s : align === "right" ? -maxX * s : -((minX + maxX) / 2) * s;
  const dy = valign === "bottom" ? -minY * s : valign === "top" ? -maxY * s : -((minY + maxY) / 2) * s;
  return regions.map((r) => ({
    outer: place(r.outer, s, dx, dy),
    holes: r.holes.map((c) => place(c, s, dx, dy)),
  }));
}
