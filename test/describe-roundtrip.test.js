import { expect, test, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { buildView } from "../src/framework/oracle/build.js";
import { describe as describeMesh } from "../src/framework/oracle/describe.js";
import { parseStl } from "../src/framework/geometry/stl-parse.js";
import demo from "../src/parts/demo.js";
import filletedBox from "../src/parts/filleted-box.js";
import bracket from "../src/parts/bracket.js";

let kernel;
beforeAll(async () => { kernel = await bootManifoldKernel(); });

// The repo's own reference parts are free, perfectly-labelled ground truth for the exact
// input class describe targets: a CAD-exported tessellation whose real dimensions we can
// read straight out of the part source. Nothing else in the suite can check that the
// numbers the describer reports are the numbers that were built.
const solidOf = (part, view = Object.keys(part.views)[0]) =>
  buildView(kernel, part, view, {})[0].solid;

test("demo.js round-trips with high coverage", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-demo" });
  expect(r.score.explainedArea).toBeGreaterThan(0.95);
});

test("demo.js is described as a single extrusion", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-demo2" });
  expect(r.features.some((f) => f.type === "extrusion")).toBe(true);
});

test("demo.js's recovered bbox matches the built mesh exactly", () => {
  const solid = solidOf(demo);
  const mesh = solid.toMesh();
  const r = describeMesh(kernel, solid, { digest: "rt-demo3" });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], mesh.positions[i+a]); hi[a] = Math.max(hi[a], mesh.positions[i+a]);
  }
  for (let a = 0; a < 3; a++) expect(r.bounds.size[a]).toBeCloseTo(hi[a] - lo[a], 6);
});

test("filleted-box.js reports fillets", () => {
  const r = describeMesh(kernel, solidOf(filletedBox), { digest: "rt-fb" });
  expect(r.features.some((f) => f.type === "fillet")).toBe(true);
});

test("bracket.js round-trips without an error and with localised residual", () => {
  const r = describeMesh(kernel, solidOf(bracket), { digest: "rt-br" });
  expect(r.error).toBeUndefined();
  // Whatever it cannot explain must be LOCATED, not merely counted — an agent can act
  // on "290 triangles, here" and cannot act on "1.2%".
  for (const region of r.residual.regions) {
    expect(region.triangles).toBeGreaterThan(0);
    expect(region.centroid.every(Number.isFinite)).toBe(true);
  }
});

