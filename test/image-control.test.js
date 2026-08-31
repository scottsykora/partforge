// @vitest-environment happy-dom
//
// The brief this file was written from (task-8-brief.md) has a `buildControls`
// signature that does not exist — `buildControls(part, params, onChange)`
// returning an element. The real signature takes a root element and a sections
// array and mutates the root in place; see render.js and
// test/mount-font-catalog.test.js (the precedent this file mirrors) for the
// real shape.
import { expect, test, describe, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { buildControls } from "../src/framework/panel/render.js";
import { imageLabel } from "../src/framework/panel/widgets/image.js";

const URL_SRC = "https://cdn.test/depth-map.png";
const sec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "relief", type: "image", label: "Depth map", ...over },
] });

// The URL field is opt-in (`sourceField`), so every test below that is ABOUT the
// field asks for it. The default — no field — is covered in the sourceField block.
test("with no catalog and sourceField, the control is a plain URL text field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec({ sourceField: true })], params, () => {});
  const field = root.querySelector("input.text-input");
  expect(field).toBeTruthy();
  expect(root.querySelector("button.image-btn")).toBeNull();
  expect(field.value).toBe(URL_SRC);
});

test("a URL typed into the bare field lands in params on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: "" };
  buildControls(root, [sec({ sourceField: true })], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "https://cdn.test/d.png";
  field.dispatchEvent(new Event("change", { bubbles: true }));
  expect(params.relief).toBe("https://cdn.test/d.png");
});

test("the degraded field refuses an out-of-allow value on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec({ allow: ["asset"], sourceField: true })], params, () => {});
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

test("without the option the same control degrades to a drop tile", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: URL_SRC };
  buildControls(root, [sec()], params, () => {});
  expect(root.querySelector("button.image-btn"), "no catalog → no picker button").toBeNull();
  expect(root.querySelector("[data-pf-drop]"), "the tile is the way in").toBeTruthy();
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
  // Bytes used to leave both <img>s hidden and src-less. They now carry an object
  // URL so the cloud path gets a real thumbnail — the original intent ("never a
  // broken-image glyph") is preserved, the mechanism changed. Both images must
  // share ONE url: resolving per-image would revoke the first one's blob.
  const preview = root.querySelector("img.image-preview");
  const thumb = root.querySelector("img.image-btn-thumb");
  expect(preview.hidden).toBe(false);
  expect(preview.getAttribute("src")).toMatch(/^blob:/);
  expect(thumb.getAttribute("src")).toBe(preview.getAttribute("src"));
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
  expect(() => buildControls(root, [sec({ sourceField: true })], params, () => {})).not.toThrow();
  const field = root.querySelector("input.text-input");
  expect(field.value).toBe("");                         // never "[object ArrayBuffer]"
  expect(field.placeholder).toBe("Uploaded image");
  // Same contract change as the catalog case above: bytes now render a thumbnail
  // via an object URL rather than leaving the preview blank. The field itself is
  // what this test is really about, and it is untouched.
  const preview = root.querySelector("img.image-preview");
  expect(preview.hidden).toBe(false);
  expect(preview.getAttribute("src")).toMatch(/^blob:/);
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
//
// The registry's `convert` for "image" is a genuine dynamic import
// (`() => import("./image-ingest.js").then(...)`), done lazily so a part
// with no image control never pays for it. The FIRST call pays Vite's
// transform cost, which can outrun the single `setTimeout(..., 0)` tick the
// drop tests below wait on — a real flake seen when this file runs alone
// (fix round 1: `npx vitest run test/image-control.test.js` failed solo with
// `expected '' to be an instance of ArrayBuffer` even though the stub above
// was in place, because the import hadn't resolved yet). test/file-drop.test.js
// hit the identical race and fixed it with a `beforeAll` warm-up; this needs
// the same one, run once before any test in this block.
describe("the drop target", () => {
  beforeAll(() => import("../src/framework/ingest/image-ingest.js"));

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

  test("a panel rebuild disposes the drop widget — no stray listener keeps the old params alive", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const params = { relief: "" };
    const panel = buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
      params, () => {});
    const dropEl = root.querySelector("[data-pf-drop]");
    panel.dispose();
    // A REAL file — the same PNG the other tests use — not an empty file
    // list. `handleFiles` returns immediately on an empty list, before ever
    // touching the disposed AbortController, so an empty-list drop passes
    // whether or not dispose() is wired (fix round 1 caught this: the
    // reviewer removed `drop.dispose()` from both render paths and this
    // test still passed). A real file forces the listener itself to have
    // been removed for the assertion below to hold.
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = Object.assign(new Blob([PNG]), {
      name: "d.png", arrayBuffer: async () => PNG.buffer.slice(0),
    });
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
    expect(() => dropEl.dispatchEvent(ev)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
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

// ── thumbnail of a byte-valued source ────────────────────────────────────────
// The cloud sandbox puts converted PNG bytes straight in the param, so the
// preview cannot be a URL. It becomes an object URL instead — which is a real
// resource: every one that is not revoked pins its blob for the tab's lifetime,
// and a panel rebuild constructs a fresh widget each time.
describe("byte-valued preview", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = () => PNG.buffer.slice(0);

  const spyUrls = () => {
    const created = [], revoked = [];
    const c = URL.createObjectURL, r = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { const u = `blob:test/${created.length}`; created.push(u); return u; };
    URL.revokeObjectURL = (u) => { revoked.push(u); };
    return { created, revoked, restore: () => { URL.createObjectURL = c; URL.revokeObjectURL = r; } };
  };

  test("shows a thumbnail for bytes instead of hiding the preview", () => {
    const spy = spyUrls();
    try {
      document.body.innerHTML = '<div id="root"></div>';
      const root = document.getElementById("root");
      buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
        { relief: bytes() }, () => {});
      const img = root.querySelector("img");
      expect(img, "an <img> is rendered").toBeTruthy();
      expect(img.hidden, "and it is visible, not hidden as before").toBe(false);
      expect(img.getAttribute("src")).toBe(spy.created[0]);
    } finally { spy.restore(); }
  });

  test("revokes the previous object URL when the value changes", () => {
    const spy = spyUrls();
    try {
      document.body.innerHTML = '<div id="root"></div>';
      const root = document.getElementById("root");
      const params = { relief: bytes() };
      const panel = buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
        params, () => {});
      params.relief = bytes();
      panel.syncValues?.(["relief"]);
      expect(spy.created.length, "a second URL was made").toBe(2);
      expect(spy.revoked, "the first was revoked").toContain(spy.created[0]);
    } finally { spy.restore(); }
  });

  test("revokes on dispose — otherwise every panel rebuild leaks a blob", () => {
    const spy = spyUrls();
    try {
      document.body.innerHTML = '<div id="root"></div>';
      const root = document.getElementById("root");
      const panel = buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
        { relief: bytes() }, () => {});
      panel.dispose?.();
      expect(spy.revoked).toContain(spy.created[0]);
    } finally { spy.restore(); }
  });

  test("a string source still uses the URL directly, creating no object URL", () => {
    const spy = spyUrls();
    try {
      document.body.innerHTML = '<div id="root"></div>';
      const root = document.getElementById("root");
      buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
        { relief: "https://cdn.test/d.png" }, () => {});
      expect(root.querySelector("img").getAttribute("src")).toBe("https://cdn.test/d.png");
      expect(spy.created.length, "no blob URL for a plain URL source").toBe(0);
    } finally { spy.restore(); }
  });
});

