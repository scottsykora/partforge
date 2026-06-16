// Web Worker: boots the OpenCASCADE WASM kernel and builds the drum off the
// main thread. Posts phase progress, a coarse display mesh (fast), and — only
// on request — a fine STL for download.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC } from "replicad";
import { buildDrum } from "./drum.js";

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
  postMessage({ type: "ready" });
})();

// Display mesh is coarse — plenty smooth for a Ø10 mm part on screen, and ~20×
// faster to compute/transfer than the print-grade tolerance. STL export uses
// the fine tolerance on demand.
const DISPLAY_MESH = { tolerance: 0.05, angularTolerance: 0.3 };
const PRINT_MESH = { tolerance: 0.01, angularTolerance: 0.1 };

let lastDrum = null;

const progress = (phase) => postMessage({ type: "progress", phase });

self.onmessage = async (e) => {
  await ready;
  const msg = e.data;

  if (msg.type === "generate") {
    const t0 = performance.now();
    try {
      if (lastDrum) {
        lastDrum.delete?.();
        lastDrum = null;
      }
      const drum = buildDrum(msg.params, progress);
      lastDrum = drum;

      progress("meshing");
      const m = drum.mesh(DISPLAY_MESH);
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
    if (!lastDrum) return;
    try {
      progress("exporting STL");
      const stl = await lastDrum.blobSTL(PRINT_MESH).arrayBuffer();
      postMessage({ type: "stl", stl }, [stl]);
    } catch (err) {
      postMessage({ type: "error", message: "STL export failed: " + (err?.message || err) });
    }
  }
};
