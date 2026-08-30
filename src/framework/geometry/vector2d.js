// Place ingested vector regions: one uniform scale about the document origin,
// then an alignment translate. That is the entire runtime half of k.vector2d —
// everything else happened once, at ingest.
//
// Both steps default to no-ops for millimetre files: an mm file's coordinates
// already mean something, so "as authored" (scale 1, no translate) is the
// identity. Artwork units carry no physical meaning, so a size is required and
// the artwork is re-centred by default — that half is unchanged from before
// units existed at all.
//
// The transform is uniform by construction, so arcs stay arcs and the OCCT
// backend still gets true circular B-rep edges.
//
// Pure leaf: DOM-free, node:-free.
import { regionsBbox } from "./vector-format.js";

const EXTENT_EPS = 1e-9;
const ALIGN = new Set(["left", "center", "right"]);
const VALIGN = new Set(["bottom", "middle", "top"]);
const SIZE_KEYS = ["width", "height", "fit"];

function scaleFor(opts, units, w, h) {
  const given = SIZE_KEYS.filter((k) => opts[k] != null);
  if (given.length > 1) {
    throw new Error(`vector2d: pass only one of width, height, or fit — got ${given.join(", ")}`);
  }
  if (given.length === 0) {
    // Millimetre coordinates already mean something; artwork units do not, so
    // there is no honest default for artwork. (k.text2d can default `size`
    // because a cap height is a real measurement; an SVG viewBox unit is not.)
    if (units === "mm") return 1;
    throw new Error("vector2d: a size is required for artwork units — pass one of { width }, { height }, or { fit } in millimetres");
  }
  const [key] = given;
  const v = opts[key];
  if (!(v > 0)) throw new Error(`vector2d: ${key} must be a positive number of millimetres`);
  const extent = key === "width" ? w : key === "height" ? h : Math.max(w, h);
  if (!(extent > EXTENT_EPS)) throw new Error(`vector2d: artwork has no ${key === "fit" ? "extent" : key} to size against`);
  return v / extent;
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

export function placeRegions(regions, units, opts = {}) {
  // An mm file places where it was drawn; only artwork has to be re-centred,
  // because its own coordinates mean nothing. `null` here is "no translate" —
  // distinct from `align: "center"`, which does translate (to the origin).
  const align = opts.align ?? (units === "mm" ? null : "center");
  const valign = opts.valign ?? (units === "mm" ? null : "middle");
  // No silent default for a bad value: align/valign each pick their branch by
  // string equality below, and any value that fails all three comparisons
  // (a typo — "centre" for "center" — or any other garbage) would otherwise
  // fall through to the middle/center case with no error, placing the artwork
  // somewhere the caller never asked for. Every other op in this feature
  // refuses instead of guessing (scaleFor above, right on this same function);
  // this closes the one silent-default gap.
  if (align != null && !ALIGN.has(align)) throw new Error(`vector2d: align must be "left", "center", or "right" — got ${JSON.stringify(align)}`);
  if (valign != null && !VALIGN.has(valign)) throw new Error(`vector2d: valign must be "bottom", "middle", or "top" — got ${JSON.stringify(valign)}`);
  const { minX, minY, maxX, maxY } = regionsBbox(regions);
  const s = scaleFor(opts, units, maxX - minX, maxY - minY);
  const dx = align == null ? 0 : align === "left" ? -minX * s : align === "right" ? -maxX * s : -((minX + maxX) / 2) * s;
  const dy = valign == null ? 0 : valign === "bottom" ? -minY * s : valign === "top" ? -maxY * s : -((minY + maxY) / 2) * s;
  return regions.map((r) => ({
    outer: place(r.outer, s, dx, dy),
    holes: r.holes.map((c) => place(c, s, dx, dy)),
  }));
}