// ── sourceField ──────────────────────────────────────────────────────────────
// The tile is preview, drop target and click-to-choose in one. The URL field is a
// fourth affordance for the same job, and on a 288 px rail it is the one earning
// its space least — so it is OFF unless the author asks for it. Typing a source
// by hand (an https URL, a pfc-asset token) is the rarer intent, so that is the
// part that opts in rather than the part every control pays rail height for.
describe("sourceField", () => {
  const mount = (extra) => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map", ...extra }] }],
      { relief: "" }, () => {});
    return root;
  };

  test("no URL field by default, but the drop tile is there", () => {
    const root = mount({});
    expect(root.querySelector("input.text-input"), "default hides the field").toBeNull();
    expect(root.querySelector("[data-pf-drop]"), "the tile is still there").toBeTruthy();
  });

  test("sourceField: true brings the field back", () => {
    expect(mount({ sourceField: true }).querySelector("input.text-input")).toBeTruthy();
  });

  test("sourceField: false is the default, not an error", () => {
    expect(mount({ sourceField: false }).querySelector("input.text-input")).toBeNull();
  });
});

test("an author's `allow` reaches the widget — it was being dropped in desugar", () => {
  // authoredControl() rebuilds each control from an explicit field list. `allow`
  // was not on it, so every authored control fell back to the default allow list
  // in the widget's own typed-URL check. The worker-side gate was unaffected —
  // imageControlAllows walks the raw authored tree — so a narrowed list was
  // enforced correctly but the panel accepted values it should have refused,
  // then had them reset underneath the user.
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: "" };
  buildControls(root, [{ id: "s", controls: [
    { key: "relief", type: "image", label: "Depth map", allow: ["asset"], sourceField: true },
  ] }], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "https://cdn.test/x.png";              // https, but allow is ["asset"] only
  field.dispatchEvent(new Event("change", { bubbles: true }));
  expect(params.relief, "an out-of-allow value must not be written").toBe("");
  expect(field.classList.contains("warn"), "and the field says so").toBe(true);
});

test("opens showing the part's declared image, not an empty tile", async () => {
  // The bundled default lives in the `images` declaration — an author cannot put
  // it in `defaults`, because the allow list passes only https and a bundled
  // asset is a file:/dev URL. Without this the control opened blank while the
  // part was plainly building from an image.
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [sec()], { relief: "" }, () => {}, undefined,
    { declaredSource: () => "https://cdn.test/bundled.png" });
  // Resolution is async — a declared source may be a Vite thunk that has to be
  // called — so the tile paints empty first and fills in on the next tick.
  await new Promise((r) => setTimeout(r, 0));
  const img = root.querySelector("img.image-preview");
  expect(img.hidden).toBe(false);
  expect(img.getAttribute("src")).toBe("https://cdn.test/bundled.png");
});

test("the param wins over the declaration once the user picks something", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [sec()], { relief: "https://cdn.test/picked.png" }, () => {}, undefined,
    { declaredSource: () => "https://cdn.test/bundled.png" });
  expect(root.querySelector("img.image-preview").getAttribute("src")).toBe("https://cdn.test/picked.png");
});

test("no declaredSource provider — the tile is simply empty, nothing throws", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  expect(() => buildControls(root, [sec()], { relief: "" }, () => {})).not.toThrow();
  expect(root.querySelector("img.image-preview").hidden).toBe(true);
});

