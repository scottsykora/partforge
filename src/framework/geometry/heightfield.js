// Pure grid → triangle mesh for k.heightfield. Backend-agnostic by design: it
// returns plain {positions, indices} that Manifold takes via manifoldFromMesh
// and OCCT takes via meshToStl → importSTL, so both backends build from
// byte-identical triangle data. DOM-free and node:-free (worker graph).
//
// fanCap is reused verbatim from mesh-build.js (it takes a ringStart). sideQuads
// is NOT reusable here: it derives ring bases as i*ringSegs, which assumes rings
// start at V[0], and our vertex array leads with the grid. The skirt is the
// explicit loop below.
import { fanCap } from "./mesh-build.js";

// Ceiling on grid vertices, so an ambitious pitch degrades instead of hanging.
export const HEIGHTFIELD_VERTEX_BUDGET = 400000;

const U16 = 65535;

// FNV-1a over a Uint16Array's raw sample values — same fold as solid-hash.js's `h`,
// but a dedicated loop: `h`'s generic `canon()` treats a typed array as a plain
// object (Object.keys on it), which works but is wasteful for a heightfield grid
// that may hold up to HEIGHTFIELD_VERTEX_BUDGET samples. Used only to give an
// UNCACHED inline heightfield grid a real content fingerprint in its solid's own
// `_hash`, so composing it with another op afterward (union/cut) doesn't inherit
// the same "two different things, one key" collision risk the cache bypass exists
// to avoid. Lives here, beside the grid contract itself, so BOTH backends
// fingerprint an inline grid the same way (it started out module-local in
// manifold-backend.js; the OCCT backend needs the identical bypass).
export function hashGridData(data) {
  let hsh = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) { hsh ^= data[i]; hsh = Math.imul(hsh, 0x01000193); }
  return (hsh >>> 0).toString(36);
}

// Bilinear sample of a row-major Uint16 grid. u/v in 0..1 → 0..1.
export function sampleGrid(grid, u, v) {
  const { width: W, height: H, data } = grid;
  const x = Math.min(Math.max(u, 0), 1) * (W - 1);
  const y = Math.min(Math.max(v, 0), 1) * (H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * W + x0], b = data[y0 * W + x1];
  const c = data[y1 * W + x0], d = data[y1 * W + x1];
  return ((a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy) / U16;
}

export function heightfieldMesh(grid, opts = {}) {
  const { w, d, base = 1, maxZ = 1, invert = false, range = [0, 1], origin = "center" } = opts;
  let { pitch = 0.5 } = opts;
  const warnings = [];

  if (!(w > 0) || !(d > 0)) throw new Error("heightfield: w and d must be positive");
  if (!(base > 0)) throw new Error("heightfield: base must be > 0 (a zero base is degenerate)");
  if (!(pitch > 0)) throw new Error("heightfield: pitch must be > 0");

  // Floor of 2 samples per axis: X()/Y()/Z() divide by (nx-1)/(ny-1) to map
  // sample indices to 0..1, so nx or ny === 1 would divide by zero. 2 is also
  // the minimum for a meaningful grid (one quad).
  const count = (len, p) => Math.max(2, Math.ceil(len / p));
  let nx = count(w, pitch), ny = count(d, pitch);
  if (nx * ny > HEIGHTFIELD_VERTEX_BUDGET) {
    // Scale pitch up uniformly until the grid fits, then recompute.
    const scale = Math.sqrt((nx * ny) / HEIGHTFIELD_VERTEX_BUDGET);
    const clamped = pitch * scale;
    warnings.push(`heightfield: pitch ${pitch} clamped to ${clamped.toFixed(3)} (vertex budget ${HEIGHTFIELD_VERTEX_BUDGET})`);
    pitch = clamped;
    nx = count(w, pitch); ny = count(d, pitch);
    // An extreme aspect ratio (e.g. d <= pitch pins ny at its floor of 2
    // while w/pitch is still huge) can leave the uniform pitch-scale above
    // unable to bring nx*ny under budget on its own, since a floored axis
    // has nothing left to give up proportionally. Decrementing both axes
    // unconditionally would then walk the pinned one straight through the
    // count() floor to 1 or 0 — reintroducing the divide-by-(n-1) and empty
    // top-grid failures that floor exists to prevent. Hold each axis at 2.
    while (nx * ny > HEIGHTFIELD_VERTEX_BUDGET && (nx > 2 || ny > 2)) {
      if (nx > 2) nx--;
      if (ny > 2) ny--;
    }
  }

  const [lo, hi] = range;
  const span = hi - lo;
  // range is a REMAP with clamped ends: lo→0, hi→1. invert applies after.
  const f = (v) => {
    const t = span === 0 ? 0 : Math.min(Math.max((v - lo) / span, 0), 1);
    return invert ? 1 - t : t;
  };

  const x0 = origin === "corner" ? 0 : -w / 2;
  const y0 = origin === "corner" ? 0 : -d / 2;
  const X = (i) => x0 + (i / (nx - 1)) * w;
  const Y = (j) => y0 + (j / (ny - 1)) * d;
  const Z = (i, j) => base + maxZ * f(sampleGrid(grid, i / (nx - 1), j / (ny - 1)));

  const V = [], Tr = [];

  // 1. Top grid, row-major. CCW from +Z.
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) V.push(X(i), Y(j), Z(i, j));
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, dd = c + 1;
    Tr.push(a, b, dd, a, dd, c);
  }

  // 2. Perimeter, CCW viewed from +Z, as grid indices.
  const per = [];
  for (let i = 0; i < nx; i++) per.push(i);
  for (let j = 1; j < ny; j++) per.push(j * nx + (nx - 1));
  for (let i = nx - 2; i >= 0; i--) per.push((ny - 1) * nx + i);
  for (let j = ny - 2; j >= 1; j--) per.push(j * nx);
  const P = per.length;

  // 3. Bottom ring: one new vertex per perimeter vertex, dropped to z = 0. The
  //    top ring of the skirt reuses the ORIGINAL grid perimeter indices (not a
  //    duplicate) — that's what makes the top-face boundary edge and the
  //    skirt's top edge the same index pair, so the mesh is watertight by
  //    index alone with no separate weld/merge step required.
  const bot0 = V.length / 3;
  for (const p of per) V.push(V[p * 3], V[p * 3 + 1], 0);

  // 4. Skirt.
  for (let k = 0; k < P; k++) {
    const k2 = (k + 1) % P;
    Tr.push(per[k], bot0 + k, bot0 + k2, per[k], bot0 + k2, per[k2]);
  }

  // 5. Bottom cap — flip=true so it faces −Z. Centre is the footprint centroid.
  fanCap(V, Tr, bot0, P, [x0 + w / 2, y0 + d / 2, 0], true);

  return { positions: Float32Array.from(V), indices: Uint32Array.from(Tr), warnings };
}
