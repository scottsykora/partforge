import { buildSubPart, buildParts } from "./parts/drum/bodies.js";

// view → sub-parts (block only exists when tensioner pockets are enabled)
export function viewParts(view, params) {
  const hasBlock = (params.tensioner_pocket_depth ?? 0) > 0;
  if (view === "small") return ["small"];
  if (view === "big") return hasBlock ? ["big", "block"] : ["big"];
  return hasBlock ? ["small", "big", "block"] : ["small", "big"];
}

// handle one worker job, posting results via `post`. Backend-agnostic.
export async function handle(kernel, msg, post) {
  // Surface each feature build stage so the UI reflects real progress instead of
  // sitting on one frozen label (the OCCT export build is ~20 s of geometry work).
  const onProgress = (phase) => post({ type: "progress", phase });
  try {
    if (msg.type === "generate") {
      const t0 = Date.now();
      const meshes = [];
      for (const name of msg.subparts) {
        const m = buildSubPart(kernel, name, msg.params).toMesh({ quality: "preview" });
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        kernel.cleanup?.(); // free this sub-part's WASM objects before building the next
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
      const parts = buildParts(kernel, msg.part, msg.params, onProgress);
      const out = [];
      for (const p of parts) out.push({ name: p.name, data: await p.shape.toSTL({ quality: "print" }) });
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out });
    } else if (msg.type === "export-step") {
      const parts = buildParts(kernel, msg.part, msg.params, onProgress);
      onProgress("writing STEP file");
      const data = await kernel.toSTEP(parts.map((p) => ({ name: p.name, solid: p.shape })));
      post({ type: "download", data, filename: `${msg.part}.step`, mime: "application/step" });
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  } finally {
    kernel.cleanup?.(); // free remaining WASM objects (exports, or anything left on error)
  }
}
