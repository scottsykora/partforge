// Web Worker: Manifold geometry backend — boots fast (no 11 MB OCCT WASM).
// Handles generate (mesh) and export-stl (download-parts). Does NOT handle
// export-step — that goes to the export-worker.

import Module from "manifold-3d";
import { createManifoldKernel } from "./framework/geometry/manifold-backend.js";
import { handle } from "./geometry-jobs.js";

let wasm = null;
let kernel = null;        // preview-quality: fast meshes for the interactive view
let exportKernel = null;  // print-quality: high-res STL export (built on first use)
const ready = (async () => {
  wasm = await Module();
  wasm.setup();
  kernel = createManifoldKernel(wasm, { quality: "preview" });
  postMessage({ type: "ready" });
})();

self.onmessage = async (e) => {
  await ready;
  // STL is a print mesh — build it at the high-res 'print' tessellation, not the
  // coarse preview the live view uses. (Manifold bakes segment counts in at
  // primitive creation, so this needs its own kernel; the result is cached.)
  const k = e.data.type === "export-stl"
    ? (exportKernel ??= createManifoldKernel(wasm, { quality: "print" }))
    : kernel;
  await handle(k, e.data, (m) => {
    if (m.type === "meshes") {
      const transfer = [];
      for (const x of m.meshes) {
        transfer.push(x.positions.buffer, x.normals.buffer);
        if (x.indices) transfer.push(x.indices.buffer); // Manifold meshes are non-indexed
        if (x.edges) transfer.push(x.edges.buffer);
      }
      postMessage(m, transfer);
    } else if (m.type === "download-parts") {
      postMessage(m, m.parts.map((p) => (ArrayBuffer.isView(p.data) ? p.data.buffer : p.data)));
    } else {
      postMessage(m);
    }
  });
};
