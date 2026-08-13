// Orthographic silhouette masks: project a part (or a set of 2D rings) onto one of the
// six canonical views and scanline-fill it into a binary image. The foundation of
// silhouette match scoring — no kernel, no DOM, no three, no `node:`, so it runs in the
// geometry worker alongside the rest of the oracle.
//
// Contract: {data: Uint8Array of 0|255, width, height, mmPerPx, minX, minY}. Row 0 is
// the TOP of the image; minX/minY are the projected-plane coordinates of the image's
// BOTTOM-LEFT corner, so a caller maps a pixel back with
//   x = minX + (col + 0.5) * mmPerPx,  y = minY + (height - 0.5 - row) * mmPerPx
// Nothing to draw, or a projection with zero extent, returns null.

export const MATCH_VIEWS = ["front", "back", "top", "bottom", "left", "right"];

// Image axes per view as [modelAxisIndex, sign] in MODEL space (x,y,z) — the third axis
// is dropped. Derived from the viewer's single pivot rotation (`pivot.rotation.x =
// -Math.PI/2` in viewer.js, taking model Z-up to world Y-up) composed with each view's
// camera basis in view-angles.js. A wrong sign here mirrors every downstream match
// score without failing anything else, so the table is written out rather than derived.
const VIEW_AXES = {
  front:  { x: [0,  1], y: [2,  1] }, // drops Y
  back:   { x: [0, -1], y: [2,  1] }, // drops Y
  right:  { x: [1,  1], y: [2,  1] }, // drops X
  left:   { x: [1, -1], y: [2,  1] }, // drops X
  top:    { x: [0,  1], y: [1,  1] }, // drops Z
  bottom: { x: [0,  1], y: [1, -1] }, // drops Z
};

const PAD = 0.04;            // blank fraction of the frame on each side
const FILL = 1 - 2 * PAD;    // 0.92 — the fraction the content's longest extent occupies

// meshes: [{positions: Float32Array|number[], indices?: Uint32Array|number[]}] — `indices`
// optional, flat triangle soup when absent (3 verts per triangle), same as oracle/mesh.js.
export function rasterizeMeshMask(meshes, view, size = 256) {
  const axes = VIEW_AXES[view];
  if (!axes) throw new Error(`unknown match view "${view}"`);
  const [ax, sx] = axes.x, [ay, sy] = axes.y;
  const groups = [];
  for (const mesh of meshes || []) {
    const P = mesh?.positions;
    if (!P || P.length < 9) continue;
    const idx = mesh.indices;
    const n = idx ? idx.length : P.length / 3;
    for (let i = 0; i + 3 <= n; i += 3) {
      const tri = new Float64Array(6);
      let ok = true;
      for (let k = 0; k < 3 && ok; k++) {
        const base = (idx ? idx[i + k] : i + k) * 3;
        const x = P[base + ax] * sx, y = P[base + ay] * sy;
        if (Number.isFinite(x) && Number.isFinite(y)) { tri[k * 2] = x; tri[k * 2 + 1] = y; }
        else ok = false;
      }
      if (ok) groups.push([tri]); // one triangle = one even-odd group; see fillPolygons
    }
  }
  return fillPolygons(groups, size);
}

// rings: [[[x,y], ...], ...] in mm. All rings share ONE even-odd group, so a ring inside
// another is a hole.
export function rasterizeRingsMask(rings, size = 256) {
  const group = [];
  for (const ring of rings || []) {
    if (!ring || ring.length < 3) continue;
    const flat = new Float64Array(ring.length * 2);
    let ok = true;
    for (let i = 0; i < ring.length && ok; i++) {
      const x = ring[i]?.[0], y = ring[i]?.[1];
      if (Number.isFinite(x) && Number.isFinite(y)) { flat[i * 2] = x; flat[i * 2 + 1] = y; }
      else ok = false;
    }
    if (ok) group.push(flat);
  }
  return group.length ? fillPolygons([group], size) : null;
}

// A GROUP is one even-odd polygon set, given as rings of flat [x0,y0,x1,y1,...] pairs.
// Groups UNION with each other, which is the whole reason for the grouping: a closed mesh
// projects its front and back faces onto the same pixels, and even-odd across the whole
// soup would cancel them into background. So each triangle is its own group and a ring
// set is one group, and holes still subtract.
function fillPolygons(groups, size) {
  if (!groups.length) return null;
  let loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
  for (const g of groups) for (const ring of g) for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < loX) loX = ring[i];
    if (ring[i] > hiX) hiX = ring[i];
    if (ring[i + 1] < loY) loY = ring[i + 1];
    if (ring[i + 1] > hiY) hiY = ring[i + 1];
  }
  const extent = Math.max(hiX - loX, hiY - loY);
  if (!(extent > 0)) return null;

  // Uniform scale, tight bbox, PAD on each side, centred in a square frame.
  const mmPerPx = extent / (FILL * size);
  const span = size * mmPerPx;
  const minX = (loX + hiX) / 2 - span / 2, minY = (loY + hiY) / 2 - span / 2;
  const rowOf = (y) => size - 0.5 - (y - minY) / mmPerPx; // row 0 = top: y is flipped here

  // Bucket each group by its first row and drop it once past its last, so a scanline only
  // walks the groups that can cross it (a mesh soup is thousands of tiny groups).
  const starts = Array.from({ length: size }, () => []);
  const lastRow = new Int32Array(groups.length);
  for (let g = 0; g < groups.length; g++) {
    let gLo = Infinity, gHi = -Infinity;
    for (const ring of groups[g]) for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < gLo) gLo = ring[i];
      if (ring[i] > gHi) gHi = ring[i];
    }
    const r0 = Math.min(size - 1, Math.max(0, Math.floor(rowOf(gHi))));
    lastRow[g] = Math.min(size - 1, Math.max(0, Math.ceil(rowOf(gLo))));
    starts[r0].push(g);
  }

  const data = new Uint8Array(size * size);
  const xs = [];
  let active = [];
  for (let r = 0; r < size; r++) {
    if (starts[r].length) active = active.concat(starts[r]);
    if (!active.length) continue;
    active = active.filter((g) => lastRow[g] >= r);
    const y = minY + (size - 0.5 - r) * mmPerPx;
    for (const g of active) {
      xs.length = 0;
      for (const ring of groups[g]) {
        const n = ring.length;
        // Half-open crossing test (y0 <= y) !== (y1 <= y): a vertex sitting exactly on the
        // scanline is counted once, not twice, so parity stays sane.
        for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
          const y0 = ring[j + 1], y1 = ring[i + 1];
          if ((y0 <= y) === (y1 <= y)) continue;
          xs.push(ring[j] + ((y - y0) * (ring[i] - ring[j])) / (y1 - y0));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let c0 = Math.ceil((xs[k] - minX) / mmPerPx - 0.5);      // first pixel CENTRE inside
        let c1 = Math.floor((xs[k + 1] - minX) / mmPerPx - 0.5); // last pixel centre inside
        if (c0 < 0) c0 = 0;
        if (c1 > size - 1) c1 = size - 1;
        for (let c = c0; c <= c1; c++) data[r * size + c] = 255;
      }
    }
  }
  return { data, width: size, height: size, mmPerPx, minX, minY };
}