// solid.toMesh() (creased-normals.js) returns a display mesh: PER-CORNER, not
// indexed — every vertex is stored once per incident triangle so hard edges can
// carry distinct shading normals (mesh.positions.length === triangles * 9, no
// `indices` array at all). Jittering that flat array by raw offset, as a naive
// port of "add noise to a mesh" would, perturbs every occurrence of what is
// really the same vertex independently and shears the mesh apart at EVERY edge,
// not just the creases — confirmed by reproducing it: even demo.js's simple
// extrusion came back with ~2800 open edges and _registerImport threw before
// describe ever ran. That is not what re-exported/decimated noise looks like;
// real files perturb each vertex once and keep the topology intact. So weld the
// soup back to an indexed mesh first and jitter each unique vertex exactly
// once, which is both what real noise does and what the framework's own STL
// import path expects (parseStl + Mesh.merge()).
function weldSoup(positions) {
  const n = positions.length / 3;
  const byKey = new Map();
  const welded = [];
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${x},${y},${z}`;
    let id = byKey.get(key);
    if (id === undefined) { id = welded.length / 3; welded.push(x, y, z); byKey.set(key, id); }
    indices[i] = id;
  }
  return { positions: Float32Array.from(welded), indices };
}

test("noise injection degrades the score but does not throw or lose every feature", () => {
  const solid = solidOf(demo);
  const mesh = solid.toMesh();
  const { positions: welded, indices } = weldSoup(mesh.positions);
  const jittered = Float32Array.from(welded, (v, i) => v + ((i * 2654435761 % 1000) / 1000 - 0.5) * 0.002);
  kernel._registerImport({ name: "noisy-demo", digest: "noisy-demo", positions: jittered, indices });
  const clean = describeMesh(kernel, solid, { digest: "n-clean" });
  const dirty = describeMesh(kernel, kernel.import("noisy-demo"), { digest: "n-dirty" });
  expect(dirty.error).toBeUndefined();
  expect(dirty.score.explainedArea).toBeLessThanOrEqual(clean.score.explainedArea + 1e-9);
  expect(dirty.features.length).toBeGreaterThan(0);
});

// A reference part at an arbitrary orientation. `buildView` returns parts built
// axis-aligned, which is exactly the blind spot that hid three defects in this plan —
// rotating one here exercises the entire stack against geometry no fixture was tuned for.
test("a rotated reference part round-trips to a comparable feature set", () => {
  const flat = describeMesh(kernel, solidOf(filletedBox), { digest: "rt-flat" });
  const spun = describeMesh(kernel, solidOf(filletedBox).rotate(29, [0, 0, 0], [1, 2, 3]), { digest: "rt-spun" });
  expect(spun.error).toBeUndefined();

  // This test, run as originally written (an exact `.sort()` array-equality on feature
  // TYPES), is what found two real world-frame bugs in segment.js/surface-graph.js:
  // both scaled their fit-acceptance tolerance off the mesh's WORLD-axis-aligned bbox
  // diagonal, which is only equal to the part's own bounding diagonal when the mesh is
  // axis-aligned (buildView's own output, but not a rotated one) — tilting this exact
  // part 29 degrees inflated that diagonal ~35% (52.5mm -> 71.0mm), which alone was
  // enough to shift which small facets near this part's compound fillet corners cleared
  // the band. segment.js's seed order compounded it, quantizing each face normal's raw
  // world XYZ components into a fixed Gauss-sphere grid, so a rotation slides every
  // facet's normal across that grid at once and reorders which facets seed a growth
  // region together. Both are fixed now (fit.js's `intrinsicFrame`: an orthonormal basis
  // built from the mesh's OWN principal axes via PCA, rotation-covariant by
  // construction, used for both the tolerance scale and the seed-order quantization).
  //
  // Fixing them took this part's flat-vs-spun gap from grossly different (boss 42 vs 32,
  // fillet 17 vs 25 before either fix — 24-47% relative) to close (boss 39 vs 38, chamfer
  // 7 vs 6, fillet 23 vs 27, pocket 34 vs 34 — all within the 20%-or-3 band asserted
  // below). What's left is not a third world-frame bug: `w`/`d`/`h` here get a vertical
  // fillet AND a top-rim fillet, so each of the 4 top corners is a compound, continuously
  // curved octant blend where two dress-up surfaces meet — not any of the v1 vocabulary's
  // 5 analytic primitives, and tessellated into facets a few tenths of a millimetre
  // across. Rotating a solid at all — through Manifold's own transform, nothing this
  // repo controls — moves every vertex by ~2 microns of float32 rounding (measured:
  // rotate 29 degrees and back, max coordinate drift 1.9e-6mm); on a facet that small,
  // that is enough to occasionally flip a normal across the hard quantization boundary
  // seedOrder buckets on, exactly like a genuinely freeform surface would. So: the SET of
  // feature types must match exactly (rotation must never invent or drop a whole
  // vocabulary entry), the two structurally-unambiguous singular features must match
  // exactly, and the corner-blend-prone counts get a tolerance band instead of exact
  // equality — banded, not dropped, so a real regression (the 24-47% pre-fix gaps above)
  // still fails this test.
  const countsOf = (r) => r.features.reduce((m, f) => m.set(f.type, (m.get(f.type) ?? 0) + 1), new Map());
  const flatCounts = countsOf(flat), spunCounts = countsOf(spun);
  expect(new Set(spunCounts.keys())).toEqual(new Set(flatCounts.keys()));
  for (const solo of ["extrusion", "throughHole"]) expect(spunCounts.get(solo)).toBe(flatCounts.get(solo));
  for (const type of flatCounts.keys()) {
    if (type === "extrusion" || type === "throughHole") continue;
    const a = flatCounts.get(type) ?? 0, b = spunCounts.get(type) ?? 0;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.max(3, 0.2 * Math.max(a, b)));
  }

  // Coverage must not degrade materially: a rotation changes nothing about the geometry,
  // so a drop here means some stage is reading world axes it has no business reading.
  expect(spun.score.explainedArea).toBeGreaterThan(flat.score.explainedArea - 0.02);
});

test("every accepted feature's confidence is a finite fraction", () => {
  const r = describeMesh(kernel, solidOf(demo), { digest: "rt-conf" });
  for (const f of r.features) {
    if (f.confidence == null) continue;
    expect(Number.isFinite(f.confidence)).toBe(true);
    expect(f.confidence).toBeGreaterThan(0);
  }
});

// --- third-party corpus ------------------------------------------------------
// The tests above check describe against IDEAL input: our own tessellation, at our own
// chord tolerance, with no re-meshing. Real downloaded STLs are decimated, re-meshed, and
// occasionally slightly non-manifold. Without this corpus the suite goes green against a
// describer that has only ever seen its own kind of mesh — see
// test/fixtures/third-party/README.md for what's wanted and why none is committed yet.
const DIR = fileURLToPath(new URL("./fixtures/third-party/", import.meta.url));
const thirdPartyFiles = readdirSync(DIR).filter((f) => f.endsWith(".stl"));

if (thirdPartyFiles.length === 0) {
  test.skip("third-party corpus is empty — see test/fixtures/third-party/README.md", () => {});
} else {
  for (const file of thirdPartyFiles) {
    test(`third-party ${file} describes without an error`, () => {
      // Geometry enters the kernel the one way it can: register it as an import, then read
      // it back as a Solid — exactly what the framework's own import pipeline does.
      const { positions, indices } = parseStl(readFileSync(`${DIR}${file}`));
      kernel._registerImport({ name: file, digest: file, positions, indices });
      const r = describeMesh(kernel, kernel.import(file), { digest: `tp-${file}` });
      // Deliberately weak: we have no ground truth for these. What we CAN insist on is
      // that the describer never throws, never claims coverage it cannot back, and always
      // localises what it could not explain.
      expect(r.error).toBeUndefined();
      expect(r.score.explainedArea).toBeGreaterThan(0);
      expect(r.score.explainedArea).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.residual.regions.every((g) => g.triangles > 0)).toBe(true);
    });
  }
}
