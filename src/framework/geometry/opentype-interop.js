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
