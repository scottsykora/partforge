// src/framework/geometry/op-options.js
// The options-object calling convention: pure normalizers turning each op's
// canonical options form into the backend's positional argument list, plus the
// detection predicate. Normative rule (KERNEL-CONTRACT.md "Calling convention"):
// a call is options form when the op receives exactly one plain-object argument.
// kernel-front.js and solid-sugar.js apply these at the backend-shared seams, so
// backends stay positional and the Manifold solid cache hashes normalized args —
// both spellings of a call share one cache entry. Geometry-free by design.

export function isPlainOptions(x) {
  if (x === null || typeof x !== "object") return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// Small capped Levenshtein for did-you-mean hints (distance > 2 reads as "no").
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Prefix match first so long-form names hit their short key (radius→r,
// height→h, diameter→d), then edit distance ≤ 2 for plain typos.
function suggest(key, valid) {
  const lk = key.toLowerCase();
  for (const v of valid) if (lk.startsWith(v.toLowerCase())) return v;
  for (const v of valid) if (editDistance(lk, v.toLowerCase()) <= 2) return v;
  return null;
}

function checkKeys(op, o, valid) {
  for (const key of Object.keys(o)) {
    if (valid.includes(key)) continue;
    const hint = suggest(key, valid);
    throw new Error(`${op}: unknown option ${JSON.stringify(key)}${
      hint ? ` — did you mean ${hint}?` : ` (valid: ${valid.join(", ")})`}`);
  }
}

function req(op, o, key) {
  if (o[key] === undefined) throw new Error(`${op}: ${key} is required`);
  return o[key];
}

// Trailing positional opts object, only if any of `keys` is present — an empty
// options tail must normalize to *no* argument so it hashes identically to the
// bare positional call.
function tail(o, keys) {
  const t = {};
  let any = false;
  for (const key of keys) if (o[key] !== undefined) { t[key] = o[key]; any = true; }
  return any ? [t] : [];
}

export function cylinderArgs(o) {
  checkKeys("cylinder", o, ["r", "d", "r1", "r2", "d1", "d2", "h", "center"]);
  const has = (key) => o[key] !== undefined;
  const straight = has("r") + has("d");
  const coneR = has("r1") + has("r2");
  const coneD = has("d1") + has("d2");
  let rBottom, rTop;
  if (straight === 1 && coneR + coneD === 0) rBottom = rTop = has("r") ? o.r : o.d / 2;
  else if (straight === 0 && coneR === 2 && coneD === 0) { rBottom = o.r1; rTop = o.r2; }
  else if (straight === 0 && coneR === 0 && coneD === 2) { rBottom = o.d1 / 2; rTop = o.d2 / 2; }
  else throw new Error("cylinder: pass exactly one of r/d, or r1+r2 / d1+d2");
  return [rBottom, rTop, req("cylinder", o, "h"), ...tail(o, ["center"])];
}

export function sphereArgs(o) {
  checkKeys("sphere", o, ["r", "d"]);
  const hasR = o.r !== undefined;
  if (hasR === (o.d !== undefined)) throw new Error("sphere: pass exactly one of r/d");
  return [hasR ? o.r : o.d / 2];
}

export function boxArgs(o) {
  checkKeys("box", o, ["size", "center", "min", "max"]);
  if (o.min !== undefined || o.max !== undefined) {
    if (o.size !== undefined || o.center !== undefined)
      throw new Error("box: pass size or min+max, not both");
    return [req("box", o, "min"), req("box", o, "max")];
  }
  const [x, y, z] = req("box", o, "size");
  return o.center === true
    ? [[-x / 2, -y / 2, -z / 2], [x / 2, y / 2, z / 2]]   // centered on all axes
    : [[-x / 2, -y / 2, 0], [x / 2, y / 2, z]];           // canonical: centered X/Y, base at z=0
}
