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
// transfer to vector artwork: `type: "vector"`'s drop target (task 9, Ruling
// D) writes a PARSED partforge-vector document — plain JSON — into params
// when there is no upload hook, and unlike raw bytes, plain JSON round-trips
// a share link perfectly (it's just more of the same params payload). Do not
// copy the bytes-can't-survive-a-link justification here; it would be wrong.
//
// The argument that DOES hold, and is what this file actually gates on, is
// the structural one Task 7 established in asset-resolve.js: the resolver
// calls `fetch` ONLY for a string/URL source. An object source is claimed by
// vectors.js's `asParsedFile` ("the in-tree form") before the resolver ever
// reaches the fetch branch, and whatever it contains is validated downstream
// by `toInternalDocument` — a parse/shape check, never a network request. So
// an object-valued (or byte-valued — same structural fact: neither is ever
// handed to `fetch`) vector param cannot become an SSRF-style request no
// matter what an attacker puts in it, which is exactly the class of harm
// `allow` exists to gate. Only a STRING source can become a fetch, so only a
// string source gets the full `allow` treatment; every other shape is
// permitted because it structurally cannot reach the network, not because it
// is implausible on a link.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const VECTOR_ALLOW_DEFAULT = ["https"];

const ASSET_SCHEME = "pfc-asset:";

// The "unset" vector source. An empty value declares NO artwork for that
// name — mirrors isNoFontSource/isNoImageSource exactly. Never a source to
// fetch, and never a source to refuse.
export const isNoVectorSource = (v) => v === undefined || v === null || v === "";

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);
// A source that structurally never reaches asset-resolve.js's `fetch`
// branch — bytes, or anything object-shaped (a parsed partforge-vector
// document). See the file header: this is permitted because of that
// structural fact, not because such a value is implausible on a link.
const neverFetched = (v) => isBytes(v) || (v != null && typeof v === "object");

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function vectorSourceAllowed(source, allow = VECTOR_ALLOW_DEFAULT) {
  if (neverFetched(source)) return true; // see the file header
  if (typeof source !== "string") return false;
  const u = parse(source);
  if (!u) return false;
  for (const kind of allow) {
    // hostname/protocol, never a substring of the raw string — same rule
    // font-source.js's header explains: a URL merely CONTAINING
    // "pfc-asset://" must not pass, and neither must a lookalike host.
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
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
