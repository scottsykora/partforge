// Resolve a part's declared `vectors` ({ name: source }) to internal regions before
// the synchronous build — the vector-art sibling of fonts.js and imports.js:
// same source grammar and identity-memoization rule, built on the shared core in
// asset-resolve.js. The source resolves to JSON in the partforge-vector format,
// not to SVG; conversion happened once, in a browser, at ingest.
//
// No content digest, deliberately. It looks like a missing piece next to
// imports.js and is not: k.vector2d lowers to k.shape2d(regions) and the Shape2D
// hash keys on the actual coordinates, so different artwork gives a different
// cache entry automatically. Imports need a digest because a Solid master is
// registered by NAME and is opaque to that hash; parsed regions are not. Same
// argument kernel-front.js:117-121 records for text2d.
//
// DOM-free and node:-free.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { toInternalDocument } from "./geometry/vector-format.js";

const cache = new Map();   // source → Promise<Uint8Array> (raw bytes)
// source → { units, shapes }. The bytes memo above stops a refetch; this stops a re-PARSE
// (UTF-8 decode + JSON.parse + validation + a bbox recomputation that tessellates
// every contour). Without it every regen of a part with artwork redoes all of that.
// Fonts solve the same problem with kernel._fontsBySource (jobs.js:206-212) and
// imports with a digest comparison; this is the third pipeline's version of it.
// Keyed on the SOURCE, not the name: one worker outlives many parts, and a name is
// not an identity. Only successes are cached — a parse failure must throw again
// under the next name that declares it, with that name in the message.
const parsed = new Map();

function parseDocument(bytes, label) {
  let text;
  try { text = new TextDecoder().decode(bytes); }
  catch { throw new Error(`vector2d: "${label}" could not be decoded as UTF-8 text`); }
  let doc;
  try { doc = JSON.parse(text); }
  catch (e) {
    throw new Error(`vector2d: "${label}" is not valid JSON — ${e.message}. `
      + "A vectors source is an ingested partforge-vector file, not an .svg file; see docs/VECTOR-FORMAT.md");
  }
  return toInternalDocument(doc, label);
}

// The resolver memoizes by source identity and cannot see the declared name, so
// the name is bound per declaration below rather than baked into the resolver.
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => bytes,
  "resolveVectors: a vector source must be bytes, a URL, or a thunk returning one",
);

export async function resolveVectors(vectorsDecl) {
  // A function reaching here means a caller passed `part.vectors` raw, the way
  // fonts.js's resolveFonts guards against the same mistake for `part.fonts`.
  // `Object.entries` on a function is `[]`, not a thrown error, so without
  // this check a function-valued `vectors` would silently resolve to an empty
  // map and only surface much later as `vector2d: unknown vector "…"` — a name a
  // part author declared correctly, that k.vector2d insists doesn't exist. No
  // part currently declares `vectors` as a function (unlike fonts, which a
  // `type: "font"` control already drives this way) — this exists so the
  // day that form is added, it fails loudly instead of silently.
  if (typeof vectorsDecl === "function") {
    throw new Error("resolveVectors: `vectors` is a function — it is not resolved against params yet; pass the plain object form");
  }
  const raw = await resolveDecl(vectorsDecl, resolveOne);
  const out = new Map();
  for (const [name, bytes] of raw) {
    let doc = parsed.get(bytes);
    if (!doc) { doc = parseDocument(bytes, name); parsed.set(bytes, doc); }
    out.set(name, doc);
  }
  return out;
}

// Register a part's vectors on a booted kernel. Called in the async phase before
// every job's synchronous build — worker (jobs.js) and Node boots alike.
export async function ensureVectors(kernel, vectorsDecl) {
  if (!kernel?._vectors) return;
  const declared = vectorsDecl ?? {};
  for (const [name, doc] of await resolveVectors(declared)) kernel._vectors.set(name, doc);
  // Drop names this declaration does not supply. `_vectors` is the kernel's and the
  // kernel outlives the job (worker-rebind, many parts), so without this a name
  // from a previous part stays resolvable — the stale-registration bug jobs.js's
  // font prune exists to prevent.
  for (const name of [...kernel._vectors.keys()]) {
    if (!Object.hasOwn(declared, name)) kernel._vectors.delete(name);
  }
}
