// Boots OCCT/replicad in a Node test process and returns a ready OCCT GeometryKernel.
// (Manifold must NOT be booted in the same process — they crash together.)
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { createOcctKernel } from "../framework/geometry/occt-backend.js";

export async function bootOcctKernel({ fonts } = {}) {
  const require = createRequire(import.meta.url);
  globalThis.require = globalThis.require ?? require;
  globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const { default: init } = await import("replicad-opencascadejs/src/replicad_single.js");
  const OC = await init({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
  const replicad = await import("replicad");
  replicad.setOC(OC);
  const kernel = createOcctKernel(replicad);
  if (fonts) { const opentype = (await import("opentype.js")).default;
    for (const [name, src] of Object.entries(fonts)) {
      const buf = ArrayBuffer.isView(src) ? src.buffer : src;
      kernel._fonts.set(name, opentype.parse(buf));
    } }
  return kernel;
}
