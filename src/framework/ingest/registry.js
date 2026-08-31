// src/framework/ingest/registry.js
// The one table that answers "what does this file become?" — read by the panel's
// drop widget AND by `partforge ingest`. It does NOT route to part fields: the
// declaration-function pattern (`images: (p) => ({ relief: p.relief })`) already
// does that, because a control writes into its own param key and the author's
// declaration puts that key in the right field.
//
// DOM-free, node:-free, and converter-free AT MODULE SCOPE: `convert` is a thunk
// returning a dynamic import, so reading the table costs nothing and the CLI
// never loads paper.js for a font.
import { sniffMediaType } from "./sniff.js";

export const ASSET_KINDS = ["image", "vector", "font"];

const ROWS = [
  {
    kind: "image",
    label: "an image (PNG, JPG or WebP)",
    accepts: ["image/png", "image/jpeg", "image/webp"],
    convert: () => import("./image-ingest.js").then((m) => m.imageToPng),
  },
  {
    kind: "vector",
    label: "artwork (SVG)",
    accepts: ["image/svg+xml"],
    convert: () => import("./svg-ingest.js").then((m) => m.ingestSvg),
  },
  {
    kind: "font",
    label: "a font (TTF or OTF)",
    accepts: ["font/ttf", "font/otf"],
    convert: null,                        // used as-is; validated, never converted
  },
];

export const rowFor = (kind) => ROWS.find((r) => r.kind === kind);

// Which kind, if any, WOULD accept this media type — the "use the Artwork slot"
// hint. null when no slot accepts it (an unsupported format, e.g. WOFF2).
const kindAccepting = (mediaType) => ROWS.find((r) => r.accepts.includes(mediaType))?.kind ?? null;

export function classify(bytes, kind) {
  const mediaType = sniffMediaType(bytes);
  const row = rowFor(kind);
  if (row && mediaType && row.accepts.includes(mediaType)) return { ok: true, mediaType };
  return { ok: false, reason: mediaType ? "wrong-type" : "unrecognised",
           mediaType, suggestKind: mediaType ? kindAccepting(mediaType) : null };
}

export async function convertFor(kind, mediaType) {
  const row = rowFor(kind);
  if (!row || !row.accepts.includes(mediaType)) return null;
  return row.convert ? row.convert() : null;
}
