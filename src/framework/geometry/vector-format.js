// The `partforge-vector` JSON format: constants, validation, and the mapping to
// and from this engine's internal region IR.
//
// This is a PUBLISHED format — agents read it, and (since ingest needs a
// browser) may hand-write it — so it is explicit where the internal IR is
// implicit. The internal IR infers a segment's type from which keys are present
// (`c1` → cubic, `via` → arc, neither → line) and calls an arc's third point
// `via`. Both are fine for code and hostile to anyone writing a file by hand, so
// the JSON tags every segment with `kind` and names the arc point `through` —
// "the arc passes through here", which `via` does not say.
//
// This file is the ONLY place the two vocabularies meet. Upstream speaks JSON,
// downstream speaks the internal IR, and nothing else needs to know both.
//
// Pure leaf: DOM-free, node:-free. Both halves of the feature import it.
import { profileBounds } from "./contour-ops.js";

export const VECTOR_FORMAT = "partforge-vector";
export const VECTOR_VERSION = 1;

export const FORMAT_NOTE =
  "Filled 2-D outlines for k.vector2d. `units` is \"mm\" (coordinates are millimetres, placed as "
  + "authored) or \"artwork\" (no physical meaning; a size is required at every call site). `shapes` "
  + "maps a name to a list of filled regions; each region's `outer` is its boundary and `holes` are "
  + "subtracted from it. A contour is a `kind`: \"path\", \"circle\", \"rect\", or \"polygon\". Path "
  + "segments run head-to-tail from `start`, and the contour closes implicitly from the last `to` "
  + "back to `start`. y points UP. See docs/VECTOR-FORMAT.md.";

const BBOX_TOL = 1e-3;        // mm-free: these are artwork units, and 6dp rounding is finer
const ROUND = 1e6;            // 6 decimal places

const round6 = (n) => Math.round(n * ROUND) / ROUND;
const isPt = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
const num = (v) => Number.isFinite(v);

// Every message carries the vectors key and the position, because the reader is as
// likely to be an agent that generated the file as a human who wrote it.
const fail = (label, where, what, fix) => {
  throw new Error(`vector2d: "${label}" ${where} ${what}${fix ? ` — ${fix}` : ""}`);
};

const EPS = 1e-12;
const CONTOUR_KINDS = '"path", "circle", "rect", or "polygon"';

// Every primitive expands to the SAME internal contour a hand-written "path"
// would produce, right here at the JSON boundary. Nothing downstream —
// placement, Shape2D, either backend, the exporters — knows primitives exist.
//
// circle and rect wind counter-clockwise by construction; polygon follows the
// author's point order. None of them needs to know whether it is an outer or a
// hole: ensureRegionWinding reorients from that label when the region is lifted
// into a Shape2D, so stored winding carries no information.
const expandCircle = ({ center: [cx, cy], r }) => ({
  start: [cx + r, cy],
  segments: [
    { to: [cx - r, cy], via: [cx, cy + r] },
    { to: [cx + r, cy], via: [cx, cy - r] },
  ],
});

const expandRect = ({ center: [cx, cy], width, height, radius = 0 }) => {
  const hw = width / 2, hh = height / 2;
  if (!(radius > 0)) {
    return { start: [cx - hw, cy - hh], segments: [
      { to: [cx + hw, cy - hh] }, { to: [cx + hw, cy + hh] }, { to: [cx - hw, cy + hh] },
    ] };
  }
  const r = radius, k = r / Math.SQRT2;
  const start = [cx - hw + r, cy - hh];
  const raw = [
    { to: [cx + hw - r, cy - hh] },
    { to: [cx + hw, cy - hh + r], via: [cx + hw - r + k, cy - hh + r - k] },
    { to: [cx + hw, cy + hh - r] },
    { to: [cx + hw - r, cy + hh], via: [cx + hw - r + k, cy + hh - r + k] },
    { to: [cx - hw + r, cy + hh] },
    { to: [cx - hw, cy + hh - r], via: [cx - hw + r - k, cy + hh - r + k] },
    { to: [cx - hw, cy - hh + r] },
    { to: [cx - hw + r, cy - hh], via: [cx - hw + r - k, cy - hh + r - k] },
  ];
  // At radius = min(w,h)/2 two (or four) edges collapse to a point. Emitting a
  // zero-length line would hand a degenerate edge to the boolean engine.
  const out = [];
  let prev = start;
  for (const seg of raw) {
    if (!seg.via && Math.abs(seg.to[0] - prev[0]) < EPS && Math.abs(seg.to[1] - prev[1]) < EPS) continue;
    out.push(seg);
    prev = seg.to;
  }
  return { start, segments: out };
};

