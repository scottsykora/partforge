import { buildSubPart, buildParts } from "./drum.js";

// view → sub-parts (block only exists when tensioner pockets are enabled)
export function viewParts(view, params) {
  const hasBlock = (params.tensioner_pocket_depth ?? 0) > 0;
  if (view === "small") return ["small"];
  if (view === "big") return hasBlock ? ["big", "block"] : ["big"];
  return hasBlock ? ["small", "big", "block"] : ["small", "big"];
}

// handle one worker job, posting results via `post`. Backend-agnostic.
export async function handle(kernel, msg, post) {
  try {
    if (msg.type === "generate") {
      const t0 = Date.now();
      const meshes = msg.subparts.map((name) => {
        const m = buildSubPart(kernel, name, msg.params).toMesh({ quality: "preview" });
        return { name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles };
      });
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
      const parts = buildParts(kernel, msg.part, msg.params);
      const out = [];
      for (const p of parts) out.push({ name: p.name, data: await p.shape.toSTL({ quality: "print" }) });
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out });
    } else if (msg.type === "export-step") {
      const parts = buildParts(kernel, msg.part, msg.params);
      const data = await kernel.toSTEP(parts.map((p) => ({ name: p.name, solid: p.shape })));
      post({ type: "download", data, filename: `${msg.part}.step`, mime: "application/step" });
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  }
}
