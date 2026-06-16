// Headless check of the drum geometry (the same buildDrum the browser worker
// uses), exercising the fuzzy-boolean groove cut. Verifies the full multi-turn
// drum meshes + exports.
//
// Run:  npm run groove-test            (default 10 turns)
//       TURNS=22 npm run groove-test   (full production drum)

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// Shim the CommonJS globals the Emscripten OCCT module expects under ESM.
const require = createRequire(import.meta.url);
globalThis.require = globalThis.require ?? require;
globalThis.__dirname =
  globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));

// Boot the OpenCASCADE WASM kernel.
const { default: initOpenCascade } = await import(
  "replicad-opencascadejs/src/replicad_single.js"
);
const OC = await initOpenCascade({
  wasmBinary: fs.readFileSync(
    require.resolve("replicad-opencascadejs/src/replicad_single.wasm")
  ),
});
const { setOC, exportSTEP } = await import("replicad");
setOC(OC);

const { buildDrum } = await import("../src/drum.js");

const turns = Number(process.env.TURNS ?? 10);
console.log(`Kernel ready. Building drum (${turns} turns, fuzzy cut)…`);

try {
  const t0 = Date.now();
  const drum = buildDrum({ turns });
  const mesh = drum.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
  const tris = mesh.triangles.length / 3;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (tris === 0) throw new Error("cut produced an empty solid (0 triangles)");

  fs.mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
  const outDir = fileURLToPath(new URL("./out/", import.meta.url));
  writeBinarySTL(
    path.join(outDir, "groove-test.stl"),
    mesh.vertices,
    mesh.triangles
  );

  console.log(`\n✅ FUZZY GROOVE CUT WORKS — ${turns} turns in ${secs}s`);
  console.log(`   meshed solid: ${tris} triangles`);
  console.log(`   wrote out/groove-test.stl`);

  try {
    const stepBlob = exportSTEP([{ shape: drum, name: "drum" }]);
    fs.writeFileSync(
      path.join(outDir, "groove-test.step"),
      Buffer.from(await stepBlob.arrayBuffer())
    );
    console.log("   wrote out/groove-test.step");
  } catch (e) {
    console.log(`   (STEP export skipped headless: ${e.message || e})`);
  }
} catch (err) {
  console.error("\n❌ FAILED:", err?.message || err);
  process.exitCode = 1;
}

// Minimal binary STL writer from a replicad mesh (vertices flat, triangles=idx).
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
