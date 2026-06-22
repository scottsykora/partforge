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
      const meshes = [];
      for (const name of msg.subparts) {
        const m = buildPosed(name, "display", msg.view).toMesh({ quality: "preview" });
        meshes.push({ name, positions: m.positions, normals: m.normals, indices: m.indices, triangles: m.triangles, edges: m.edges });
        kernel.cleanup?.();
      }
      post({ type: "meshes", meshes, ms: Date.now() - t0 });
    } else if (msg.type === "export-stl") {
      const out = [];
      for (const name of viewSubParts(part, msg.view, p)) {
        onProgress(`building ${label(name)}`);
        out.push({ name: exportName(name), data: await buildPosed(name, "export", msg.view, onProgress).toSTL({ quality: "print" }) });
      }
      post({ type: "download-parts", ext: "stl", mime: "model/stl", parts: out });
    } else if (msg.type === "export-step") {
      const solids = viewSubParts(part, msg.view, p).map((name) => {
        onProgress(`building ${label(name)}`);
        return { name: exportName(name), solid: buildPosed(name, "export", msg.view, onProgress) };
      });
      onProgress("writing STEP file");
      const data = await kernel.toSTEP(solids);
      post({ type: "download", data, filename: `${msg.view}.step`, mime: "application/step" });
    }
  } catch (err) {
    post({ type: "error", message: String(err?.message || err) });
  } finally {
    kernel.cleanup?.();
  }
}
