import { expect, test } from "vitest";
import { MATCH_VIEWS, rasterizeMeshMask, rasterizeRingsMask } from "../src/framework/oracle/silhouette.js";

// An axis-aligned box as a non-indexed 12-triangle soup, same convention as oracle/mesh.js.
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const quads = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
  const pos = [];
  for (const [a,b,c,d] of quads) for (const i of [a,b,c, a,c,d]) pos.push(...v[i]);
  return pos;
}

// The orientation fixture: an L-shaped prism as a 24-triangle soup. The long arm runs
// along model +X; the foot rises toward model +Y and is also the tall part in +Z, so
// BOTH the top view (which drops Z) and the front view (which drops Y) project an L
// rather than a plain rectangle.
const ARM = [0, 0, 0, 40, 10, 10];   // long in +X, short in +Y, short in +Z
const FOOT = [0, 10, 0, 12, 40, 30]; // short in +X, long in +Y, tall in +Z
const lMesh = () => [{ positions: [...boxSoup(...ARM), ...boxSoup(...FOOT)] }];

const at = (m, r, c) => m.data[r * m.width + c];
const colsInRow = (m, r) => { const cs = []; for (let c = 0; c < m.width; c++) if (at(m, r, c)) cs.push(c); return cs; };
const fgRows = (m) => { const rs = []; for (let r = 0; r < m.height; r++) if (colsInRow(m, r).length) rs.push(r); return rs; };
function centerOfMass(m) {
  let n = 0, sr = 0, sc = 0;
  for (let r = 0; r < m.height; r++) for (let c = 0; c < m.width; c++) if (at(m, r, c)) { n++; sr += r; sc += c; }
  return n ? { row: sr / n, col: sc / n, count: n } : null;
}

test("MATCH_VIEWS names the six canonical orthographic views", () => {
  expect(MATCH_VIEWS).toEqual(["front", "back", "top", "bottom", "left", "right"]);
});

test("a cube's front view is a filled square inside the padded frame", () => {
  const m = rasterizeMeshMask([{ positions: boxSoup(0, 0, 0, 1, 1, 1) }], "front", 64);
  expect(m.width).toBe(64);
  expect(m.height).toBe(64);
  for (const v of m.data) expect(v === 0 || v === 255).toBe(true);

  const frac = centerOfMass(m).count / (64 * 64);
  expect(frac).toBeGreaterThan(0.75);
  expect(frac).toBeLessThan(0.95);

  for (let c = 0; c < 64; c++) { expect(at(m, 0, c)).toBe(0); expect(at(m, 63, c)).toBe(0); }
  for (let r = 0; r < 64; r++) { expect(at(m, r, 0)).toBe(0); expect(at(m, r, 63)).toBe(0); }
});

test("top view maps model +X to image-right and model +Y to image-UP", () => {
  const m = rasterizeMeshMask(lMesh(), "top", 64);
  const rows = fgRows(m);
  // The foot (+Y) owns the highest y in the projection, so it must own the TOP rows —
  // and only its narrow +X range. A y-flip puts the full-width arm here instead.
  const top = colsInRow(m, rows[0]);
  expect(top.length).toBeGreaterThan(0);
  expect(Math.max(...top)).toBeLessThan(m.width * 0.4);
  // The arm spans the whole +X extent, so the bottom row is (near) full width.
  const bottom = colsInRow(m, rows[rows.length - 1]);
  expect(bottom.length).toBeGreaterThan(m.width * 0.85);
});

test("top view's center of mass sits in the left half (the L opens toward +X)", () => {
  const m = rasterizeMeshMask(lMesh(), "top", 64);
  expect(centerOfMass(m).col).toBeLessThan(m.width / 2);
});

test("front view maps model +Z to image-UP (the tall part is on top)", () => {
  const m = rasterizeMeshMask(lMesh(), "front", 64);
  const rows = fgRows(m);
  const top = colsInRow(m, rows[0]);
  expect(top.length).toBeGreaterThan(0);
  expect(Math.max(...top)).toBeLessThan(m.width * 0.4); // only the tall foot reaches +Z max
  const bottom = colsInRow(m, rows[rows.length - 1]);
  expect(bottom.length).toBeGreaterThan(m.width * 0.85); // the arm spans all of +X
});

test("back is the column-mirror of front", () => {
  const front = rasterizeMeshMask(lMesh(), "front", 64);
  const back = rasterizeMeshMask(lMesh(), "back", 64);
  expect(back.mmPerPx).toBeCloseTo(front.mmPerPx, 12);
  for (let r = 0; r < front.height; r++) for (let c = 0; c < front.width; c++) {
    expect(at(back, r, c)).toBe(at(front, r, front.width - 1 - c));
  }
});

test("a pixel maps back to model space through minX/minY", () => {
  const m = rasterizeMeshMask(lMesh(), "top", 64);
  const rows = fgRows(m);
  const topY = m.minY + (m.height - 0.5 - rows[0]) * m.mmPerPx;
  expect(topY).toBeLessThanOrEqual(40);          // inside the foot's +Y extent
  expect(topY).toBeGreaterThan(40 - m.mmPerPx);  // and within one pixel of its top face
});

test("rings fill even-odd, so a hole ring is background", () => {
  const outer = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const hole = [[15, 5], [25, 5], [25, 15], [15, 15]];
  const m = rasterizeRingsMask([outer, hole], 64);
  const px = (x, y) => at(m, Math.round(m.height - 0.5 - (y - m.minY) / m.mmPerPx), Math.round((x - m.minX) / m.mmPerPx - 0.5));
  expect(px(20, 10)).toBe(0);   // hole centre
  expect(px(5, 10)).toBe(255);  // solid, left of the hole
  expect(px(35, 10)).toBe(255); // solid, right of the hole
  expect(m.mmPerPx).toBeCloseTo(40 / (0.92 * 64), 5);
  expect(Math.abs(m.mmPerPx - 40 / (0.92 * 64)) / m.mmPerPx).toBeLessThan(0.05);
});

test("degenerate input rasterizes to null", () => {
  expect(rasterizeMeshMask([], "front", 32)).toBeNull();
  expect(rasterizeMeshMask([{ positions: [] }], "front", 32)).toBeNull();
  expect(rasterizeRingsMask([], 32)).toBeNull();
  expect(rasterizeRingsMask([[[1, 1], [1, 1]]], 32)).toBeNull(); // fewer than 3 points
});

test("an indexed mesh rasterizes the same as the equivalent soup", () => {
  const soup = boxSoup(0, 0, 0, 1, 1, 1);
  const positions = [], indices = [];
  for (let i = 0; i < soup.length / 3; i++) { positions.push(soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]); indices.push(i); }
  const a = rasterizeMeshMask([{ positions: soup }], "right", 48);
  const b = rasterizeMeshMask([{ positions: new Float32Array(positions), indices: new Uint32Array(indices) }], "right", 48);
  expect([...b.data]).toEqual([...a.data]);
});

test("non-finite triangles are skipped, not drawn", () => {
  const clean = rasterizeMeshMask([{ positions: boxSoup(0, 0, 0, 1, 1, 1) }], "front", 32);
  const withJunk = rasterizeMeshMask(
    [{ positions: [...boxSoup(0, 0, 0, 1, 1, 1), NaN, 0, 0, 5, Infinity, 0, 0, 0, 5] }],
    "front", 32,
  );
  expect([...withJunk.data]).toEqual([...clean.data]);
});
