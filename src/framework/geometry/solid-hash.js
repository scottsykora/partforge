// Stable content hash for cached solids. Serializes scalar args canonically and
// folds via FNV-1a → base36. Solid operands are passed as their own (already
// computed) short `_hash` string, so composing two solids stays O(1) and the
// resulting key length stays bounded no matter how deep the build graph is.
export function h(...parts) {
  return fnv(parts.map(canon).join("|"));
}

function canon(x) {
  if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
  if (x && typeof x === "object") return "{" + Object.keys(x).sort().map((k) => k + ":" + canon(x[k])).join(",") + "}";
  return String(x);
}

// FNV-1a folded to 32-bit space (collision risk acceptable: retained only for one
// sub-part's build graph ~3–15 nodes, rebuilt each round, no accumulation).
function fnv(s) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}

// ── byte-aware JSON.stringify support ───────────────────────────────────────
// A shared home for param-deps.js's relevanceHash and backend-select.js's
// reroute-latch snapshot, neither of which should import the other's
// concerns. Both wholesale-hash a params object with JSON.stringify, and a
// byte-valued param — an ArrayBuffer or a typed-array/DataView view, the
// shape a param-supplied image takes on the partforge-cloud sandbox path
// (that sandbox cannot fetch URLs, so a PNG's bytes go straight into a
// param) — breaks JSON.stringify's default handling two different ways: an
// ArrayBuffer has no enumerable own properties, so it always serializes as
// the same "{}" regardless of content (two different images collide on one
// cache/route key); a typed-array VIEW goes the other way, expanding to one
// JSON number per byte (tens of thousands of characters for a small PNG, on
// every hash). `byteAwareReplacer` is a JSON.stringify replacer — pass it as
// the second argument — that substitutes a stable FNV-1a content fingerprint
// for either shape instead.
//
// Memoized per buffer/view IDENTITY (not content) in a WeakMap, mirroring
// kernel-front.js's byteCache: the params object these callers hash is
// mutated in place and re-hashed on every regen (mesh-cache.js's hashFor, a
// backend-select reroute check), so re-walking megabytes of image bytes on
// every slider tick that touches some OTHER param would be its own
// regression. A given buffer is fingerprinted once and the string reused for
// as long as that identity survives.
const byteFingerprints = new WeakMap(); // ArrayBuffer|ArrayBufferView -> fingerprint string

// FNV-1a over raw bytes directly (not via fnv(), which takes a JS string and
// reads it with charCodeAt — spreading a multi-megabyte Uint8Array into a
// string first would blow the engine's call-stack argument limit long before
// a real image gets there).
function fnvBytes(u8) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) { hsh ^= u8[i]; hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}

function fingerprintBytes(value) {
  let cached = byteFingerprints.get(value);
  if (cached !== undefined) return cached;
  const u8 = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  // "bytes:" prefix plus the raw byte length folded in alongside the 32-bit
  // FNV-1a digest — fnv()/fnvBytes() alone is a 32-bit hash, and a
  // same-length collision is the case worth making strictly harder to hit by
  // accident on top of it. No ordinary control value is a string shaped
  // exactly like this (the panel's own control types are
  // numbers/booleans/strings/enums), so this fingerprint only ever competes
  // with OTHER buffers' fingerprints, not a genuine string param's value.
  cached = `bytes:${fnvBytes(u8)}:${u8.length}`;
  byteFingerprints.set(value, cached);
  return cached;
}

export function byteAwareReplacer(_key, value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return fingerprintBytes(value);
  return value;
}
