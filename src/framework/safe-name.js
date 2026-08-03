// One hardened slug for every part-derived string that ends up as a filename, a
// path segment, or a zip entry name.
//
// A PartDefinition is DATA, not trusted developer source: downstream hosts
// (partforge-cloud) run LLM-generated and user-supplied parts, so `meta.title`,
// `views[k].label` and `parts[x].export.name` are untrusted input. A title of
// "../../.ssh/authorized" must not steer a render write out of its output
// directory, and a zip entry must not carry a separator that a naive extractor
// would honour (zip-slip).
//
// Deliberately DOM-free and free of `node:` builtins: the geometry worker, the
// browser shell and the headless testing tree all import this.

// Lowercase, reduce to [a-z0-9._-], collapse runs, and refuse to start with a
// dot or dash — that is what kills ".." and dotfiles at the same time. Anything
// that sanitizes away to nothing (a title that is entirely CJK or emoji, or the
// empty string) yields `fallback`, so callers never build a name-less path.
export function safeName(s, fallback = "part") {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return out || fallback;
}
