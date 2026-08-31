// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../../../src/framework/panel/render.js";
import { fontLabel } from "../../../src/framework/panel/widgets/font.js";

const GS = "https://fonts.gstatic.com/s/playfairdisplay/v37/abcdef.ttf";
const sec = (over = {}) => ({ id: "s", title: "S", controls: [
  { key: "face", type: "font", label: "Typeface", ...over },
] });

test("fontLabel reads family and variant off a pfc-asset filename", () => {
  expect(fontLabel("pfc-asset://11111111-2222-3333-4444-555555555555/playfair-display-700.ttf"))
    .toEqual({ family: "Playfair Display", variant: "700" });
  expect(fontLabel("pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf"))
    .toEqual({ family: "Anton", variant: null });
});

test("fontLabel falls back to the filename for an unknown URL", () => {
  expect(fontLabel("https://cdn.example.com/fonts/Courier-Prime.ttf").family).toBe("Courier Prime");
});

// A gstatic filename is a CONTENT HASH, not the family — `fontLabel` cannot do
// better than the hash, which is exactly why the provider gets `describe`.
test("fontLabel on a raw gstatic URL yields the hash, not the family", () => {
  expect(fontLabel(GS).family).toBe("Abcdef");
});

test("fontLabel never throws on junk", () => {
  for (const junk of ["", "not a url", null, undefined, 42]) {
    expect(() => fontLabel(junk)).not.toThrow();
  }
});

test("with no catalog the control is a plain URL text field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec()], params, () => {});
  const field = root.querySelector("input.text-input");
  expect(field).toBeTruthy();
  expect(root.querySelector("button.font-btn")).toBeNull();
  expect(field.value).toBe(GS);
});

test("the degraded field refuses an out-of-allow value on commit", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec({ allow: ["gstatic"] })], params, () => {});
  const field = root.querySelector("input.text-input");
  field.value = "http://evil.test/x.ttf";
  field.dispatchEvent(new Event("input"));
  field.dispatchEvent(new Event("change"));
  expect(params.face).toBe(GS);                       // unchanged
  expect(field.classList.contains("warn")).toBe(true);
});

test("with a catalog the control is a button, labelled via describe()", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec()], params, () => {}, undefined, {
    fontCatalog: {
      async search() { return []; },
      describe: (src) => (src === GS ? { family: "Playfair Display", variant: "700" } : null),
    },
  });
  const btn = root.querySelector("button.font-btn");
  expect(btn).toBeTruthy();
  await new Promise((r) => setTimeout(r, 0));                 // describe may be async
  expect(btn.querySelector(".fname").textContent).toBe("Playfair Display");
  expect(btn.querySelector(".fvar").textContent).toBe("Bold");
});

test("a provider with no describe() degrades to the filename label", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf" };
  buildControls(root, [sec()], params, () => {}, undefined,
    { fontCatalog: { async search() { return []; } } });
  await new Promise((r) => setTimeout(r, 0));
  expect(root.querySelector(".fname").textContent).toBe("Anton");
});

test("sync repaints the button from params", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  const panel = buildControls(root, [sec()], params, () => {}, undefined,
    { fontCatalog: { async search() { return []; } } });
  params.face = "pfc-asset://11111111-2222-3333-4444-555555555555/anton.ttf";
  panel.syncValues();
  expect(root.querySelector(".fname").textContent).toBe("Anton");
});

// ── the drop target — Task 8's adoption of makeFileDrop ────────────────────
//
// Fonts are the "used as-is" kind: registry.js's font row has `convert: null`
// (a TTF/OTF is validated, never converted), so — unlike test/image-control.test.js's
// drop-target block — there is no dynamic-import converter to warm up and no
// createImageBitmap/OffscreenCanvas stub to install. A dropped file's bytes
// ARE the artifact.

test("a font control renders a drop target", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    { face: "" }, () => {});
  expect(root.querySelector("[data-pf-drop]")).toBeTruthy();
});

test("a dropped TTF lands in the param as bytes", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    params, () => {});
  const TTF = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);
  const file = Object.assign(new Blob([TTF]), {
    name: "f.ttf", arrayBuffer: async () => TTF.buffer.slice(0),
  });
  const el = root.querySelector("[data-pf-drop]");
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  expect(params.face).toBeInstanceOf(ArrayBuffer);
});

test("the drop target coexists with the catalog button, and preserves it", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "" };
  buildControls(root, [sec()], params, () => {}, undefined,
    { fontCatalog: { async search() { return []; } } });
  expect(root.querySelector("button.font-btn"), "catalog button still present").toBeTruthy();
  const dropEl = root.querySelector("[data-pf-drop]");
  expect(dropEl, "drop target present alongside the catalog button").toBeTruthy();

  const TTF = Uint8Array.from([0x4f, 0x54, 0x54, 0x4f, 1, 2, 3, 4]);
  const file = Object.assign(new Blob([TTF]), {
    name: "g.otf", arrayBuffer: async () => TTF.buffer.slice(0),
  });
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  dropEl.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  expect(params.face).toBeInstanceOf(ArrayBuffer);
});

test("a bad drop renders the error verbatim without disturbing the URL field", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: GS };
  buildControls(root, [sec()], params, () => {});
  const field = root.querySelector("input.text-input");
  const dropEl = root.querySelector("[data-pf-drop]");
  const TXT = Uint8Array.from([1, 2, 3, 4]);
  const file = Object.assign(new Blob([TXT]), {
    name: "not-a-font.txt", arrayBuffer: async () => TXT.buffer.slice(0),
  });
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  dropEl.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  const errorEl = root.querySelector(".file-drop-error");
  expect(errorEl.hidden).toBe(false);
  expect(errorEl.textContent).toContain("not-a-font.txt");
  expect(params.face).toBe(GS);          // unchanged
  expect(field.value).toBe(GS);
});

// A panel rebuild must tear the drop widget's listeners down on EVERY render
// path (degraded field and catalog button alike) — see widgets/font.js's
// `dispose`. A REAL file is dispatched after teardown, not an empty file
// list: `handleFiles` returns immediately on an empty list, before ever
// touching the disposed AbortController, so an empty-list drop would pass
// whether or not `dispose()` is wired to the drop widget at all (that gap is
// exactly what test/image-control.test.js's own teardown test calls out from
// task 6's first round). This test is only load-bearing if it fails when the
// `drop.dispose()` wiring is removed — verified by hand for this task; see
// the task-8 report.
test("a panel rebuild disposes the drop widget — no stray listener keeps the old params alive", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "" };
  const panel = buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    params, () => {});
  const dropEl = root.querySelector("[data-pf-drop]");
  panel.dispose();
  const TTF = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);
  const file = Object.assign(new Blob([TTF]), {
    name: "f.ttf", arrayBuffer: async () => TTF.buffer.slice(0),
  });
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  expect(() => dropEl.dispatchEvent(ev)).not.toThrow();
  await new Promise((r) => setTimeout(r, 0));
  expect(params.face).toBe("");          // disposed: never wrote back
});
