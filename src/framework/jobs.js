import { meshTo3MF } from "./geometry/threemf.js";

// Names of the sub-parts a view shows: declared in the view and enabled for these
// params. Order follows Object.keys(part.parts) (definition order).
export function viewSubParts(part, view, params) {
  return Object.keys(part.parts).filter((name) => {
    const sp = part.parts[name];
    const inView = sp.views.includes(view);
    const on = sp.enabled ? !!sp.enabled(params) : true;
    return inView && on;
  });
}

// Sub-parts to include in an EXPORT of this view: the visible sub-parts, minus any
// flagged `exportable: false` (reference/preview-only parts — motor ghosts, bearing
// placeholders, etc.). They still show in the viewer; they're just never written to
// an STL/STEP/3MF file, so the user never has to toggle them off before exporting.
export function exportSubParts(part, view, params) {
  return viewSubParts(part, view, params).filter((name) => part.parts[name].exportable !== false);
}

// Handle one geometry job, posting results/progress via `post`. Backend-agnostic
// and part-agnostic: every part specific comes through `part`.
//   { type:"generate", subparts, view, params } → { type:"meshes", meshes, ms }
//   { type:"export-stl", view, params }         → { type:"download-parts", ext, mime, parts }
//   { type:"export-step", view, params }        → { type:"download", data, filename, mime }
// Progress is posted as { type:"progress", phase }. Export builds thread the
// progress callback into build() so a part's own per-feature progress surfaces;
// preview generates stay quiet (no callback) to avoid flicker during slider drags.
export async function handle(kernel, part, msg, post) {
  const onProgress = (phase) => post({ type: "progress", phase });
  const p = { ...part.defaults, ...msg.params };
  const d = part.derive ? part.derive(p) : {};
  const label = (name) => part.parts[name].label ?? name;
  const exportName = (name) => part.parts[name].export?.name ?? name;
  const buildPosed = (name, purpose, view, prog) => {
    const sp = part.parts[name];
    const solid = sp.build(kernel, p, d, prog);
    return sp.place ? sp.place(solid, { view, purpose, p, d }) : solid;
  };

  try {
    if (msg.type === "generate") {
      const t0 = Date.now();
      const useCache = msg.cache !== false; // ?debug toggle can disable caching (cache:false)
      const meshes = [];
      kernel.resetCacheStats?.(); // count hits/misses for just this job
      for (const name of msg.subparts) {
        if (useCache) kernel.beginSubPart?.(name); // open the per-sub-part cache round
        try {
          const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
          meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        } finally {
          if (useCache) kernel.endSubPart?.(); // always close the bracket — a throw mid-build must not strand pinned solids
          kernel.cleanup?.();                  // free this round's transients (cached/pinned solids survive)
        }
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0, cache: kernel.cacheStats?.() });
    } else if (msg.type === "export-stl") {
      const out = [];
      for (const name of exportSubParts(part, msg.view, p)) {
        onProgress(`building ${label(name)}`);
        out.push({ name: exportName(name), data: await buildPosed(name, "export", msg.view, onProgress).toSTL({ quality: "print" }) });
      }
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out });
    } else if (msg.type === "export-step") {
      const solids = exportSubParts(part, msg.view, p).map((name) => {
        onProgress(`building ${label(name)}`);
        return { name: exportName(name), solid: buildPosed(name, "export", msg.view, onProgress) };
      });
      onProgress("writing STEP file");
      const data = await kernel.toSTEP(solids);
      post({ type: "download", data, filename: `${msg.view}.step`, mime: "application/step" });
    } else if (msg.type === "export-3mf") {
      const meshes = exportSubParts(part, msg.view, p).map((name) => {
        onProgress(`building ${label(name)}`);
        const { positions, indices } = buildPosed(name, "export", msg.view, onProgress).toIndexedMesh();
        return { name: exportName(name), positions, indices };
      });
      onProgress("writing 3MF file");
      post({ type: "download", data: meshTo3MF(meshes), filename: `${msg.view}.3mf`, mime: "model/3mf" });
    }
  } catch (err) {
    if (err?.code === "NEEDS_OCCT") post({ type: "needs-occt" });
    else post({ type: "error", message: String(err?.message || err) });
  } finally {
    kernel.cleanup?.();
  }
}
