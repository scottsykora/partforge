// The published `partforge/ingest` entry: SVG -> the partforge-vector JSON
// format. DOM-required and main-thread only — a host runs it once per artwork
// and stores the result, the same division of labour as `fontCatalog`.
// partforge does not write files.
//
// Deliberately NOT re-exported from `partforge` (the main entry) or from
// `partforge/geometry`: this must stay unreachable from the geometry worker.
export { ingestSvg } from "./framework/ingest/svg-ingest.js";
