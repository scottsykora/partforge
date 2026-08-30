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
  "Filled 2-D outlines for k.vector2d. Coordinates are plain numbers in the artwork's own "
  + "units — k.vector2d rescales at build time. y points UP. Each region is one filled area: "
  + "`outer` is its boundary and `holes` are subtracted from it. Segments run head-to-tail "
  + "from `start`; each segment's `to` is the next point. The contour closes implicitly from "
  + "the last `to` back to `start`. See docs/VECTOR-FORMAT.md.";

const BBOX_TOL = 1e-3;        // mm-free: these are artwork units, and 6dp rounding is finer
const ROUND = 1e6;            // 6 decimal places

const round6 = (n) => Math.round(n * ROUND) / ROUND;
const isPt = (v) => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

// Every message carries the vectors key and the position, because the reader is as
// likely to be an agent that generated the file as a human who wrote it.
const fail = (label, where, what, fix) => {
  throw new Error(`vector2d: "${label}" ${where} ${what}${fix ? ` — ${fix}` : ""}`);
};

function checkContour(label, where, contour) {
  if (!contour || typeof contour !== "object") fail(label, where, "is not an object");
  if (!isPt(contour.start)) fail(label, where, 'has no valid "start"', "start must be a [x, y] pair of finite numbers");
  if (!Array.isArray(contour.segments) || contour.segments.length < 2) {
    fail(label, where, `has too few segments (${contour.segments?.length ?? 0})`,
      "a closed contour needs at least two segments; it closes implicitly from the last `to` back to `start`");
  }
  contour.segments.forEach((s, i) => {
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

export function validateVectorDocument(doc, label = "(unnamed)") {
  if (!doc || typeof doc !== "object") fail(label, "file", "is not an object", "expected parsed JSON");
  if (doc.format !== VECTOR_FORMAT) {
    fail(label, "file", `has format ${JSON.stringify(doc.format)}`,
      `expected ${JSON.stringify(VECTOR_FORMAT)} — this is not a partforge-vector file`);
  }
  if (!Number.isInteger(doc.version) || doc.version > VECTOR_VERSION) {
    fail(label, "file", `has version ${JSON.stringify(doc.version)}`,
      `this build understands version ${VECTOR_VERSION} — re-ingest the artwork, or upgrade partforge`);
  }
  if (doc.note != null && typeof doc.note !== "string") fail(label, "file", "has a non-string `note`", "`note` is free text and is ignored on load");
  if (!Array.isArray(doc.regions) || doc.regions.length === 0) {
    fail(label, "file", "has no regions", "a vector file needs at least one filled region");
  }
  doc.regions.forEach((rg, i) => {
    const where = `region ${i + 1}`;
    if (!rg || typeof rg !== "object") fail(label, where, "is not an object");
    checkContour(label, `${where} outer`, rg.outer);
    if (rg.holes != null && !Array.isArray(rg.holes)) fail(label, where, "has a non-array `holes`");
    (rg.holes ?? []).forEach((h, j) => checkContour(label, `${where} hole ${j + 1}`, h));
  });

  // bbox is a CACHE, not an authority: vector2d recomputes it anyway. Checking it
  // here turns a stale or hand-miscalculated header into a named error instead
  // of silently wrong sizing at build time.
  if (!doc.bbox || !["minX", "minY", "maxX", "maxY"].every((k) => Number.isFinite(doc.bbox[k]))) {
    fail(label, "file", "has no valid `bbox`", "bbox needs finite minX, minY, maxX, maxY");
  }
  const actual = regionsBbox(toInternalRegionsUnchecked(doc));
  for (const k of ["minX", "minY", "maxX", "maxY"]) {
    if (Math.abs(actual[k] - doc.bbox[k]) > BBOX_TOL) {
      fail(label, "file", `has a bbox that disagrees with its geometry (${k}: header ${doc.bbox[k]}, actual ${round6(actual[k])})`,
        "re-ingest the artwork, or correct the bbox to the tight bounds of `regions`");
    }
  }
}

const toSeg = (s) =>
  s.kind === "arc" ? { to: [...s.to], via: [...s.through] }
  : s.kind === "cubic" ? { to: [...s.to], c1: [...s.c1], c2: [...s.c2] }
  : { to: [...s.to] };

function toContour(c) {
  const segments = c.segments.map(toSeg);
  // A file may spell the implicit closure out. Dropping it here keeps one
  // internal representation, so downstream never has to ask which form it got.
  const last = segments.at(-1);
  if (!last.via && !last.c1 && last.to[0] === c.start[0] && last.to[1] === c.start[1]) segments.pop();
  return { start: [...c.start], segments };
}

const toInternalRegionsUnchecked = (doc) =>
  doc.regions.map((rg) => ({ outer: toContour(rg.outer), holes: (rg.holes ?? []).map(toContour) }));

export function toInternalRegions(doc, label = "(unnamed)") {
  validateVectorDocument(doc, label);
  return toInternalRegionsUnchecked(doc);
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

const fromContour = (c) => ({ start: [round6(c.start[0]), round6(c.start[1])], segments: c.segments.map(fromSeg) });

export function fromInternalRegions(regions, { source = null } = {}) {
  const bb = regionsBbox(regions);
  return {
    format: VECTOR_FORMAT,
    version: VECTOR_VERSION,
    note: FORMAT_NOTE,
    source,
    bbox: { minX: round6(bb.minX), minY: round6(bb.minY), maxX: round6(bb.maxX), maxY: round6(bb.maxY) },
    regions: regions.map((rg) => ({ outer: fromContour(rg.outer), holes: (rg.holes ?? []).map(fromContour) })),
  };
}
