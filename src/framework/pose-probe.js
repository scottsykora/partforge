// Geometry-free pose probe: run a subpart's build()+place() against a stub kernel
// whose token solids carry (a) a content-hash chain built with the shared h() and
// (b) pending rigid pose steps, mirroring the backends' pose-lazy bookkeeping.
// The fast path compares probe results ACROSS PARAM CHANGES ONLY — probe hashes
// are never compared to backend hashes, so they only need to be stable and to
// fold every geometry-affecting argument.
//
// Trust model: any query op (boundingBox/volume/…) during a build marks that
// subpart untrusted — a query result could feed geometry OR pose, and the probe
// returns dummies, so neither hash stability nor pose values can be believed.
// A FUNCTION passed as (or nested inside) an op argument is untrusted for the
// same reason the OCCT backend refuses to hash function selectors (see `selKey`
// in occt-backend.js): a closure like `(e) => e.inDirection([0,0,p.z])` has the
// same source text at every value of `p.z`, so hashing it would hold baseHash
// stable while the real geometry changed — precisely the false-positive the fast
// path must never make. Untrusted subparts simply take the normal regen path.
import { h } from "./geometry/solid-hash.js";
import { addSugar } from "./geometry/solid-sugar.js";
import { SOLID_OPS, SOLID_OPTIONAL_OPS, SHAPE2D_OPS, OCCT_ONLY_OPS } from "./geometry/kernel.js";
import { MAX_PROBE_OPS, ProbeRunawayError } from "./geometry/probe.js";
import { viewSubParts, resolveParams } from "./part-model.js";

const NAN3 = () => [NaN, NaN, NaN];

function makeProbeSession() {
  const state = { count: 0, queried: false, unhashable: false };
  const tick = () => { if (++state.count > MAX_PROBE_OPS) throw new ProbeRunawayError(`pose probe exceeded ${MAX_PROBE_OPS} ops`); };

  // Queries return dummies AND poison trust (see module comment).
  const QUERY_DUMMIES = {
    boundingBox: () => ({ min: NAN3(), max: NAN3() }), // addSugar derives center/size
    volume: () => NaN,
    genus: () => NaN,
    isEmpty: () => false,
    area: () => NaN,
    toRegions: () => [],
    simple: () => ({ outer: [[NaN, NaN]], holes: [] }),
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(0), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };

  // Operand tokens fold into a hash key by their own (pose-folded) hash; plain
  // data canonicalizes via h(). Functions can't be hashed at all (see the module
  // comment), so they poison trust AND get a per-call unique key — belt and
  // braces, so the hash can't collide even before the trust check is consulted.
  //
  // The walk mirrors h()'s `canon` exactly (array → elements, other object → own
  // enumerable values), because a function nested inside an options object —
  // `fillet({ r, edges: (e) => … })`, the normal calling convention — is reached
  // by canon, not by the top-level argument check.
  let unhashable = 0;
  const argKey = (a) => {
    if (a && a.__poseToken) return a.__folded();
    if (typeof a === "function") { state.unhashable = true; return `fn#${unhashable++}`; }
    if (Array.isArray(a)) return a.map(argKey);
    if (a && typeof a === "object") return Object.fromEntries(Object.keys(a).map((k) => [k, argKey(a[k])]));
    return a;
  };

  function token(hash, pose) {
    const folded = () => (pose.length ? h("posed", hash, pose) : hash);
    const foldOp = (op) => (...args) => { tick(); return token(h(op, folded(), ...args.map(argKey)), []); };
    const t = {
      __poseToken: true,
      __folded: folded,
      _hash: hash,
      _pose: pose,
      // The rigid vocabulary stays out of the hash: recorded as pending steps,
      // exactly like the OCCT backend's pose-lazy wrap. All transform sugar
      // (rotateAbout/along/at/rotateX…) composes onto these via addSugar.
      translate: (v) => { tick(); return token(hash, [...pose, { t: "translate", v }]); },
      rotate: (deg, center, axis) => { tick(); return token(hash, [...pose, { t: "rotate", deg, center, axis }]); },
      clone: () => t, // tokens are immutable — sharing is safe
      // regions() is a data-returning query in disguise: on a real backend the
      // scission ARRAY LENGTH is param-dependent data, so a build branching on
      // `regions().length` could hold baseHash stable while geometry changed.
      // It therefore poisons trust like any other query; the single token is
      // still returned so op chains on regions()[0] don't crash mid-probe.
      regions: () => { tick(); state.queried = true; return [token(h("regions", folded()), [])]; },
    };
    for (const [op, dummy] of Object.entries(QUERY_DUMMIES))
      t[op] = (...a) => { tick(); state.queried = true; return dummy(...a); };
    // Every other contract op folds pose + args into a fresh hash. Generated from
    // the kernel-contract lists so new ops can never silently drift out of the probe.
    for (const op of [...SOLID_OPS, ...SOLID_OPTIONAL_OPS, ...SHAPE2D_OPS, ...OCCT_ONLY_OPS])
      t[op] ??= foldOp(op);
    return addSugar(t);
  }

  // Kernel: catch-all factory — any op makes a fresh token hashed from its args.
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {}, beginSubPart: () => {}, endSubPart: () => {},
    cacheStats: () => ({ hits: 0, misses: 0 }), resetCacheStats: () => {},
  };
  const ignore = (key) => typeof key !== "string" || key === "then" || key === "toJSON" || key[0] === "_";
  const kernel = new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in kernelQueries) return kernelQueries[key];
      return (...args) => { tick(); return token(h(key, ...args.map(argKey)), []); };
    },
  });

  return { kernel, state };
}

const finiteVec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const stepsFinite = (steps) => steps.every((st) =>
  st.t === "translate"
    ? finiteVec(st.v)
    : Number.isFinite(st.deg) && finiteVec(st.center) && finiteVec(st.axis));

// Probe every subpart the view shows. Never throws; a failing/queried/weird
// subpart yields { trusted: false } and the others still probe.
export function probePoses(part, view, params) {
  const out = new Map();
  let resolved;
  try { resolved = resolveParams(part, params); }
  catch {
    for (const name of viewSubParts(part, view, params)) out.set(name, { trusted: false });
    return out;
  }
  const { p, d } = resolved;
  for (const name of viewSubParts(part, view, params)) {
    try {
      const { kernel, state } = makeProbeSession(); // fresh op budget + trust per subpart
      const sp = part.parts[name];
      let s = sp.build(kernel, p, d);
      if (sp.place) s = sp.place(s, { view, purpose: "display", p, d });
      const ok = s && s.__poseToken && !state.queried && !state.unhashable && stepsFinite(s._pose);
      out.set(name, ok ? { baseHash: s._hash, pose: s._pose, trusted: true } : { trusted: false });
    } catch {
      out.set(name, { trusted: false });
    }
  }
  return out;
}
