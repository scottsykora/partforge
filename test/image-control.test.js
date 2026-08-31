// @vitest-environment happy-dom
//
// The brief this file was written from (task-8-brief.md) has a `buildControls`
// signature that does not exist — `buildControls(part, params, onChange)`
// returning an element. The real signature takes a root element and a sections
// array and mutates the root in place; see render.js and
// test/mount-font-catalog.test.js (the precedent this file mirrors) for the
// real shape.
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { buildControls } from "../src/framework/panel/render.js";
import { imageLabel } from "../src/framework/panel/widgets/image.js";

const URL_SRC = "https://cdn.test/depth-map.png";
const sec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "relief", type: "image", label: "Depth map", ...over },
] });

test("with no catalog the control is a plain URL text field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {});
  const field = root.querySelector("input.text-input");
  expect(field).toBeTruthy();
  expect(root.querySelector("button.image-btn")).toBeNull();
  expect(field.value).toBe(URL_SRC);
});

test("a URL typed into the bare field lands in params on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: "" };
  buildControls(root, [sec()], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "https://cdn.test/d.png";
  field.dispatchEvent(new Event("change", { bubbles: true }));
  expect(params.relief).toBe("https://cdn.test/d.png");
});

test("the degraded field refuses an out-of-allow value on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec({ allow: ["asset"] })], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "http://evil.test/x.png";
  field.dispatchEvent(new Event("change"));
  expect(params.relief).toBe(URL_SRC);               // unchanged
  expect(field.classList.contains("warn")).toBe(true);
});

test("buildControls forwards imageCatalog to the image widget — a picker button, not a bare field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const catalog = { async search() { return []; } };
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {}, undefined, { imageCatalog: catalog });
  expect(root.querySelector("button.image-btn"), "catalog present → button form").toBeTruthy();
  expect(root.querySelector("input.text-input")).toBeNull();
});

test("without the option the same control degrades", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {});
  expect(root.querySelector("input.text-input"), "no catalog → text field").toBeTruthy();
});

test("with a catalog and a URL value, the button is labelled via describe()", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {}, undefined, {
    imageCatalog: {
      async search() { return []; },
      describe: (src) => (src === URL_SRC ? { label: "Rocky terrain", width: 512, height: 512 } : null),
    },
  });
  await new Promise((r) => setTimeout(r, 0));           // describe may be async
  expect(root.querySelector(".iname").textContent).toBe("Rocky terrain (512×512)");
});

test("with a catalog but no describe(), the button falls back to the URL's filename", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {}, undefined,
    { imageCatalog: { async search() { return []; } } });
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".iname").textContent).toBe("depth-map.png");
});

// ── the byte-valued param — the cloud sandbox path ─────────────────────────
// partforge-cloud's sandbox cannot fetch URLs, so it writes PNG bytes straight
// into the param. This is not an edge case for that host; it is the normal
// path. The widget must show something honest for it, never throw, and never
// render a broken-image icon or "[object ArrayBuffer]".

test("a byte-valued param with a catalog renders an honest label, not [object ArrayBuffer]", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: new ArrayBuffer(8) };
  expect(() => buildControls(root, [sec()], params, () => {}, undefined,
    { imageCatalog: { async search() { return []; } } })).not.toThrow();
  const btn = root.querySelector("button.image-btn");
  expect(btn).toBeTruthy();
  expect(btn.textContent).not.toContain("[object ArrayBuffer]");
  expect(root.querySelector(".iname").textContent).toBe("Uploaded image");
  // No src on either <img> — never a broken-image glyph for bytes.
  const preview = root.querySelector("img.image-preview");
  const thumb = root.querySelector("img.image-btn-thumb");
  expect(preview.hidden).toBe(true);
  expect(preview.hasAttribute("src")).toBe(false);
  expect(thumb.hidden).toBe(true);
  expect(thumb.hasAttribute("src")).toBe(false);
});

test("a byte-valued param asks describe() for dimensions and shows Uploaded image (WxH)", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const bytes = new ArrayBuffer(16);
  const params = { relief: bytes };
  buildControls(root, [sec()], params, () => {}, undefined, {
    imageCatalog: {
      async search() { return []; },
      describe: (src) => (src === bytes ? { width: 64, height: 48 } : null),
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".iname").textContent).toBe("Uploaded image (64×48)");
});

test("a Uint8Array-valued param (a typed-array view, not a bare ArrayBuffer) is also honest", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: new Uint8Array([1, 2, 3]) };
  buildControls(root, [sec()], params, () => {}, undefined,
    { imageCatalog: { async search() { return []; } } });
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".iname").textContent).toBe("Uploaded image");
});

