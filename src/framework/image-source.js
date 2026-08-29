// What a PARAM-supplied image source may be. Author-declared `images` sources are
// code and get no restriction; this file exists only for the other case — a
// value that arrived in `params`.
//
// This deliberately diverges from font-source.js in one place. That file refuses
// every non-string on the grounds that "bytes/thunks are never param-supplied".
// For images they ARE: the partforge-cloud sandbox cannot fetch URLs and puts PNG
// bytes straight in the param. The replacement rule is sound — an ArrayBuffer in
// params definitionally did not arrive via a shared link, because a URL cannot
// carry megabytes, so it can only have been placed there by the host's own panel,
// which is trusted code. Bytes therefore bypass the allow check entirely, for
// every allow list. Do NOT copy font-source.js's non-string refusal here.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const IMAGE_ALLOW_DEFAULT = ["https"];

const ASSET_SCHEME = "pfc-asset:";

// The "unset" image source. An empty value declares NO image — the documented way
// to leave a relief off, after which heightfield falls back to a flat slab. Never
// a source to fetch, and never a source to refuse.
export const isNoImageSource = (v) => v === undefined || v === null || v === "";

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function imageSourceAllowed(source, allow = IMAGE_ALLOW_DEFAULT) {
  if (isBytes(source)) return true; // see the file header — bytes always bypass the allow check
  if (typeof source !== "string") return false;
  const u = parse(source);
  if (!u) return false;
  for (const kind of allow) {
    // hostname/protocol, never a substring of the raw string: a URL merely
    // CONTAINING "pfc-asset://" (e.g. in its path) must not pass, and neither
    // must a lookalike host like `pfc-asset.evil.test` — see font-source.js's
    // header comment, which explains the two bugs this rule has already
    // caused when a check compared the raw string instead of the parsed URL.
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
  }
  return false;
}

// paramKey → allow list, for every `type: "image"` control in the authored tree,
// new-shape (`controls`, including nested groups) and legacy-shape
// (`advanced`/`toggles`/`features`, where panel/legacy.js desugars `control:` to
// `type:`). Missing the legacy arrays would leave such a control silently
// unrestricted. Tolerant of any array being absent or malformed — it must never
// throw on an existing part.
export function imageControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (Array.isArray(n.advanced)) visit(n.advanced);
      if (Array.isArray(n.toggles)) visit(n.toggles);
      if (Array.isArray(n.features)) visit(n.features);
      if ((n.type === "image" || n.control === "image") && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : IMAGE_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
