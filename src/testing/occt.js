// Boots OCCT/replicad in a Node test process and returns a ready OCCT GeometryKernel.
// (Manifold must NOT be booted in the same process — they crash together.)
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { createOcctKernel } from "../framework/geometry/occt-backend.js";
import { resolveFonts } from "../framework/fonts.js";
import { normalizeOpentype, parseFont } from "../framework/geometry/opentype-interop.js";
import { ensureImports } from "../framework/imports.js";
import { ensureImages } from "../framework/images.js";
import { ensureVectors } from "../framework/vectors.js";
import { nodeAssetSources } from "./assets.js";

export async function bootOcctKernel({ fonts, imports, importMeshes, images, vectors } = {}) {
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  const replicad = await import("replicad");
  replicad.setOC(OC);
  const kernel = createOcctKernel(replicad);
  if (fonts) { const opentype = normalizeOpentype(await import("opentype.js"));
    for (const [name, buf] of await resolveFonts(nodeAssetSources(fonts))) kernel._fonts.set(name, parseFont(opentype, buf, name)); }
  if (imports) await ensureImports(kernel, nodeAssetSources(imports), importMeshes ?? null);
  // Third asset sibling: see bootManifoldKernel's matching comment.
  if (images && Object.keys(images).length) await ensureImages(kernel, nodeAssetSources(images));
  if (vectors) await ensureVectors(kernel, nodeAssetSources(vectors));
  return kernel;
}