test("a byte-valued param with NO catalog degrades without corrupting the field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: new ArrayBuffer(4) };
  expect(() => buildControls(root, [sec()], params, () => {})).not.toThrow();
  const field = root.querySelector("input.text-input");
  expect(field.value).toBe("");                         // never "[object ArrayBuffer]"
  expect(field.placeholder).toBe("Uploaded image");
  const preview = root.querySelector("img.image-preview");
  expect(preview.hidden).toBe(true);
  expect(preview.hasAttribute("src")).toBe(false);
});

test("sync repaints the button from params, including a switch to bytes", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  const panel = buildControls(root, [sec()], params, () => {}, undefined,
    { imageCatalog: { async search() { return []; } } });
  params.relief = new ArrayBuffer(2);
  panel.syncValues();
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".iname").textContent).toBe("Uploaded image");
});

// ── imageLabel — the pure filename-extraction helper ───────────────────────

test("imageLabel reads the filename off a URL", () => {
  expect(imageLabel("https://cdn.test/assets/depth-map.png")).toBe("depth-map.png");
});

test("imageLabel falls back to 'No image' for unset values", () => {
  expect(imageLabel("")).toBe("No image");
  expect(imageLabel(undefined)).toBe("No image");
  expect(imageLabel(null)).toBe("No image");
});

test("imageLabel never throws on junk, including bytes", () => {
  for (const junk of ["", "not a url", null, undefined, 42, new ArrayBuffer(1)]) {
    expect(() => imageLabel(junk)).not.toThrow();
  }
});

// ── the drop target — Task 6's adoption of makeFileDrop ────────────────────
//
// A dropped PNG goes through the REAL "image" converter (registry.js's
// convertFor("image", ...) always resolves to imageToPng, even when the
// input is already a PNG — there is no "already the right format, skip
// conversion" shortcut), which decodes via `createImageBitmap` on a Blob.
// happy-dom's `createImageBitmap` does not accept a Blob source at all (only
// HTMLImageElement/HTMLVideoElement/HTMLCanvasElement/OffscreenCanvas/
// ImageBitmap) and throws a TypeError — a real gap in that implementation,
// not a decode failure over invalid bytes. test/file-drop.test.js hits the
// same gap and stubs `createImageBitmap`/`OffscreenCanvas` around it; this
// file needs the identical stub for the same reason, or every drop here
// fails conversion and lands in onError instead of the param. The brief for
// this task did not mention the stub — see the task-6 report.
describe("the drop target", () => {
  beforeEach(() => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 4, close: vi.fn() })));
    vi.stubGlobal("OffscreenCanvas", class StubOffscreenCanvas {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {} }; }
      async convertToBlob(opts) { return new Blob([new Uint8Array([1, 2, 3])], { type: opts?.type ?? "image/png" }); }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("an image control renders a drop target alongside its field", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
      { relief: "" }, () => {});
    expect(root.querySelector("[data-pf-drop]"), "drop target present").toBeTruthy();
  });

  test("dropping a PNG with no upload hook puts bytes in the param", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const params = { relief: "" };
    buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
      params, () => {});
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = Object.assign(new Blob([PNG]), {
      name: "d.png", arrayBuffer: async () => PNG.buffer.slice(0),
    });
    const el = root.querySelector("[data-pf-drop]");
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
    el.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));
    expect(params.relief).toBeInstanceOf(ArrayBuffer);
  });

  test("a panel rebuild disposes the drop widget — no stray listener keeps the old params alive", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const params = { relief: "" };
    const panel = buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
      params, () => {});
    const dropEl = root.querySelector("[data-pf-drop]");
    panel.dispose();
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [] } });
    expect(() => dropEl.dispatchEvent(ev)).not.toThrow();
    expect(params.relief).toBe("");                      // disposed: never wrote back
  });

  test("the drop target coexists with the catalog button, and errors render verbatim", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const params = { relief: "" };
    buildControls(root, [sec()], params, () => {}, undefined,
      { imageCatalog: { async search() { return []; } } });
    expect(root.querySelector("button.image-btn"), "catalog button still present").toBeTruthy();
    const dropEl = root.querySelector("[data-pf-drop]");
    expect(dropEl, "drop target present alongside the catalog button").toBeTruthy();

    const TXT = Uint8Array.from([1, 2, 3, 4]);
    const file = Object.assign(new Blob([TXT]), {
      name: "not-an-image.txt", arrayBuffer: async () => TXT.buffer.slice(0),
    });
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
    dropEl.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 0));
    const errorEl = root.querySelector(".file-drop-error");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("not-an-image.txt");
  });
});
