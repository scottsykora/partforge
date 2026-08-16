// Resolve a part's declared `fonts` ({ name: source }) to ArrayBuffers, before the
// synchronous build. A source is: an ArrayBuffer/Uint8Array (bytes), a URL string
// or `URL` instance (fetched — a Vite `import('./x.ttf')` yields { default: url }),
// or a thunk returning any of those (possibly async). Memoized process-wide by
// source so repeated builds don't refetch. DOM-free (uses global fetch, present in
// workers). Built on the shared resolution core in asset-resolve.js.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";

const cache = new Map(); // source (string|object) → Promise<ArrayBuffer>
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => bytes,
  "resolveFonts: a font source must be bytes, a URL, or a thunk returning one",
);

export async function resolveFonts(fontsDecl) {
  return resolveDecl(fontsDecl, resolveOne);
}
