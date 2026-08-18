// opentype.js 2.x ships no `exports` map, so what importing it yields splits by
// resolver: bundlers take the `module` field (real ESM — named `parse`, NO
// default export), while Node takes `main` (a UMD/CJS bundle whose named exports
// Node's lexer cannot statically detect — the namespace holds ONLY `default`).
// Reading `.default` unconditionally is therefore correct under Node and
// `undefined` in every browser bundle; reading a named export is the reverse.
// That asymmetry once broke headless text2d builds (kernel-front's static
// import) and later broke every BROWSER build of a part declaring `fonts`
// ("undefined is not an object (evaluating 'p.parse')") while headless tests
// stayed green (jobs' dynamic import). Both call sites normalize through this
// one function so the two interop shapes stay handled in one place.
export const normalizeOpentype = (ns) =>
  typeof ns?.parse === "function" ? ns : (ns?.default ?? ns);

// Parse font bytes into an opentype.Font, turning opentype.js's own low-level parse
// failures into a NAMED, actionable error. A single unreadable font in a part's `fonts`
// map otherwise kills the whole build with a message that names neither the font nor the
// fix — a RangeError deep in the TrueType reader, or opentype.js's raw "WOFF2 require an
// external decompressor library" URL — and the part just "won't build" with no clue which
// font or why. This is the exact dead end a variable font or a WOFF/WOFF2 upload lands in:
// opentype.js 2.x reads neither, so the guidance is always the same (supply a static TTF or
// OTF). `label` is the declared font name where one is known (the `fonts` map key), and is
// omitted for an inline-bytes font, which has no name to give. All parse sites route through
// here so the message stays in one place.
export function parseFont(opentype, buf, label) {
  try {
    return opentype.parse(buf);
  } catch (err) {
    const who = label ? `font "${label}"` : "an inline font";
    throw new Error(
      `text2d: ${who} could not be read as a TTF or OTF — a variable font or a WOFF/WOFF2 ` +
      `file will fail here; supply a static TTF or OTF instead. (${err?.message ?? err})`,
    );
  }
}
