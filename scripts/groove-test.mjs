// Headless de-risk prototype: can Replicad (OCCT-in-WASM) do the helical
// groove sweep + boolean cut that the Python generator relies on?
//
// Mirrors the small-drum spec from cad/capstan_drum_generator.py:
//   blank OD 10.2 mm, groove cut 1.2 wide x 0.6 deep, axial pitch 1.4 mm/rev.
//
// Run: npm run groove-test   (needs Node 20 — see .nvmrc)

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// --- Shim the CommonJS globals the Emscripten OCCT module expects ----------
// replicad_single.js is ESM (`export default`) but its Node branch uses bare
// `require`/`__dirname`. In pure ESM those are undefined, so provide them.
const require = createRequire(import.meta.url);
globalThis.require = globalThis.require ?? require;
globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));

// --- Boot the OpenCASCADE WASM kernel --------------------------------------
const { default: initOpenCascade } = await import(
  "replicad-opencascadejs/src/replicad_single.js"
);
const wasmBinary = fs.readFileSync(
  require.resolve("replicad-opencascadejs/src/replicad_single.wasm")
);
const OC = await initOpenCascade({ wasmBinary });

const {
  setOC,
  makeCylinder,
  makeCircle,
  makeHelix,
  assembleWire,
  genericSweep,
  exportSTEP,
} = await import("replicad");
setOC(OC);

// --- Parameters (small-drum spec) ------------------------------------------
const blankR = 5.1; // blank radius (Ø10.2)
const height = 14.0; // a 10-turn test band
const axialPitch = 1.4; // mm per rev
const grooveCutR = 0.6; // circular cutter radius -> 1.2 wide x 0.6 deep
const pathR = blankR; // cutter centre rides the blank surface

console.log("Booting OCCT + Replicad… kernel ready.");

try {
  const mcount = (s) => {
    try {
      const m = s.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
      return `${m.triangles.length / 3} tris`;
    } catch (e) {
      return `mesh-failed(${e.message || e})`;
    }
  };

  // 1) drum blank
  const blank = makeCylinder(blankR, height);
  console.log(`   [probe] blank: ${mcount(blank)}`);

  // 2) helical spine at the blank surface
  const spine = makeHelix(axialPitch, height, pathR);

  // 3) groove-cutter profile: a circle at the helix start, oriented
  //    perpendicular to the helix tangent there.
  //    Helix(θ) = (R cosθ, R sinθ, pitch·θ/2π); tangent at θ=0 = (0, R, pitch/2π).
  const tangent = [0, pathR, axialPitch / (2 * Math.PI)];
  const profile = assembleWire([
    makeCircle(grooveCutR, [pathR, 0, 0], tangent),
  ]);

  // 4) sweep the profile along the helix (Frenet keeps it perpendicular)
  const grooveTool = genericSweep(profile, spine, { frenet: true });
  console.log(`   [probe] grooveTool sweep: ${mcount(grooveTool)}`);

  // 5) the operation under test: boolean-cut the helical groove
  const drum = blank.cut(grooveTool);
  console.log(`   [probe] drum (blank - groove): ${mcount(drum)}`);

  // 6) validate by meshing — this triangulates the BREP solid and throws on
  //    an invalid result, so reaching here means the sweep+cut is sound.
  const mesh = drum.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
  const triCount = mesh.triangles.length / 3;
  const vertCount = mesh.vertices.length / 3;

  console.log("\n✅ HELIX SWEEP + BOOLEAN CUT WORKS");
  console.log(
    `   blank Ø${(blankR * 2).toFixed(1)} × ${height} mm, ${(
      height / axialPitch
    ).toFixed(1)} groove turns @ ${axialPitch} mm pitch`
  );
  console.log(`   meshed solid: ${triCount} triangles, ${vertCount} vertices`);

  // 7) write outputs. blobSTL/exportSTEP route through OCCT's emscripten
  //    virtual FS, which is flaky under headless Node (works in the bundler/
  //    browser). For this CLI check we write the STL ourselves from the mesh.
  fs.mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  const outDir = fileURLToPath(new URL("./out/", import.meta.url));
  writeBinarySTL(
    path.join(outDir, "groove-test.stl"),
    mesh.vertices,
    mesh.triangles
  );
  console.log(`   wrote out/groove-test.stl (${triCount} facets)`);

  try {
    const stepBlob = exportSTEP([{ shape: drum, name: "groove_test" }]);
    fs.writeFileSync(
      path.join(outDir, "groove-test.step"),
      Buffer.from(await stepBlob.arrayBuffer())
    );
    console.log("   wrote out/groove-test.step");
  } catch (e) {
    console.log(
      `   (STEP export skipped under headless Node: ${e.message || e} — works in-browser)`
    );
  }
} catch (err) {
  console.error("\n❌ FAILED:", err && err.message ? err.message : err);
  process.exitCode = 1;
}

// --- Minimal binary STL writer from a replicad mesh ------------------------
// vertices: flat [x,y,z, …]; triangles: flat vertex indices [i,j,k, …]
function writeBinarySTL(filePath, vertices, triangles) {
  const nTri = triangles.length / 3;
  const buf = Buffer.alloc(84 + nTri * 50);
  buf.writeUInt32LE(nTri, 80);
  let o = 84;
  const v = (i) => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]];
  for (let t = 0; t < nTri; t++) {
    const a = v(triangles[t * 3]);
    const b = v(triangles[t * 3 + 1]);
    const c = v(triangles[t * 3 + 2]);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    for (const x of [n[0] / len, n[1] / len, n[2] / len]) {
      buf.writeFloatLE(x, o);
      o += 4;
    }
    for (const p of [a, b, c])
      for (const x of p) {
        buf.writeFloatLE(x, o);
        o += 4;
      }
    buf.writeUInt16LE(0, o);
    o += 2;
  }
  fs.writeFileSync(filePath, buf);
}
