// Shared source-resolution core for fonts.js and imports.js. Both resolve a
// part's declared `{ name: source }` map before the synchronous build, where a
// source is: an ArrayBuffer/typed-array view (bytes), a URL string, a `URL`
// instance (fetched), or a thunk (possibly async) returning any of those —
// including the `{ default: … }` shape a Vite dynamic `import('./x.ttf')`
// yields. The two callers differ only in what they do with the resolved bytes
// (fonts keep the raw ArrayBuffer; imports also stamp a digest + format), so
// each owns its own cache Map and result shape; this module owns just the
// source→bytes grammar and the identity-memoization rule (a source, e.g. a
// thunk, is content-stable for a session — resolve it once). DOM-free and
// node:-free so it stays safe in the geometry worker's import closure.

export function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  // A view may not span its whole backing buffer — slice to its exact range (Node
  // Buffer pooling makes byteOffset>0 common for small files; v.buffer alone would
  // be garbage).
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  return null;
}

// Build a memoized `resolveOne(source)` for one caller. `finish(bytes, value,
// source)` turns the resolved bytes into that caller's result shape (may be
// async); `errorMessage` is thrown when `source` doesn't match the grammar.
// Results are cached on the caller-supplied `cache` Map, keyed by source
// identity, so a repeated declaration resolves (and fetches) only once.
export function makeAssetResolver(cache, finish, errorMessage) {
  return function resolveOne(source) {
    if (cache.has(source)) return cache.get(source);
    const p = (async () => {
      let v = source;
      if (typeof v === "function") v = await v();
      if (v && typeof v === "object" && "default" in v && !toBuffer(v) && !(v instanceof URL)) v = v.default; // dynamic-import module
      let bytes = toBuffer(v);
      if (!bytes) {
        if (v instanceof URL || typeof v === "string") bytes = await (await fetch(v)).arrayBuffer();
        else throw new Error(errorMessage);
      }
      return finish(bytes, v, source);
    })();
    cache.set(source, p);
    return p;
  };
}

// Resolve a `{ name: source }` declaration to `Map<name, result>` using a
// `resolveOne` built by `makeAssetResolver`.
export async function resolveDecl(decl, resolveOne) {
  const out = new Map();
  if (!decl) return out;
  await Promise.all(Object.entries(decl).map(async ([name, src]) => out.set(name, await resolveOne(src))));
  return out;
}
