// Web Worker: lazy OCCT geometry backend — boots on first use (~11 MB WASM).
// Handles export-step (and generate when ?backend=occt toggle is active).
// Posts progress { type:"progress", phase:"loading exact kernel" } before boot
// so the UI shows feedback during the cold start.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import * as replicad from "replicad";
import { createOcctKernel } from "./framework/geometry/occt-backend.js";
import { handle } from "./geometry-jobs.js";

let kernel = null;
let booting = null;

async function occtKernel() {
  if (kernel) return kernel;
  if (!booting) {
    booting = (async () => {
      const OC = await opencascade({ locateFile: () => wasmUrl });
      replicad.setOC(OC);
      kernel = createOcctKernel(replicad);
      return kernel;
    })();
  }
  return booting;
}

self.onmessage = async (e) => {
  if (!kernel) postMessage({ type: "progress", phase: "loading exact kernel" });
  const k = await occtKernel();
  await handle(k, e.data, (m) => postMessage(m, m.type === "download" ? [m.data] : []));
};
