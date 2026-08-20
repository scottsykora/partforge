// What a PARAM-supplied font source may be. Author-declared `fonts` sources are
// code and get no restriction (see the design doc §4); this file exists only
// for the other case — a value that arrived in `params`, which on a shared link
// is attacker-controlled text that would otherwise become a fetch URL.
//
// DOM-free and node:-free: jobs.js (worker graph) and the panel both import it.

export const FONT_ALLOW_DEFAULT = ["https"];

const GSTATIC_HOST = "fonts.gstatic.com";
const ASSET_SCHEME = "pfc-asset:";

// Parse once; an unparseable string is refused rather than guessed at.
function parse(source) {
  try { return new URL(source); } catch { return null; }
}

export function fontSourceAllowed(source, allow = FONT_ALLOW_DEFAULT) {
  if (typeof source !== "string") return false;   // bytes/thunks are never param-supplied
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

// paramKey → allow list, for every `type: "font"` control in the authored tree.
// Walks sections and nested groups; deliberately tolerant of the legacy section
// shapes (advanced/toggles/features), which have no font controls but must not
// throw the walk.
export function fontControlAllows(part) {
  const out = new Map();
  const visit = (nodes) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.controls)) visit(n.controls);
      if (n.type === "font" && typeof n.key === "string") {
        out.set(n.key, Array.isArray(n.allow) && n.allow.length ? n.allow : FONT_ALLOW_DEFAULT);
      }
    }
  };
  visit(part?.parameters);
  return out;
}
