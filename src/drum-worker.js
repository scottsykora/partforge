// Web Worker: boots the OpenCASCADE WASM kernel and builds the drum off the
// main thread, posting back a transferable mesh (+ an STL blob for download).

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC } from "replicad";
import { buildDrum } from "./drum.js";

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  setOC(OC);
  postMessage({ type: "ready" });
})();

self.onmessage = async (e) => {
  if (e.data?.type !== "generate") return;
  await ready;
  const t0 = performance.now();
  try {
    const drum = buildDrum(e.data.params);
    const m = drum.mesh({ tolerance: 0.01, angularTolerance: 0.2 });

    // typed arrays so we can transfer (zero-copy) into the main thread
    const positions = new Float32Array(m.vertices);
    const normals = new Float32Array(m.normals);
    const indices = new Uint32Array(m.triangles);

    let stl = null;
    try {
      stl = await drum.blobSTL().arrayBuffer(); // works in-browser MEMFS
    } catch {
      /* download is optional */
    }

    const transfer = [positions.buffer, normals.buffer, indices.buffer];
    if (stl) transfer.push(stl);
    postMessage(
      {
        type: "mesh",
        positions,
        normals,
        indices,
        stl,
        triangles: indices.length / 3,
        ms: Math.round(performance.now() - t0),
      },
      transfer
    );
  } catch (err) {
    postMessage({ type: "error", message: String(err?.message || err) });
  }
};
