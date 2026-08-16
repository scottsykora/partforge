// Boots the Manifold WASM module in a Node process and returns a ready Manifold
// GeometryKernel — the one-call mirror of bootOcctKernel. (OCCT must NOT be booted
// in the same process — they crash together.)
import Module from "manifold-3d";
import { createManifoldKernel } from "../framework/geometry/manifold-backend.js";
import { resolveFonts } from "../framework/fonts.js";
import { ensureImports } from "../framework/imports.js";
import { nodeAssetSources } from "./assets.js";

export async function bootManifoldKernel({ quality = "preview", fonts, imports, importMeshes } = {}) {
  const wasm = await Module();
  wasm.setup();
  const kernel = createManifoldKernel(wasm, { quality });
  if (fonts) { const opentype = (await import("opentype.js")).default;
    for (const [name, buf] of await resolveFonts(nodeAssetSources(fonts))) kernel._fonts.set(name, opentype.parse(buf)); }
  if (imports) await ensureImports(kernel, nodeAssetSources(imports), importMeshes ?? null);
  return kernel;
}
