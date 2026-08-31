// @vitest-environment happy-dom
//
// imageToPng is main-thread only (createImageBitmap + canvas), so it needs a DOM —
// happy-dom supplies `document`. Node has neither createImageBitmap nor
// OffscreenCanvas, so both are stubbed per-test below. The point under test is the
// resize policy, the PNG output contract, and bitmap cleanup — not the browser's
// codec, which these stubs never actually exercise.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { imageToPng } from "../src/framework/ingest/image-ingest.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// A fresh OffscreenCanvas stub per call, so each test can inspect exactly the
// dimensions imageToPng constructed it with and exactly what drawImage received,
// without one test's class leaking into another's assertions.
function makeOffscreenCanvasStub({ onConvertToBlob } = {}) {
  const calls = { constructed: [], drawImage: [] };
  class StubOffscreenCanvas {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      calls.constructed.push([w, h]);
    }
    getContext(kind) {
      expect(kind).toBe("2d");
      return {
        drawImage: (...args) => calls.drawImage.push(args),
      };
    }
    async convertToBlob(opts) {
      if (onConvertToBlob) return onConvertToBlob(opts);
      return new Blob([PNG_BYTES], { type: "image/png" });
    }
  }
  return { StubOffscreenCanvas, calls };
}

function makeBitmap(width, height) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  // Default happy-path stubs; individual tests override createImageBitmap's
  // resolved bitmap or OffscreenCanvas's behavior as needed.
  vi.stubGlobal("createImageBitmap", vi.fn(async () => makeBitmap(300, 200)));
  const { StubOffscreenCanvas } = makeOffscreenCanvasStub();
  vi.stubGlobal("OffscreenCanvas", StubOffscreenCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("downsamples the long edge to maxSize and preserves aspect", async () => {
  const bmp = makeBitmap(4096, 2048);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp));
  const { StubOffscreenCanvas, calls } = makeOffscreenCanvasStub();
  vi.stubGlobal("OffscreenCanvas", StubOffscreenCanvas);

  await imageToPng(new Blob([]), { maxSize: 1024 });

  expect(calls.constructed).toEqual([[1024, 512]]);
  // drawImage must actually be told to draw into the downsampled box, not just
  // have a canvas of that size sitting unused.
  expect(calls.drawImage).toEqual([[bmp, 0, 0, 1024, 512]]);
});

test("does not upscale an image already under maxSize", async () => {
  const bmp = makeBitmap(300, 200);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp));
  const { StubOffscreenCanvas, calls } = makeOffscreenCanvasStub();
  vi.stubGlobal("OffscreenCanvas", StubOffscreenCanvas);

  await imageToPng(new Blob([]), { maxSize: 1024 });

  expect(calls.constructed).toEqual([[300, 200]]);
});

test("returns a PNG blob", async () => {
  const out = await imageToPng(new Blob([]));
  expect(out).toBeInstanceOf(Blob);
  expect(out.type).toBe("image/png");
  const bytes = new Uint8Array(await out.arrayBuffer());
  expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));
});

test("closes the bitmap even when canvas encoding throws", async () => {
  const bmp = makeBitmap(300, 200);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp));
  const { StubOffscreenCanvas } = makeOffscreenCanvasStub({
    onConvertToBlob: () => {
      throw new Error("boom: encoder exploded");
    },
  });
  vi.stubGlobal("OffscreenCanvas", StubOffscreenCanvas);

  await expect(imageToPng(new Blob([]))).rejects.toThrow("boom: encoder exploded");
  // The bitmap is a native resource — close() must run on the throwing path,
  // not only on success, or a failed ingest leaks one bitmap per attempt.
  expect(bmp.close).toHaveBeenCalledTimes(1);
});

test("falls back to a <canvas> element when OffscreenCanvas is unavailable", async () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const bmp = makeBitmap(300, 200);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp));

  const drawImageCalls = [];
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: (kind) => {
      expect(kind).toBe("2d");
      return { drawImage: (...args) => drawImageCalls.push(args) };
    },
    toBlob: (cb, type) => {
      expect(type).toBe("image/png");
      cb(new Blob([PNG_BYTES], { type: "image/png" }));
    },
  };
  const createElementSpy = vi
    .spyOn(document, "createElement")
    .mockImplementation((tag) => (tag === "canvas" ? fakeCanvas : document.createElement.wrappedMethod?.(tag)));

  const out = await imageToPng(new Blob([]), { maxSize: 1024 });

  expect(createElementSpy).toHaveBeenCalledWith("canvas");
  expect(fakeCanvas.width).toBe(300);
  expect(fakeCanvas.height).toBe(200);
  expect(drawImageCalls).toEqual([[bmp, 0, 0, 300, 200]]);
  expect(out.type).toBe("image/png");
  expect(bmp.close).toHaveBeenCalledTimes(1);
});

test("<canvas> fallback rejects with a real error, not an unhandled rejection, when encoding fails", async () => {
  vi.stubGlobal("OffscreenCanvas", undefined);
  const bmp = makeBitmap(300, 200);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bmp));

  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
    // Simulates a real <canvas>.toBlob callback firing with null — the
    // documented failure mode (e.g. a tainted or zero-size canvas).
    toBlob: (cb) => cb(null),
  };
  vi.spyOn(document, "createElement").mockImplementation((tag) => (tag === "canvas" ? fakeCanvas : {}));

  await expect(imageToPng(new Blob([]))).rejects.toThrow(/encoding failed/i);
  expect(bmp.close).toHaveBeenCalledTimes(1);
});
