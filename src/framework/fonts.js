// Resolve a part's declared `fonts` ({ name: source }) to ArrayBuffers, before the
// synchronous build. A source is: an ArrayBuffer/Uint8Array (bytes), a URL string
// (fetched — a Vite `import('./x.ttf')` yields { default: url }), or a thunk
// returning any of those (possibly async). Memoized process-wide by source so
// repeated builds don't refetch. DOM-free (uses global fetch, present in workers).
const cache = new Map(); // source (string|object) → Promise<ArrayBuffer>

function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer;
  return null;
}

async function resolveOne(source) {
  if (cache.has(source)) return cache.get(source);
  const p = (async () => {
    let v = source;
    if (typeof v === "function") v = await v();
    if (v && typeof v === "object" && "default" in v && !toBuffer(v)) v = v.default; // dynamic-import module
    const buf = toBuffer(v);
    if (buf) return buf;
    if (typeof v === "string") return await (await fetch(v)).arrayBuffer();
    throw new Error("resolveFonts: a font source must be bytes, a URL string, or a thunk returning one");
  })();
  cache.set(source, p);
  return p;
}

export async function resolveFonts(fontsDecl) {
  const out = new Map();
  if (!fontsDecl) return out;
  await Promise.all(Object.entries(fontsDecl).map(async ([name, src]) => out.set(name, await resolveOne(src))));
  return out;
}
