// partforge/ingest — SVG -> the partforge-vector JSON format (docs/VECTOR-FORMAT.md).
//
// DOM-dependent and main-thread-only: this entry is deliberately NOT reachable
// from the geometry worker, and is never re-exported from the main entry or
// from `partforge/geometry`. A host runs it once per artwork, in a browser,
// and stores the result — the same division of labour as `fontCatalog`.
// partforge does not write files.
//
// These declarations describe the FORMAT, not just what `ingestSvg` happens to
// emit — the same documents are hand-authored, so `bbox` and `source` are
// optional here even though ingest always writes both.

/** Coordinate meaning. `"mm"` places as authored; `"artwork"` requires a size at every call site. */
export type VectorUnits = "mm" | "artwork";

/** Whether a shape adds material to the composed result or is cut from it. `"add"` is the default. */
export type VectorRole = "add" | "subtract";

/** The document's tight bounding box. A cache, not an authority — placement recomputes it. */
export interface VectorBbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A parsed `partforge-vector` JSON document — see docs/VECTOR-FORMAT.md. */
export interface VectorDocument {
  format: "partforge-vector";
  version: number;
  units: VectorUnits;
  /** Free text; ignored on load. Ingest writes the format's own one-paragraph summary. */
  note?: string;
  /** Provenance only — typically the original filename. Not validated or used at load/build time. */
  source?: string | null;
  /** Optional: an author need not compute analytic curve extrema, but a stale value is a named error. */
  bbox?: VectorBbox;
  /** Name -> shape. At least one shape, and at least one of them must have role `"add"`. */
  shapes: Record<string, VectorShape>;
}

/**
 * A named shape: either a bare region list (role `"add"`) or `{ role, regions }`.
 * Both forms exist because `"add"` is an honest default — a painted region adds
 * material, which is what every file written before roles existed already meant.
 */
export type VectorShape = VectorRegion[] | { role?: VectorRole; regions: VectorRegion[] };

/** One filled region: an `outer` boundary with `holes` subtracted from it. */
export interface VectorRegion {
  outer: VectorContour;
  holes?: VectorContour[];
}

/** One closed contour: the explicit `"path"` form, or one of the three primitives. */
export type VectorContour = VectorPath | VectorCircle | VectorRect | VectorPolygon;

/**
 * Segments run head-to-tail from `start`, and the contour closes IMPLICITLY from
 * the last segment's `to` back to `start`. At least one segment, and at least two
 * if they are all `"line"` — a single straight edge and its closure are the same
 * line, so they bound nothing, while a single `"arc"` or `"cubic"` bounds area
 * against the closing chord.
 */
export interface VectorPath {
  kind: "path";
  start: [number, number];
  segments: VectorSegment[];
}

/** Expands to two 180-degree arcs, counter-clockwise. */
export interface VectorCircle {
  kind: "circle";
  center: [number, number];
  r: number;
}

/** Axis-aligned, counter-clockwise. `radius` rounds all four corners; at most half the shorter side. */
export interface VectorRect {
  kind: "rect";
  center: [number, number];
  width: number;
  height: number;
  radius?: number;
}

/** At least 3 points, joined by straight edges in the author's own order. */
export interface VectorPolygon {
  kind: "polygon";
  points: Array<[number, number]>;
}

export type VectorSegment =
  | { kind: "line"; to: [number, number] }
  | { kind: "arc"; to: [number, number]; through: [number, number] }
  | { kind: "cubic"; to: [number, number]; c1: [number, number]; c2: [number, number] };

export interface IngestSvgOptions {
  /**
   * `"outline"` (default) turns strokes into filled geometry; `"ignore"` drops
   * stroke geometry entirely and keeps only fills. There is no equivalent
   * option on `k.vector2d` — once ingested, there is no stroke left to ignore.
   */
  strokes?: "outline" | "ignore";
  /** Provenance only — typically the original filename. Stored verbatim as `source`; not validated or used at load/build time. */
  source?: string | null;
}

/**
 * Convert an SVG document (as text) into the `partforge-vector` JSON format a
 * part's `k.vector2d()` calls can place. DOM-required — call this in a browser,
 * store the returned document (e.g. as `<name>.vector.json` beside the part),
 * and reference it from the part's `vectors` field. The result is always one
 * shape named `"artwork"` in `"artwork"` units, with `bbox` and `source` written.
 * Throws if the SVG can't be parsed, or if it contains no painted geometry (every
 * element is `fill="none"` with no stroke, hidden, or empty).
 */
export function ingestSvg(svgText: string, opts?: IngestSvgOptions): VectorDocument;

export interface ImageToPngOptions {
  /** Long-edge cap in px; an image already under this is not upscaled. Default 1024. */
  maxSize?: number;
}

/**
 * Convert any image the browser can decode into a PNG `Blob`, downsampling the
 * long edge to `maxSize` on the way. Main-thread only (uses `createImageBitmap`
 * and a canvas) — for a host normalising uploads before storing them, since a
 * part's `images` field decodes PNG only. Never call from a part's `build`.
 */
export function imageToPng(fileOrBlob: Blob | File, options?: ImageToPngOptions): Promise<Blob>;
