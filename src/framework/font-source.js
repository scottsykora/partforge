// What a PARAM-supplied font source may be. Author-declared `fonts` sources are
// code and get no restriction (see the design doc §4); this file exists only
// for the other case — a value that arrived in `params`, which on a shared link
// is attacker-controlled text that would otherwise become a fetch URL.
//
// Bytes bypass the allow check. This file's older rule refused every non-string
// on the grounds that "bytes/thunks are never param-supplied"; that stopped
// being true when the panel gained a drop target. The replacement rule is
// sound and is the same one image-source.js states: an ArrayBuffer in params
// definitionally did not arrive via a shared link, because a URL cannot carry
// megabytes — so it can only have been placed there by the host's own panel,
// which is trusted code.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const FONT_ALLOW_DEFAULT = ["https"];

// The "unset" font source. An empty value declares NO font — the documented way
// to opt out of a typeface, after which text2d falls back to the bundled Roboto.
// It is never a source to fetch, and never a source to refuse: fontSourceAllowed
// rejects "" under every allow list (new URL("") throws), so a site that forgets
// this reads "unset" as "disallowed" and warns on every build of a part whose
// font control is simply blank. Spelled once here because three sites have to
// agree on it — the allow check, the pre-resolve filter, and lint's default
// check — and the two bugs this rule has already caused were both a site that
// had drifted from the others.
export const isNoFontSource = (v) => v === undefined || v === null || v === "";

const GSTATIC_HOST = "fonts.gstatic.com";
const ASSET_SCHEME = "pfc-asset:";

const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function fontSourceAllowed(source, allow = FONT_ALLOW_DEFAULT) {
  if (isBytes(source)) return true; // see the file header — bytes always bypass the allow check
  if (typeof source !== "string") return false;
  const u = parse(source);
  if (!u) return false;
  for (const kind of allow) {
    // hostname, not host or a suffix test: `fonts.gstatic.com.evil.test` must
    // not pass, and neither must a userinfo trick like `https://fonts.gstatic.com@evil.test/`
    // (URL parsing puts `evil.test` in hostname, which is exactly why this
    // compares the parsed hostname rather than the raw string).
    if (kind === "gstatic" && u.protocol === "https:" && u.hostname === GSTATIC_HOST) return true;
    if (kind === "https" && u.protocol === "https:") return true;
    if (kind === "asset" && u.protocol === ASSET_SCHEME) return true;
  }
  return false;
}

// paramKey → allow list, for every `type: "font"` control in the authored tree —
// new-shape (`controls`, including nested `group`s) AND legacy-shape
// (`advanced`/`toggles`/`features`, where panel/legacy.js desugars a
// descriptor's `control:` field to `type:` — see legacy.js's `toControl`).
// Missing the legacy arrays here would leave a `{key, control:"font"}`
// descriptor with no entry in the returned map, and jobs.js's check only
// looks at keys present in the map — so a legacy-declared font control would
// get silently unrestricted. Walk is deliberately tolerant of any of these
// arrays being absent or malformed; it must never throw on an existing part.
export function fontControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (Array.isArray(n.advanced)) visit(n.advanced);
      if (Array.isArray(n.toggles)) visit(n.toggles);
      if (Array.isArray(n.features)) visit(n.features);
      if ((n.type === "font" || n.control === "font") && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : FONT_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
