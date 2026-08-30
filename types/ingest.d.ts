// partforge/ingest — SVG -> the partforge-vector JSON format (docs/VECTOR-FORMAT.md).
//
// DOM-dependent and main-thread-only: this entry is deliberately NOT reachable
// from the geometry worker, and is never re-exported from the main entry or
// from `partforge/geometry`. A host runs it once per artwork, in a browser,
// and stores the result — the same division of labour as `fontCatalog`.
// partforge does not write files.

/** A parsed `partforge-vector` JSON document — see docs/VECTOR-FORMAT.md. */
export interface VectorDocument {
  format: "partforge-vector";
  version: number;
  note?: string;
  source: string | null;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  regions: Array<{
    outer: VectorContour;
    holes?: VectorContour[];
  }>;
}

/** One closed contour in the JSON format: implicitly closed from the last segment's `to` back to `start`. */
export interface VectorContour {
  start: [number, number];
  segments: VectorSegment[];
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
 * and reference it from the part's `vectors` field. Throws if the SVG can't be
 * parsed, or if it contains no painted geometry (every element is
 * `fill="none"` with no stroke, hidden, or empty).
 */
export function ingestSvg(svgText: string, opts?: IngestSvgOptions): VectorDocument;
