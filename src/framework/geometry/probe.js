// Geometry-free backend detection. A probe kernel records every op a part's
// build() invokes (returning chainable no-op proxies, dummy values for queries);
// if an OCCT-only op was used, the part needs the OCCT backend.
export const OCCT_ONLY = new Set(["fillet", "chamfer", "shell"]);

export function createProbeKernel() {
  const used = new Set();
  const note = (name) => used.add(name);
  const proxy = {
    cut() { note("cut"); return proxy; },
    cutAll() { note("cutAll"); return proxy; },
    intersect() { note("intersect"); return proxy; },
    clone() { note("clone"); return proxy; },
    boundingBox() { note("boundingBox"); return { min: [0, 0, 0], max: [1, 1, 1], center: [0.5, 0.5, 0.5], size: [1, 1, 1] }; },
    translate() { note("translate"); return proxy; },
    rotate() { note("rotate"); return proxy; },
    mirror() { note("mirror"); return proxy; },
    scale() { note("scale"); return proxy; },
    fillet() { note("fillet"); return proxy; },
    chamfer() { note("chamfer"); return proxy; },
    shell() { note("shell"); return proxy; },
    volume() { note("volume"); return 1; },
    toMesh() { note("toMesh"); return { positions: new Float32Array(9), normals: new Float32Array(9), triangles: 1, edges: new Float32Array(0) }; },
    toSTL() { note("toSTL"); return new ArrayBuffer(0); },
    toIndexedMesh() { note("toIndexedMesh"); return { positions: new Float32Array(9), indices: new Uint32Array(3) }; },
  };
  const kernel = {
    cylinder() { note("cylinder"); return proxy; },
    sphere() { note("sphere"); return proxy; },
    box() { note("box"); return proxy; },
    prism() { note("prism"); return proxy; },
    revolve() { note("revolve"); return proxy; },
    helixSweptTube() { note("helixSweptTube"); return proxy; },
    union() { note("union"); return proxy; },
    toSTEP() { note("toSTEP"); return Promise.resolve(new ArrayBuffer(0)); },
    cleanup() {},
  };
  return { kernel, used };
}

export function detectBackend(part, params = {}) {
  if (part.meta?.backend) return part.meta.backend;
  const p = { ...part.defaults, ...params };
  const d = part.derive ? part.derive(p) : {};
  const { kernel, used } = createProbeKernel();
  for (const name of Object.keys(part.parts)) {
    try { part.parts[name].build(kernel, p, d); } catch { /* probe miss → capability backstop covers it */ }
  }
  for (const op of used) if (OCCT_ONLY.has(op)) return "occt";
  return "manifold";
}