const expandPolygon = ({ points }) => ({
  start: [...points[0]],
  segments: points.slice(1).map((p) => ({ to: [...p] })),
});

function checkContour(label, where, c) {
  if (!c || typeof c !== "object") fail(label, where, "is not an object");
  if (typeof c.kind !== "string") {
    fail(label, where, 'has no "kind"', `every contour needs a kind — ${CONTOUR_KINDS}`);
  }
  if (c.kind === "circle") {
    if (!isPt(c.center)) fail(label, where, 'has "kind": "circle" but no valid "center"', "center must be an [x, y] pair of finite numbers");
    if (!num(c.r) || c.r <= 0) fail(label, where, `has "kind": "circle" but a non-positive r (${JSON.stringify(c.r)})`, "r must be a finite number greater than 0");
    return;
  }
  if (c.kind === "rect") {
    if (!isPt(c.center)) fail(label, where, 'has "kind": "rect" but no valid "center"', "center must be an [x, y] pair of finite numbers");
    for (const k of ["width", "height"]) {
      if (!num(c[k]) || c[k] <= 0) fail(label, where, `has "kind": "rect" but a non-positive ${k} (${JSON.stringify(c[k])})`, `${k} must be a finite number greater than 0`);
    }
    if (c.radius != null) {
      if (!num(c.radius) || c.radius < 0) fail(label, where, `has "kind": "rect" but an invalid radius (${JSON.stringify(c.radius)})`, "radius must be a finite number of 0 or more");
      const max = Math.min(c.width, c.height) / 2;
      if (c.radius > max) {
        fail(label, where, `has "kind": "rect" with radius ${c.radius} exceeds the maximum ${round6(max)}`,
          "a corner radius cannot be more than half the shorter side");
      }
    }
    return;
  }
  if (c.kind === "polygon") {
    if (!Array.isArray(c.points) || c.points.length < 3) {
      fail(label, where, `has "kind": "polygon" with ${c.points?.length ?? 0} points`, "a polygon needs at least 3 points");
    }
    c.points.forEach((p, i) => { if (!isPt(p)) fail(label, `${where} point ${i + 1}`, "is not a valid [x, y] pair of finite numbers"); });
    return;
  }
  if (c.kind !== "path") {
    fail(label, where, `has unknown "kind": ${JSON.stringify(c.kind)}`, `kind must be ${CONTOUR_KINDS}`);
  }
  // "path" — the explicit form.
  if (!isPt(c.start)) fail(label, where, 'has no valid "start"', "start must be a [x, y] pair of finite numbers");
  if (!Array.isArray(c.segments) || c.segments.length < 2) {
    fail(label, where, `has too few segments (${c.segments?.length ?? 0})`,
      "a closed contour needs at least two segments; it closes implicitly from the last `to` back to `start`");
  }
  c.segments.forEach((s, i) => {
    const at = `${where} segment ${i + 1}`;
    if (!s || typeof s !== "object") fail(label, at, "is not an object");
    if (!isPt(s.to)) fail(label, at, 'has no valid "to"', "every segment needs a `to` [x, y] pair of finite numbers");
    if (s.kind === "line") return;
    if (s.kind === "arc") {
      if (!isPt(s.through)) {
        fail(label, at, 'has "kind": "arc" but no valid "through" point',
          "an arc needs a point it passes through, between the previous point and `to`");
      }
      return;
    }
    if (s.kind === "cubic") {
      if (!isPt(s.c1)) fail(label, at, 'has "kind": "cubic" but no valid "c1"', "a cubic needs both control points, c1 and c2");
      if (!isPt(s.c2)) fail(label, at, 'has "kind": "cubic" but no valid "c2"', "a cubic needs both control points, c1 and c2");
      return;
    }
    fail(label, at, `has unknown "kind": ${JSON.stringify(s.kind)}`, 'kind must be "line", "arc", or "cubic"');
  });
}

export const VECTOR_UNITS = ["mm", "artwork"];

const ROLES = ["add", "subtract"];

