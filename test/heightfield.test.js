import { describe, test, expect } from "vitest";
import { heightfieldMesh, sampleGrid, HEIGHTFIELD_VERTEX_BUDGET } from "../src/framework/geometry/heightfield.js";

// A 2x2 grid: 0, 1/3, 2/3, 1 of full scale, row-major.
const g2 = { width: 2, height: 2, data: Uint16Array.from([0, 21845, 43690, 65535]) };
// A flat mid-gray 4x4.
const g4 = { width: 4, height: 4, data: Uint16Array.from(Array(16).fill(32768)) };

const base = { w: 10, d: 10, base: 1, maxZ: 2, pitch: 5 };
const zs = (m) => { const out = []; for (let i = 2; i < m.positions.length; i += 3) out.push(m.positions[i]); return out; };

describe("sampleGrid", () => {
  test("returns corner values exactly at the corners", () => {
    expect(sampleGrid(g2, 0, 0)).toBeCloseTo(0, 4);
    expect(sampleGrid(g2, 1, 1)).toBeCloseTo(1, 4);
  });
  test("bilinearly interpolates the centre", () => {
    expect(sampleGrid(g2, 0.5, 0.5)).toBeCloseTo(0.5, 3);
  });
});

describe("heightfieldMesh", () => {
  test("sample count is ceil(w/pitch) x ceil(d/pitch)", () => {
    // 10mm / 5mm = 2 samples per side.
    const m = heightfieldMesh(g4, base);
    // DEVIATION FROM BRIEF (see task-2-report.md): the brief's implementation
    // sketch duplicates the top ring before the skirt, which the "is
    // watertight" test below then rejects — that test counts shared edges by
    // vertex INDEX with no external weld/merge step, and a duplicated top
    // ring gives the top face and the skirt two different index pairs for
    // the same physical edge, so it never reaches count 2. The two
    // assertions cannot both pass for the same implementation; watertightness
    // is the load-bearing one k.heightfield needs, so the skirt's top ring
    // reuses the ORIGINAL grid perimeter indices instead of duplicating them.
    // grid(4) + bottom ring(4) + fan centre(1) = 9.
    expect(m.positions.length / 3).toBe(9);
  });

  test("is watertight — every edge is shared by exactly two triangles", () => {
    const m = heightfieldMesh(g4, { ...base, pitch: 2 });
    const counts = new Map();
    for (let t = 0; t < m.indices.length; t += 3) {
      const tri = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const bad = [...counts.entries()].filter(([, n]) => n !== 2);
    expect(bad).toEqual([]);
  });

  test("winds outward — signed volume is positive", () => {
    const m = heightfieldMesh(g4, { ...base, pitch: 2 });
    let vol = 0;
    const P = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [P(m.indices[t]), P(m.indices[t + 1]), P(m.indices[t + 2])];
      vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    expect(vol).toBeGreaterThan(0);
  });

  test("height is base + maxZ * value; flat mid-gray sits halfway", () => {
    const m = heightfieldMesh(g4, base);
    const top = zs(m).filter((z) => z > 0.5);
    for (const z of top) expect(z).toBeCloseTo(1 + 2 * 0.5, 3);
  });

  test("invert flips a specific corner's height, not just the aggregate max", () => {
    // g2 is a 2x2 grid, so it maps 1:1 onto the 2x2 sample mesh (nx=ny=2 here):
    // vertex 0 is grid (i=0,j=0) -> u=0,v=0 -> raw g2.data[0] = 0 (the min);
    // vertex 3 is grid (i=1,j=1) -> u=1,v=1 -> raw g2.data[3] = 65535 (the max).
    // g2 contains BOTH extremes, so checking only the aggregate max (as the
    // brief's original test did) can't tell invert apart from a no-op: either
    // way the peak is 1 + 2*1 = 3, it just relocates to the opposite corner.
    // Pin each corner's height under both settings instead, so an
    // implementation that ignores `invert`, or only flips one corner, fails.
    const zAt = (m, i) => m.positions[i * 3 + 2];
    const plain = heightfieldMesh(g2, { ...base, invert: false });
    const inverted = heightfieldMesh(g2, { ...base, invert: true });
    expect(zAt(plain, 0)).toBeCloseTo(1 + 2 * 0, 3); // raw 0 -> f=0 -> base only
    expect(zAt(plain, 3)).toBeCloseTo(1 + 2 * 1, 3); // raw 1 -> f=1 -> full relief
    expect(zAt(inverted, 0)).toBeCloseTo(1 + 2 * 1, 3); // raw 0 -> f=1-0=1 -> now the peak
    expect(zAt(inverted, 3)).toBeCloseTo(1 + 2 * 0, 3); // raw 1 -> f=1-1=0 -> now the base
  });

  test("range remaps: [0.5,1] puts mid-gray at zero relief", () => {
    const m = heightfieldMesh(g4, { ...base, range: [0.5, 1] });
    const top = zs(m).filter((z) => z > 0);
    for (const z of top) expect(z).toBeCloseTo(1, 3); // base only, no relief
  });

  test("range clamps input below the band to zero", () => {
    const m = heightfieldMesh(g4, { ...base, range: [0.75, 1] });
    const top = zs(m).filter((z) => z > 0);
    for (const z of top) expect(z).toBeCloseTo(1, 3);
  });

  test("range remaps an interior value using BOTH endpoints", () => {
    // The two tests above only ever put the sampled value at or below `lo`,
    // and always use hi=1 — a formula that hardcodes hi=1 (ignoring
    // range[1]), or that clamps by lo alone without dividing by the span,
    // produces the same near-zero result in both cases and would still pass.
    // Use a band where the flat mid-gray input (~0.5) falls in the MIDDLE,
    // with hi != 1, so the expected relief only comes out right if both
    // endpoints and the span division are all honoured.
    const m = heightfieldMesh(g4, { ...base, range: [0.25, 0.75] });
    // raw ~= 0.5 -> f = (0.5 - 0.25) / (0.75 - 0.25) = 0.5 -> half relief.
    const top = zs(m).filter((z) => z > 0);
    for (const z of top) expect(z).toBeCloseTo(1 + 2 * 0.5, 3);
  });

  test('origin "center" centres the footprint; "corner" puts min at the origin', () => {
    const c = heightfieldMesh(g4, base);
    const k = heightfieldMesh(g4, { ...base, origin: "corner" });
    const xsOf = (m) => { const o = []; for (let i = 0; i < m.positions.length; i += 3) o.push(m.positions[i]); return o; };
    expect(Math.min(...xsOf(c))).toBeCloseTo(-5, 3);
    expect(Math.min(...xsOf(k))).toBeCloseTo(0, 3);
  });

  test("the base always sits at z = 0", () => {
    const m = heightfieldMesh(g4, { ...base, origin: "corner" });
    expect(Math.min(...zs(m))).toBeCloseTo(0, 6);
  });

  test("rejects base <= 0 and pitch <= 0", () => {
    expect(() => heightfieldMesh(g4, { ...base, base: 0 })).toThrow(/base/);
    expect(() => heightfieldMesh(g4, { ...base, pitch: 0 })).toThrow(/pitch/);
  });

  test("clamps a runaway pitch to the vertex budget and warns rather than throwing", () => {
    const m = heightfieldMesh(g4, { w: 200, d: 200, base: 1, maxZ: 1, pitch: 0.01 });
    // Ruling C (task-2-brief.md ADDENDUM): the budget governs GRID vertices
    // (nx*ny), but positions.length/3 is the TOTAL, which also includes the
    // duplicated top ring, the bottom ring, and the fan centre — roughly
    // 2*(2*nx+2*ny-4)+1 extra. At the boundary the total legitimately exceeds
    // the budget by a fraction of a percent, so a bare <= budget assertion can
    // fail on correct code. Allow 2% headroom for that ring overhead.
    expect(m.positions.length / 3).toBeLessThanOrEqual(HEIGHTFIELD_VERTEX_BUDGET * 1.02);
    expect(m.warnings.join(" ")).toMatch(/pitch .* clamped/);
  });

  test("no warnings on an ordinary build", () => {
    expect(heightfieldMesh(g4, base).warnings).toEqual([]);
  });
});
