// Web Worker: boots the OpenCASCADE WASM kernel and builds the drum off the
// main thread. Posts phase progress, a coarse display mesh (fast), and — only
// on request — print-grade STL/STEP for download. When the view has two parts
// (the "Both" view) each is exported separately and bundled into a zip, since a
// compound trips up the STEP/STL writers.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, exportSTEP } from "replicad";
import { zipSync } from "fflate";
import { buildParts, buildSubPart } from "./drum.js";

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
  postMessage({ type: "ready" });
})();

// Display mesh is coarse — plenty smooth on screen, and the fine print-grade
// tolerance is used only on export. tol 0.1 / ang 0.5 meshes the big drum in
// ~0.8s (~59k tris) vs ~2.7s at the original 0.05/0.3, with no meaningful
// difference on screen for parts this size.
const DISPLAY_MESH = { tolerance: 0.1, angularTolerance: 0.5 };
const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.1 };

let lastParts = null; // [{ name, shape }]
let lastKey = null; // `${part}:${JSON.stringify(params)}` the built parts are for

const progress = (phase) => postMessage({ type: "progress", phase });

function disposeLast() {
  if (lastParts) {
    for (const part of lastParts) {
      part.shape.delete?.();
      part.display?.delete?.();
    }
  }
  lastParts = null;
  lastKey = null;
}

// Build the parts for part+params, reusing the last build when unchanged — so an
// export right after a generate doesn't rebuild, and exporting a tab the main
// thread already has cached just rebuilds that one part on demand.
function ensureBuilt(part, params, prog) {
  const key = part + ":" + JSON.stringify(params);
  if (lastParts && lastKey === key) return lastParts;
  disposeLast();
  lastParts = buildParts(part, params, prog);
  lastKey = key;
  return lastParts;
}

self.onmessage = async (e) => {
  await ready;
  const msg = e.data;

  if (msg.type === "generate") {
    // Build + mesh each requested sub-part ("small" | "big" | "block")
    // independently, so the main thread can cache them and compose any view.
    const t0 = performance.now();
    try {
      const meshes = [];
      const transfer = [];
      for (const name of msg.subparts) {
        progress(`building ${name} drum`);
        const shape = buildSubPart(name, msg.params, progress);
        const m = shape.mesh(DISPLAY_MESH);
        const positions = new Float32Array(m.vertices);
        const normals = new Float32Array(m.normals);
        const indices = new Uint32Array(m.triangles);
        shape.delete?.(); // display only needs the mesh; free the OCCT solid
        meshes.push({ name, positions, normals, indices, triangles: indices.length / 3 });
        transfer.push(positions.buffer, normals.buffer, indices.buffer);
      }
      postMessage(
        { type: "meshes", meshes, ms: Math.round(performance.now() - t0) },
        transfer
      );
    } catch (err) {
      postMessage({ type: "error", message: String(err?.message || err) });
    }
  } else if (msg.type === "export-stl") {
    await exportParts("stl", "model/stl", (shape) => shape.blobSTL(PRINT_MESH).arrayBuffer(), msg.part, msg.params);
  } else if (msg.type === "export-step") {
    await exportParts(
      "step", "application/step",
      (shape, name) => exportSTEP([{ shape, name }]).arrayBuffer(),
      msg.part, msg.params
    );
  }
};

// Export the part: one file if it's a single solid, else a zip of named per-part
// files. Rebuilds the requested part first if it isn't the one currently built
// (e.g. exporting a tab the main thread had cached). `toBuffer(shape, name)`
// returns an ArrayBuffer for that part.
async function exportParts(ext, mime, toBuffer, part, params) {
  try {
    const parts = ensureBuilt(part, params, progress);
    progress(`exporting ${ext.toUpperCase()}`);
    if (parts.length === 1) {
      const data = await toBuffer(parts[0].shape, parts[0].name);
      postMessage({ type: "download", data, filename: `${parts[0].name}.${ext}`, mime });
    } else {
      const entries = {};
      for (const p of parts) {
        entries[`${p.name}.${ext}`] = new Uint8Array(await toBuffer(p.shape, p.name));
      }
      const zip = zipSync(entries, { level: 0 }); // store (these don't compress well)
      postMessage({ type: "download", data: zip, filename: "drums.zip", mime: "application/zip" });
    }
  } catch (err) {
    postMessage({ type: "error", message: `${ext.toUpperCase()} export failed: ` + (err?.message || err) });
  }
}
