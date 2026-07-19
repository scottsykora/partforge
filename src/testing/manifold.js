// Boots the Manifold WASM module in a Node process and returns a ready Manifold
// GeometryKernel — the one-call mirror of bootOcctKernel. (OCCT must NOT be booted
// in the same process — they crash together.)
import Module from "manifold-3d";
import { createManifoldKernel } from "../framework/geometry/manifold-backend.js";

export async function bootManifoldKernel({ quality = "preview", fonts } = {}) {
  const wasm = await Module();
  wasm.setup();
  const kernel = createManifoldKernel(wasm, { quality });
  if (fonts) { const opentype = (await import("opentype.js")).default;
    for (const [name, src] of Object.entries(fonts)) {
      const buf = ArrayBuffer.isView(src) ? src.buffer : src;
      kernel._fonts.set(name, opentype.parse(buf));
    } }
  return kernel;
}
