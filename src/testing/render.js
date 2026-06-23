import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildView } from "./build.js";
import { bounds } from "./mesh.js";

// Canonical view directions in MODEL space (Z-up). `dir` is the direction from
// the part centre toward the camera; `up` is the camera up vector.
const ANGLES = {
  iso:   { dir: [1, 1, 1],  up: [0, 0, 1] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  top:   { dir: [0, 0, 1],  up: [0, 1, 0] },
};

const slug = (s) => String(s).toLowerCase().replace(/\s+/g, "-");
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Render canonical-angle PNGs of one view of a part with a pure-JS software
// rasterizer (orthographic, z-buffered, Lambert-shaded, with depth-tested edge
// overlays). No native module, no browser. Returns the written file paths.
// pngjs is lazy-imported so importing the testing barrel for measure never loads it.
export async function renderViews(kernel, part, view = Object.keys(part.views)[0], {
  views = ["iso", "front", "top"], out = "render", size = [800, 600], edges = true, params = {},
} = {}) {
  const { PNG } = await import("pngjs");
  const [W, H] = size;
  const meshes = buildView(kernel, part, view, params).map((b) => b.mesh); // copied out

  // scene bounds over all sub-parts (positions are JS-owned; safe after cleanup)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    const b = bounds(m.positions);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b.min[i]); hi[i] = Math.max(hi[i], b.max[i]); }
  }
  kernel.cleanup?.();

  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 5;

  const bg = [0x15, 0x18, 0x1d], base = [0x9f, 0xb4, 0xcc], edgeColor = [0x1c, 0x23, 0x2d];
  const light = norm([0.4, 0.5, 0.8]); // world-space key direction (toward the light)
  const ambient = 0.35, diffuse = 0.75;
  const bias = radius * 0.02;           // edge depth bias so visible edges win ties

  mkdirSync(out, { recursive: true });
  const name = slug(part.meta?.title ?? view);
  const written = [];

  for (const angle of views) {
    const a = ANGLES[angle];
    if (!a) throw new Error(`unknown angle "${angle}" (use: ${Object.keys(ANGLES).join(", ")})`);
    // orthographic camera basis: zc toward camera, xc right, yc up
    const zc = norm(a.dir), xc = norm(cross(a.up, zc)), yc = cross(zc, xc);
    const ppu = Math.min(W, H) / (2 * radius * 1.25); // pixels per mm (uniform; margin)
    const project = (p) => {
      const r = sub(p, center);
      return [W / 2 + dot(r, xc) * ppu, H / 2 - dot(r, yc) * ppu, dot(r, zc)]; // [sx, sy, depth]
    };

    const color = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { color[i * 3] = bg[0]; color[i * 3 + 1] = bg[1]; color[i * 3 + 2] = bg[2]; }
    const zbuf = new Float32Array(W * H).fill(-Infinity); // larger depth = nearer camera

    for (const m of meshes) {
      const P = m.positions, N = m.normals, ind = m.indices;
      // Manifold meshes are a non-indexed soup (3 consecutive verts/triangle) with
      // per-vertex normals; OCCT meshes are indexed and carry no normals.
      const triCount = ind?.length ? ind.length / 3 : P.length / 9;
      for (let t = 0; t < triCount; t++) {
        const ai = ind?.length ? ind[t * 3] * 3 : t * 9;
        const bi = ind?.length ? ind[t * 3 + 1] * 3 : t * 9 + 3;
        const ci = ind?.length ? ind[t * 3 + 2] * 3 : t * 9 + 6;
        const va = [P[ai], P[ai + 1], P[ai + 2]], vb = [P[bi], P[bi + 1], P[bi + 2]], vc = [P[ci], P[ci + 1], P[ci + 2]];
        const sp = [va, vb, vc].map(project);
        let inten;
        if (N?.length) {
          // per-vertex normals (same layout/offset as positions)
          inten = [ai, bi, ci].map((o) =>
            Math.min(1, ambient + diffuse * Math.max(0, N[o] * light[0] + N[o + 1] * light[1] + N[o + 2] * light[2])));
        } else {
          // no normals → flat face normal, two-sided so it lights regardless of winding
          const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
          const wx = vc[0] - va[0], wy = vc[1] - va[1], wz = vc[2] - va[2];
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          const L = Math.hypot(nx, ny, nz) || 1;
          const I0 = Math.min(1, ambient + diffuse * Math.abs((nx * light[0] + ny * light[1] + nz * light[2]) / L));
          inten = [I0, I0, I0];
        }
        rasterTri(sp, inten, base, color, zbuf, W, H);
      }
    }

    if (edges) {
      for (const m of meshes) {
        const E = m.edges;
        if (!E?.length) continue;
        for (let i = 0; i < E.length; i += 6)
          drawLine(project([E[i], E[i + 1], E[i + 2]]), project([E[i + 3], E[i + 4], E[i + 5]]), edgeColor, color, zbuf, W, H, bias);
      }
    }

    const png = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) {
      png.data[i * 4] = color[i * 3]; png.data[i * 4 + 1] = color[i * 3 + 1]; png.data[i * 4 + 2] = color[i * 3 + 2]; png.data[i * 4 + 3] = 255;
    }
    const file = join(out, `${name}-${view}-${angle}.png`);
    writeFileSync(file, PNG.sync.write(png));
    written.push(file);
  }
  return written;
}

// signed area of the 2-D edge from a to b evaluated at p (for barycentric coords)
const edgeFn = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

// Fill one projected triangle, z-buffered, with Gouraud-interpolated Lambert shading.
function rasterTri(sp, inten, base, color, zbuf, W, H) {
  const [a, b, c] = sp;
  const area = edgeFn(a, b, c);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const w0 = edgeFn(b, c, p), w1 = edgeFn(c, a, p), w2 = edgeFn(a, b, p);
      // inside if all the same sign (handle either winding from the projection)
      if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
      const l0 = w0 / area, l1 = w1 / area, l2 = w2 / area;
      const depth = l0 * a[2] + l1 * b[2] + l2 * c[2];
      const idx = y * W + x;
      if (depth <= zbuf[idx]) continue;
      zbuf[idx] = depth;
      const I = l0 * inten[0] + l1 * inten[1] + l2 * inten[2];
      color[idx * 3] = Math.min(255, base[0] * I);
      color[idx * 3 + 1] = Math.min(255, base[1] * I);
      color[idx * 3 + 2] = Math.min(255, base[2] * I);
    }
  }
}

// Depth-tested line for edge overlays: drawn only where it isn't behind the
// surface (within `bias`), so the silhouette and feature edges read as crisp lines.
function drawLine(p0, p1, col, color, zbuf, W, H, bias) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1]))));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(p0[0] + (p1[0] - p0[0]) * t), y = Math.round(p0[1] + (p1[1] - p0[1]) * t);
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const depth = p0[2] + (p1[2] - p0[2]) * t;
    const idx = y * W + x;
    if (depth + bias < zbuf[idx]) continue; // occluded
    color[idx * 3] = col[0]; color[idx * 3 + 1] = col[1]; color[idx * 3 + 2] = col[2];
  }
}
