// MAIN-THREAD ONLY. Converts any image the browser can decode into a PNG a part's
// `images` field can consume, downsampling on the way.
//
// This file uses createImageBitmap and a canvas, so it must NEVER be reachable
// from the geometry worker's import closure — test/worker-layering.test.js
// enforces that. It is exported from src/index.js, the DOM entry documented as
// one a part's `build` must never import.
//
// Why PNG and not the source format: core decodes PNG only, in pure JS, so one
// decoder produces the geometry in the browser, the CLI and CI alike. Converting
// once at ingest keeps that single decoder authoritative — the browser's codec
// output is baked into an immutable PNG rather than racing ours at build time.
//
// Why downsample instead of switching to JPEG: pitch caps useful resolution
// anyway (a 60mm plate at 0.3mm pitch samples 200x200), and JPEG is 8-bit and
// DCT-ringing — in a depth map those are geometric artifacts, height terracing
// and 8x8 block bumps, not cosmetic ones.

export async function imageToPng(fileOrBlob, { maxSize = 1024 } = {}) {
  const bmp = await createImageBitmap(fileOrBlob);
  try {
    const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    if (typeof OffscreenCanvas === "function") {
      const c = new OffscreenCanvas(w, h);
      c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return await c.convertToBlob({ type: "image/png" });
    }
    // Safari and older engines: fall back to a detached <canvas>.
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    return await new Promise((res, rej) =>
      c.toBlob((b) => (b ? res(b) : rej(new Error("imageToPng: canvas encoding failed"))), "image/png"));
  } finally {
    bmp.close?.();
  }
}
