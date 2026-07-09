// Geometry-free backend detection. A probe kernel records every op a part's
// build() invokes (returning chainable no-op proxies, dummy values for queries);
// if an OCCT-only op was used, the part needs the OCCT backend. The op list lives
// in kernel.js — the same list generates the Manifold backend's throwing stubs.
import { OCCT_ONLY_OPS } from "./kernel.js";
import { resolveDerived } from "../derive.js";

const OCCT_ONLY = new Set(OCCT_ONLY_OPS);

export function createProbeKernel() {
  const used = new Set();
  const note = (name) => used.add(name);

  // Catch-all proxies: any method records its name and returns the chainable solid
  // proxy, EXCEPT the queries below, which return realistic dummy values the build may
  // read. Using a Proxy (rather than a hand-listed allowlist) means new kernel/solid
  // methods never have to be mirrored here — the probe can't drift out of sync with the
  // real backends. (That drift previously broke the panel's relevance dimming/hiding when
  // the build-step vocabulary was added but not taught to the probe.)
  const solidQueries = {
    boundingBox: () => ({ min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }),
    volume: () => 1,
    toMesh: () => ({ positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }),
    toSTL: () => new ArrayBuffer(0),
    toIndexedMesh: () => ({ positions: new Float32Array(9), indices: new Uint32Array(3) }),
  };
  const kernelQueries = {
    toSTEP: () => Promise.resolve(new ArrayBuffer(0)),
    cleanup: () => {},
  };

  // `ignore` keeps the proxy from masquerading as a thenable/internal handle: symbols,
  // `then` (so it's never await-unwrapped), and `_`-prefixed internals resolve to
  // undefined rather than a chainable op.
  const ignore = (key) => typeof key !== "string" || key === "then" || key[0] === "_";

  const opProxy = (queries) => new Proxy({}, {
    get(_t, key) {
      if (ignore(key)) return undefined;
      if (key in queries) return queries[key];
      return (..._args) => { note(key); return proxy; };
    },
  });

  const proxy = opProxy(solidQueries);   // a solid handle: every op chains back to itself
  const kernel = opProxy(kernelQueries); // factory ops (cylinder/box/prism/…) return a solid
  return { kernel, used };
}

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  const d = resolveDerived(part, p);
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