// A shape is either a bare region array — the common case, role "add" — or
// { role, regions }. Two forms rather than one because "add" is an honest
// default: a painted region adds material, which is what every file written
// before roles existed already meant.
//
// The default applies when `role` is ABSENT, not merely falsy — an explicit
// `"role": null` (or any other present-but-wrong value) must fall through to
// the unknown-role check below, not silently become "add". `"role" in v` is
// safe here: the array branch has already returned, so `v` is a non-array
// object (validateVectorDocument rejects a non-object shape value before
// either caller of this function reaches a bare-object shape).
const shapeParts = (v) => (Array.isArray(v) ? { role: "add", regions: v } : { role: "role" in v ? v.role : "add", regions: v.regions });

export function validateVectorDocument(doc, label = "(unnamed)") {
  if (!doc || typeof doc !== "object") fail(label, "file", "is not an object", "expected parsed JSON");
  if (doc.format !== VECTOR_FORMAT) {
    fail(label, "file", `has format ${JSON.stringify(doc.format)}`,
      `expected ${JSON.stringify(VECTOR_FORMAT)} — this is not a partforge-vector file`);
  }
  // Floor as well as ceiling: version 0 and negatives used to load.
  if (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > VECTOR_VERSION) {
    fail(label, "file", `has version ${JSON.stringify(doc.version)}`,
      `this build understands version ${VECTOR_VERSION} — re-ingest the artwork, or upgrade partforge`);
  }
  if (!VECTOR_UNITS.includes(doc.units)) {
    fail(label, "file", `has no valid \`units\` (${JSON.stringify(doc.units)})`,
      '`units` must be "mm" (coordinates are millimetres, placed as authored) or "artwork" '
      + "(coordinates have no physical meaning; a size is required at every call site)");
  }
  if (doc.note != null && typeof doc.note !== "string") fail(label, "file", "has a non-string `note`", "`note` is free text and is ignored on load");
  if (doc.source != null && typeof doc.source !== "string") fail(label, "file", "has a non-string `source`", "`source` is provenance only and may be omitted");
  // A stale draft in the pre-shapes envelope gets its own message rather than
  // the generic "has no shapes", which would send the reader looking for a typo.
  if (doc.shapes == null && Array.isArray(doc.regions)) {
    fail(label, "file", 'has a "regions" array, which this build does not read',
      'regions now live under a named shape in "shapes", e.g. { "shapes": { "artwork": [ …regions… ] } }');
  }
  const names = doc.shapes && typeof doc.shapes === "object" && !Array.isArray(doc.shapes) ? Object.keys(doc.shapes) : [];
  if (names.length === 0) {
    fail(label, "file", "has no shapes", 'a vector file needs at least one named shape: { "shapes": { "artwork": [ …regions… ] } }');
  }
  let anyAdd = false;
  for (const name of names) {
    const where = `shape ${JSON.stringify(name)}`;
    const raw = doc.shapes[name];
    if (!raw || typeof raw !== "object") fail(label, where, "is not an array of regions or a { role, regions } object");
    const { role, regions } = shapeParts(raw);
    if (!ROLES.includes(role)) {
      fail(label, where, `has an unknown \`role\` ${JSON.stringify(role)}`,
        '`role` must be "add" (the default, may be omitted) or "subtract"');
    }
    if (role === "add") anyAdd = true;
    if (!Array.isArray(regions)) fail(label, where, "is not an array of regions");
    if (regions.length === 0) fail(label, where, "is empty", "a shape needs at least one region");
    regions.forEach((rg, i) => {
      const at = `${where} region ${i + 1}`;
      if (!rg || typeof rg !== "object") fail(label, at, "is not an object");
      checkContour(label, `${at} outer`, rg.outer);
      if (rg.holes != null && !Array.isArray(rg.holes)) fail(label, at, "has a non-array `holes`");
      (rg.holes ?? []).forEach((h, j) => checkContour(label, `${at} hole ${j + 1}`, h));
    });
  }
  if (!anyAdd) {
    fail(label, "file", 'has no shape with role "add"',
      "a file whose every shape subtracts composes to nothing — at least one shape must add material");
  }

  // bbox is a CACHE, not an authority: placement recomputes it anyway. It is
  // OPTIONAL — an author should not have to compute analytic curve extrema to
  // satisfy a checksum — but when a generator writes one, a stale value is a
  // named error rather than silently wrong sizing at build time.
  if (doc.bbox == null) return;
  if (!["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite(doc.bbox[k]))) {
    fail(label, "file", "has an invalid `bbox`", "bbox is optional, but when present it needs finite minX, minY, maxX, maxY");
  }
  const actual = regionsBbox(allRegionsUnchecked(doc));
  for (const k of ["minX", "minY", "maxX", "maxY"]) {
    if (Math.abs(actual[k] - doc.bbox[k]) > BBOX_TOL) {
      fail(label, "file", `has a bbox that disagrees with its geometry (${k}: header ${doc.bbox[k]}, actual ${round6(actual[k])})`,
        "re-ingest the artwork, or omit `bbox` — it is optional and recomputed either way");
    }
  }
}

const toSeg = (s) =>
  s.kind === "arc" ? { to: [...s.to], via: [...s.through] }
  : s.kind === "cubic" ? { to: [...s.to], c1: [...s.c1], c2: [...s.c2] }
  : { to: [...s.to] };

function toContour(c) {
  if (c.kind === "circle") return expandCircle(c);
  if (c.kind === "rect") return expandRect(c);
  if (c.kind === "polygon") return expandPolygon(c);
  const segments = c.segments.map(toSeg);
  // A file may spell the implicit closure out. Dropping it here keeps one
  // internal representation, so downstream never has to ask which form it got.
  const last = segments.at(-1);
  if (!last.via && !last.c1 && last.to[0] === c.start[0] && last.to[1] === c.start[1]) segments.pop();
  return { start: [...c.start], segments };
}

const toRegion = (rg) => ({ outer: toContour(rg.outer), holes: (rg.holes ?? []).map(toContour) });

const allRegionsUnchecked = (doc) =>
  Object.values(doc.shapes).flatMap((v) => shapeParts(v).regions).map(toRegion);

export function toInternalDocument(doc, label = "(unnamed)") {
  validateVectorDocument(doc, label);
  return {
    units: doc.units,
    shapes: new Map(Object.entries(doc.shapes).map(([name, v]) => {
      const { role, regions } = shapeParts(v);
      return [name, { role, regions: regions.map(toRegion) }];
    })),
  };
}

// Exported: vector2d.js needs the same tight bbox at build time, and two copies of
// this loop would be two places to fix a bounds bug.
//
// Built on contour-ops.js's profileBounds — an EXACT bbox (paper.js computes a
// curve's analytic extrema, not a sampled approximation) rather than the fixed
// 64-segment tessellation this used to walk. That mattered in practice, not
// just in theory: 64-segment sampling can undershoot a true arc extremum by
// roughly 1.2e-3 × radius — comfortably past BBOX_TOL below — which meant a
// hand-authored document with the mathematically CORRECT tight bbox could be
// rejected by validateVectorDocument's "disagrees with its geometry" check.
// profileBounds also folds in holes, which regions never needed excluded: a
// hole is by construction inside its own outer, so its bounds can only sit
// within the outer's and never move minX/minY/maxX/maxY.
export function regionsBbox(regions) {
  if (regions.length === 0) return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const { min, max } = profileBounds(regions);
  return { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
}

const fromSeg = (s) =>
  s.via ? { kind: "arc", to: [round6(s.to[0]), round6(s.to[1])], through: [round6(s.via[0]), round6(s.via[1])] }
  : s.c1 ? { kind: "cubic", to: [round6(s.to[0]), round6(s.to[1])],
             c1: [round6(s.c1[0]), round6(s.c1[1])], c2: [round6(s.c2[0]), round6(s.c2[1])] }
  : { kind: "line", to: [round6(s.to[0]), round6(s.to[1])] };

const fromContour = (c) => ({
  kind: "path",
  start: [round6(c.start[0]), round6(c.start[1])],
  segments: c.segments.map(fromSeg),
});

export function fromInternalRegions(regions, { source = null, units = "artwork", shape = "artwork" } = {}) {
  const bb = regionsBbox(regions);
  return {
    format: VECTOR_FORMAT,
    version: VECTOR_VERSION,
    units,
    note: FORMAT_NOTE,
    source,
    bbox: { minX: round6(bb.minX), minY: round6(bb.minY), maxX: round6(bb.maxX), maxY: round6(bb.maxY) },
    shapes: { [shape]: regions.map((rg) => ({ outer: fromContour(rg.outer), holes: (rg.holes ?? []).map(fromContour) })) },
  };
}
