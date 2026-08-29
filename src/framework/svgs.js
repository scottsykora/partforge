// Resolve a part's declared `svgs` ({ name: source }) to internal regions before
// the synchronous build — the vector-art sibling of fonts.js and imports.js:
// same source grammar and identity-memoization rule, built on the shared core in
// asset-resolve.js. The source resolves to JSON in the partforge-vector format,
// not to SVG; conversion happened once, in a browser, at ingest.
//
// No content digest, deliberately. It looks like a missing piece next to
// imports.js and is not: k.svg2d lowers to k.shape2d(regions) and the Shape2D
// hash keys on the actual coordinates, so different artwork gives a different
// cache entry automatically. Imports need a digest because a Solid master is
// registered by NAME and is opaque to that hash; parsed regions are not. Same
// argument kernel-front.js:117-121 records for text2d.
//
// DOM-free and node:-free.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { toInternalRegions } from "./geometry/vector-format.js";

const cache = new Map();   // source → Promise<Region[]>

function parseDocument(bytes, label) {
  let text;
  try { text = new TextDecoder().decode(bytes); }
  catch { throw new Error(`svg2d: "${label}" could not be decoded as UTF-8 text`); }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) {
    throw new Error(`svg2d: "${label}" is not valid JSON — ${e.message}. `
      + "An svgs source is an ingested partforge-vector file, not an .svg file; see docs/VECTOR-FORMAT.md");
  }
  return toInternalRegions(doc, label);
}

// The resolver memoizes by source identity and cannot see the declared name, so
// the name is bound per declaration below rather than baked into the resolver.
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => bytes,
  "resolveSvgs: an svg source must be bytes, a URL, or a thunk returning one",
);

export async function resolveSvgs(svgsDecl) {
  const raw = await resolveDecl(svgsDecl, resolveOne);
  const out = new Map();
  for (const [name, bytes] of raw) out.set(name, parseDocument(bytes, name));
  return out;
}

// Register a part's svgs on a booted kernel. Called in the async phase before
// every job's synchronous build — worker (jobs.js) and Node boots alike.
export async function ensureSvgs(kernel, svgsDecl) {
  if (!kernel?._svgs) return;
  const declared = svgsDecl ?? {};
  for (const [name, regions] of await resolveSvgs(declared)) kernel._svgs.set(name, regions);
  // Drop names this declaration does not supply. `_svgs` is the kernel's and the
  // kernel outlives the job (worker-rebind, many parts), so without this a name
  // from a previous part stays resolvable — the stale-registration bug jobs.js's
  // font prune exists to prevent.
  for (const name of [...kernel._svgs.keys()]) {
    if (!Object.hasOwn(declared, name)) kernel._svgs.delete(name);
  }
}
