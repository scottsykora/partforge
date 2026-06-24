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

function fnv(s) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}
