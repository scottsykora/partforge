// @vitest-environment happy-dom
//
// The "image" tests below route through the real `imageToPng` converter
// (kind: "image" -> registry.js's convertFor -> a dynamic import of
// image-ingest.js), same as test/image-ingest.test.js. happy-dom's own
// `createImageBitmap` does not accept a Blob at all — it only recognises
// HTMLImageElement/HTMLVideoElement/HTMLCanvasElement/OffscreenCanvas/
// ImageBitmap sources and throws a TypeError for anything else, Blob
// included (confirmed empirically against the installed happy-dom: it is a
// real gap in that implementation, not a decode failure over invalid bytes).
// Un-stubbed, that TypeError would surface as a caught conversion error in
// file-drop.js, turning every "this upload succeeds" test below into an
// unconditional failure — not what those tests are checking. Stubbed here,
// same as image-ingest.test.js, so the point under test stays the drop
// widget's OWN logic (classify -> convert -> destination ladder), not the
// browser's image codec, which neither file's stub ever really exercises.
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { makeFileDrop } from "../src/framework/panel/widgets/file-drop.js";

// registry.js's `convert` thunk for "image" is `() =>
// import("./image-ingest.js").then(...)` — a genuine dynamic import, done
// lazily so a part with no image control never pays for it. The FIRST call
// pays Vite's transform cost, which can outrun the single `setTimeout(..., 0)`
// tick `dropOn` waits below (a real flake, seen locally: whichever test
// happens to run first loses the race). Warming the module here, once, before
// any test's timing-sensitive assertion runs, keeps the point under test the
// widget's own convert -> destination-ladder logic, not import latency.
beforeAll(() => import("../src/framework/ingest/image-ingest.js"));

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeOffscreenCanvasStub() {
  return class StubOffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { drawImage() {} }; }
    async convertToBlob(opts) { return new Blob([PNG], { type: opts?.type ?? "image/png" }); }
  };
}

beforeEach(() => {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));
  vi.stubGlobal("OffscreenCanvas", makeOffscreenCanvasStub());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A File stand-in: happy-dom has File, but arrayBuffer() is what we rely on.
const fileOf = (bytes, name) => Object.assign(new Blob([bytes]), {
  name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const dropOn = async (el, ...files) => {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));   // let the async handler settle
};

describe("makeFileDrop", () => {
  test("a font needs no converter and yields its bytes unchanged", async () => {
    const onSource = vi.fn();
    const { el } = makeFileDrop({ kind: "font", onSource, onError: vi.fn() });
    const TTF = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);
    await dropOn(el, fileOf(TTF, "x.ttf"));
    expect(onSource).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onSource.mock.calls[0][0])).toEqual(TTF);
  });

  test("the wrong kind is refused and the message names the right slot", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(ascii("<svg></svg>"), "logo.svg"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/artwork/i);
  });

  test("a right-kind-wrong-format file names the formats that work", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "font", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(ascii("wOF2...."), "x.woff2"));
    expect(onError.mock.calls[0][0]).toMatch(/TTF|OTF/i);
  });

  test("unrecognised bytes are refused without guessing", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), "x.bin"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("onAssetUpload's returned string becomes the source", async () => {
    const onSource = vi.fn();
    const onAssetUpload = vi.fn(async () => "https://cdn.test/stored.png");
    const { el } = makeFileDrop({ kind: "image", onSource, onError: vi.fn(), onAssetUpload });
    await dropOn(el, fileOf(PNG, "a.png"));
    expect(onAssetUpload).toHaveBeenCalledTimes(1);
    expect(onSource).toHaveBeenCalledWith("https://cdn.test/stored.png");
  });

  test("a failed upload reports an error and does NOT lose the file", async () => {
    const onError = vi.fn();
    const onAssetUpload = vi.fn(async () => { throw new Error("quota"); });
    const { el, lastBlob } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError, onAssetUpload });
    await dropOn(el, fileOf(PNG, "a.png"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(lastBlob()).toBeTruthy();   // retryable without a reconvert
  });

  test("several files: the first is taken and the rest are reported", async () => {
    const onSource = vi.fn(); const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource, onError });
    await dropOn(el, fileOf(PNG, "a.png"), fileOf(PNG, "b.png"));
    expect(onSource).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.flat().join(" ")).toMatch(/first/i);
  });
});
