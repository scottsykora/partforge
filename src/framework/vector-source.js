// What a PARAM-supplied vector source may be. Author-declared `vectors`
// sources are code and get no restriction; this file exists only for the
// other case — a value that arrived in `params`, which on a shared link is
// attacker-controlled input that `vectors: (p) => …` would turn into a fetch
// URL.
//
// This file's allow rule differs from its two siblings
// (font-source.js/image-source.js) in ONE place, and getting that difference
// right matters: those two exempt every non-string (bytes) source from the
// allow check on the reasoning that an ArrayBuffer cannot survive a share
// link — a URL can't carry megabytes, so bytes in params can only have been
// placed there by the host's own trusted panel. That reasoning does NOT
// transfer to vector artwork: `type: "vector"`'s drop target writes a PARSED
// partforge-vector document — plain JSON — into params when there is no upload
// hook, and unlike raw bytes, plain JSON round-trips a share link perfectly
// (it's just more of the same params payload). Do not copy the
// bytes-can't-survive-a-link justification here; it would be wrong.
//
// So the exemption this file grants is NOT "any object". The gate has to be
// read against what asset-resolve.js actually does, in its order:
// `unwrapModule(v)` runs FIRST, and only THEN does the resolver dispatch on
// shape. A `{ default: "http://169.254.169.254/…" }` wrapper is therefore
// unwrapped to a plain string and handed to `fetch` — arbitrary scheme,
// arbitrary host, in ~40 bytes of JSON a share link carries effortlessly. An
// earlier version of this file exempted every object on the claim that "an
// object never reaches the fetch branch"; that claim was FALSE for exactly
// this shape, and it is deleted rather than qualified.
//
// The rule that does hold, and what this file gates on, is: unwrap first, then
// judge the value the RESOLVER will see.
//
//   - a string or `URL` — fetchable, so it gets the full `allow` treatment;
//   - bytes (ArrayBuffer/view) — never handed to `fetch`, and (unlike JSON)
//     genuinely cannot ride a link, so exempt;
//   - a function/thunk — refused outright. Its return value is a fetch source
//     that cannot be known at check time, so there is nothing to gate on;
//   - a plain object that does NOT unwrap to any of the above — the genuinely
//     inert case, the already-parsed partforge-vector document vectors.js's
//     `asParsedFile` claims. It is validated downstream by `toInternalDocument`,
//     a pure shape check that never touches the network, so it is exempt;
//   - anything else (arrays, numbers, booleans) — refused. None of them is a
//     valid source, and a refusal simply restores the part's default.
//
// `unwrapModule` is imported, never re-implemented: this gate is only sound
// while it unwraps by exactly the same rule the resolver does.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.
// asset-resolve.js is itself dependency-free, so importing it keeps
// partforge/lint's zero-dependency closure intact.
import { unwrapModule } from "./asset-resolve.js";

export const VECTOR_ALLOW_DEFAULT = ["https"];

const ASSET_SCHEME = "pfc-asset:";
// Artwork that lives as a FILE IN THE PART ITSELF, addressed by its path
// rather than by a host-side storage id. Vector-only, and the asymmetry is
// structural rather than an omission: a part's files are text, so a JSON
// document can live in one and a PNG cannot. A host that stores parts as a
// file tree (partforge-cloud is the motivating case) resolves this scheme
// against that tree; partforge itself only decides whether a param may carry
// it, exactly as it does for `pfc-asset:`.
const TREE_SCHEME = "pfc-tree:";

// The "unset" vector source. An empty value declares NO artwork for that
// name — mirrors isNoFontSource/isNoImageSource exactly. Never a source to
// fetch, and never a source to refuse.
export const isNoVectorSource = (v) => v === undefined || v === null || v === "";

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

// An already-parsed partforge-vector document: object-shaped, and not any of
// the shapes the resolver reads as a way to REACH bytes. Deliberately the same
// structural test vectors.js's `asParsedFile` applies (arrays excluded — an
// array is never a file), so "what this gate exempts" and "what the resolver
// adopts without fetching" stay the same set.
const isParsedDocument = (v) =>
  v != null && typeof v === "object" && !Array.isArray(v)
  && !isBytes(v) && !(v instanceof URL);

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function vectorSourceAllowed(source, allow = VECTOR_ALLOW_DEFAULT) {
  // Unwrap FIRST — asset-resolve.js does, before it dispatches on shape, so a
  // `{ default: … }` wrapper must be judged by what it unwraps to. See header.
  const v = unwrapModule(source);
  // A thunk (before or after unwrapping) resolves to a source this check cannot
  // see, so there is nothing to gate; refuse rather than trust it.
  if (typeof source === "function" || typeof v === "function") return false;
  if (isBytes(v)) return true;                    // never handed to `fetch`
  if (isParsedDocument(v)) return true;           // inert; validated, never fetched
  // Everything the resolver would fetch — a string or a `URL` — gets the full
  // allow treatment. Everything else (arrays, numbers, booleans) is refused.
  if (!(typeof v === "string" || v instanceof URL)) return false;
  const u = v instanceof URL ? v : parse(v);
  if (!u) return false;
  for (const kind of allow) {
    // hostname/protocol, never a substring of the raw string — same rule
    // font-source.js's header explains: a URL merely CONTAINING
    // "pfc-asset://" must not pass, and neither must a lookalike host.
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
    if (kind === "tree" && u.protocol === TREE_SCHEME) return true;
  }
  return false;
}

// paramKey → allow list, for every `type: "vector"` control in the authored
// tree — new-shape (`controls`, including nested groups) AND legacy-shape
// (`advanced`/`toggles`/`features`, where panel/legacy.js desugars a
// descriptor's `control:` field to `type:`), mirroring
// imageControlAllows/fontControlAllows exactly. Missing the legacy arrays
// here would leave a `{key, control:"vector"}` descriptor with no entry in
// the returned map, and jobs.js's check only looks at keys present in the
// map — so a legacy-declared vector control would get silently
// unrestricted. Tolerant of any array being absent or malformed; it must
// never throw on an existing part.
export function vectorControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (Array.isArray(n.advanced)) visit(n.advanced);
      if (Array.isArray(n.toggles)) visit(n.toggles);
      if (Array.isArray(n.features)) visit(n.features);
      if ((n.type === "vector" || n.control === "vector") && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : VECTOR_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
