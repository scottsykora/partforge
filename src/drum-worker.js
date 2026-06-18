// Web Worker: boots the OpenCASCADE WASM kernel and builds the drum off the
// main thread. Posts phase progress, a coarse display mesh (fast), and — only
// on request — print-grade STL/STEP for download. When the view has two parts
// (the "Both" view) each is exported separately and bundled into a zip, since a
// compound trips up the STEP/STL writers.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, exportSTEP, makeCompound } from "replicad";
import { zipSync } from "fflate";
import { buildParts } from "./drum.js";

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
  postMessage({ type: "ready" });
})();

// Display mesh is coarse — plenty smooth on screen, and the fine print-grade
// tolerance is used only on export. angularTolerance 0.4 (vs 0.3) meshes ~40%
// faster (~110k vs 164k tris on the big drum) — imperceptible on screen. Linear
// tolerance stays fine (0.05) so groove edges read crisply.
const DISPLAY_MESH = { tolerance: 0.05, angularTolerance: 0.4 };
const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.1 };

let lastParts = null; // [{ name, shape }]

const progress = (phase) => postMessage({ type: "progress", phase });

self.onmessage = async (e) => {
  await ready;
  const msg = e.data;

  if (msg.type === "generate") {
    const t0 = performance.now();
    try {
      if (lastParts) {
        for (const part of lastParts) {
          part.shape.delete?.();
          part.display?.delete?.();
        }
        lastParts = null;
      }
      const parts = buildParts(msg.part, msg.params, progress);
      lastParts = parts;

      progress("meshing");
      // render the seated `display` geometry when a part has it, else `shape`
      const display = parts.map((x) => x.display ?? x.shape);
      const shape = display.length === 1 ? display[0] : makeCompound(display);
      const m = shape.mesh(DISPLAY_MESH);
      const positions = new Float32Array(m.vertices);
      const normals = new Float32Array(m.normals);
      const indices = new Uint32Array(m.triangles);
      postMessage(
        {
          type: "mesh",
          positions,
          normals,
          indices,
          triangles: indices.length / 3,
          ms: Math.round(performance.now() - t0),
        },
        [positions.buffer, normals.buffer, indices.buffer]
      );
    } catch (err) {
      postMessage({ type: "error", message: String(err?.message || err) });
    }
  } else if (msg.type === "export-stl") {
    await exportParts("stl", "model/stl", (shape) => shape.blobSTL(PRINT_MESH).arrayBuffer());
  } else if (msg.type === "export-step") {
    await exportParts("step", "application/step", (shape, name) =>
      exportSTEP([{ shape, name }]).arrayBuffer()
    );
  }
};

// Export every part: one file if there's a single part, else a zip of named
// per-part files. `toBuffer(shape, name)` returns an ArrayBuffer for that part.
async function exportParts(ext, mime, toBuffer) {
  if (!lastParts) return;
  try {
    progress(`exporting ${ext.toUpperCase()}`);
    if (lastParts.length === 1) {
      const data = await toBuffer(lastParts[0].shape, lastParts[0].name);
      postMessage({ type: "download", data, filename: `${lastParts[0].name}.${ext}`, mime });
    } else {
      const entries = {};
      for (const part of lastParts) {
        entries[`${part.name}.${ext}`] = new Uint8Array(await toBuffer(part.shape, part.name));
      }
      const zip = zipSync(entries, { level: 0 }); // store (these don't compress well)
      postMessage({ type: "download", data: zip, filename: "drums.zip", mime: "application/zip" });
    }
  } catch (err) {
    postMessage({ type: "error", message: `${ext.toUpperCase()} export failed: ` + (err?.message || err) });
  }
}
