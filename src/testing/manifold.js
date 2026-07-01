// Boots the Manifold WASM module in a Node process and returns a ready Manifold
// GeometryKernel — the one-call mirror of bootOcctKernel. (OCCT must NOT be booted
// in the same process — they crash together.)
import Module from "manifold-3d";
import { createManifoldKernel } from "../framework/geometry/manifold-backend.js";

export async function bootManifoldKernel({ quality = "preview" } = {}) {
  const wasm = await Module();
  wasm.setup();
  return createManifoldKernel(wasm, { quality });
}
