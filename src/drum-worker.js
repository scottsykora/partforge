// Web Worker: boots the OpenCASCADE WASM kernel and builds the drum off the
// main thread. Posts phase progress, a coarse display mesh (fast), and — only
// on request — print-grade STL/STEP for download. When the view has two parts
// (the "Both" view) each is exported separately and bundled into a zip, since a
// compound trips up the STEP/STL writers.

import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import wasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import * as replicad from "replicad";
import { zipSync } from "fflate";
import { createOcctKernel } from "./geometry/occt-backend.js";
import { buildParts, buildSubPart } from "./drum.js";

let kernel;
const ready = (async () => {
  const OC = await opencascade({ locateFile: () => wasmUrl });
  replicad.setOC(OC);
  kernel = createOcctKernel(replicad);
  postMessage({ type: "ready" });
})();

let lastParts = null; // [{ name, shape }]
let lastKey = null; // `${part}:${JSON.stringify(params)}` the built parts are for

const progress = (phase) => postMessage({ type: "progress", phase });

function disposeLast() {
  // Kernel-wrapped solids don't expose .delete() — just drop the references
  // and let GC handle it. OCCT's underlying C++ objects are finalized when
  // replicad's own GC runs, which it does automatically.
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
  lastParts = buildParts(kernel, part, params, prog);
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
        const solid = buildSubPart(kernel, name, msg.params, progress);
        const m = solid.toMesh({ quality: "preview" });
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles });
        transfer.push(m.positions.buffer, m.normals.buffer, m.indices.buffer);
      }
      postMessage(
        { type: "meshes", meshes, ms: Math.round(performance.now() - t0) },
        transfer
      );
    } catch (err) {
      postMessage({ type: "error", message: String(err?.message || err) });
    }
  } else if (msg.type === "export-stl") {
    await exportParts(
      "stl", "model/stl",
      (solid) => solid.toSTL({ quality: "print" }),
      msg.part, msg.params
    );
  } else if (msg.type === "export-step") {
    await exportParts(
      "step", "application/step",
      null, // signals STEP multi-part export below
      msg.part, msg.params
    );
  }
};

// Export the part: one file if it's a single solid, else a zip of named per-part
// files. Rebuilds the requested part first if it isn't the one currently built
// (e.g. exporting a tab the main thread had cached).
async function exportParts(ext, mime, toBuffer, part, params) {
  try {
    const parts = ensureBuilt(part, params, progress);
    progress(`exporting ${ext.toUpperCase()}`);
    if (parts.length === 1) {
      let data;
      if (toBuffer) {
        data = await toBuffer(parts[0].shape);
      } else {
        // STEP: use kernel.toSTEP for single part too (keeps one code path)
        data = await kernel.toSTEP([{ name: parts[0].name, solid: parts[0].shape }]);
      }
      postMessage({ type: "download", data, filename: `${parts[0].name}.${ext}`, mime });
    } else {
      if (toBuffer) {
        // STL: one file per part, zipped
        const entries = {};
        for (const p of parts) {
          entries[`${p.name}.${ext}`] = new Uint8Array(await toBuffer(p.shape));
        }
        const zip = zipSync(entries, { level: 0 });
        postMessage({ type: "download", data: zip, filename: "drums.zip", mime: "application/zip" });
      } else {
        // STEP: multi-body export via kernel.toSTEP
        const data = await kernel.toSTEP(parts.map((p) => ({ name: p.name, solid: p.shape })));
        postMessage({ type: "download", data, filename: "drums.step", mime });
      }
    }
  } catch (err) {
    postMessage({ type: "error", message: `${ext.toUpperCase()} export failed: ` + (err?.message || err) });
  }
}
