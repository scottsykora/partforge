// @vitest-environment happy-dom
//
// registry.js's `convert` thunk for "vector" is a genuine dynamic import
// (`() => import("./svg-ingest.js").then((m) => m.ingestSvg)`) — unlike
// fonts (whose row has `convert: null`), so the same warm-latency race
// test/file-drop.test.js and test/image-control.test.js document applies
// here: the FIRST call pays Vite's transform cost, which can outrun the
// single tick the drop test waits on if nothing has warmed the module yet.
// Warmed here, once, before any test's timing-sensitive assertion runs.
import { describe, expect, test, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { buildControls } from "../src/framework/panel/render.js";

beforeAll(() => import("../src/framework/ingest/svg-ingest.js"));

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

test("a vector control renders a drop target", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
    { art: "" }, () => {});
  expect(root.querySelector("[data-pf-drop]")).toBeTruthy();
});

test("a dropped SVG is converted, so the param is NOT the raw SVG", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { art: "" };
  buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
    params, () => {});
  // The brief's own fixture (`<rect width="10" height="10"/>`) has no fill or
  // stroke, so svg-ingest.js's real converter refuses it as "no painted
  // geometry" — a real defect in the brief's test, not this widget; see the
  // task-9 report. A `fill` makes it real, paintable geometry.
  const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#111"/></svg>');
  const file = Object.assign(new Blob([SVG]), {
    name: "a.svg", arrayBuffer: async () => SVG.buffer.slice(0),
  });
  const el = root.querySelector("[data-pf-drop]");
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 50));   // conversion is async
  expect(params.art).toBeTruthy();
  expect(params.art).not.toBe("");

  // Ruling D of the task-9-brief.md addendum tightens the brief's own test,
  // which accepted either an ArrayBuffer or an object: a vector control
  // writes the PARSED DOCUMENT OBJECT into its param, never serialized
  // bytes — vectors.js's `asParsedFile` ("the in-tree form") already accepts
  // that shape directly, and byteAwareReplacer (solid-hash.js) deliberately
  // does not fingerprint it, because k.vector2d hashes on the Shape2D
  // coordinates instead. Assert the object form specifically.
  expect(params.art).toBeTypeOf("object");
  expect(params.art).not.toBeInstanceOf(ArrayBuffer);
  expect(ArrayBuffer.isView(params.art)).toBe(false);

  // The converted document is partforge-vector JSON, never the SVG text.
  const text = JSON.stringify(params.art);
  expect(text).not.toMatch(/<svg/);
});

// A panel rebuild must tear the drop widget's listeners down — see
// widgets/vector.js's `dispose` (now `mountDrop`'s, task-9 addendum Ruling
// L). Mirrors test/image-control.test.js's and font-widget.test.js's own
// teardown tests: a REAL file is dispatched after teardown, not an empty
// file list, because `handleFiles` returns immediately on an empty list —
// before ever touching the disposed AbortController — so an empty-list drop
// would pass whether or not `dispose()` is wired at all. This test is only
// load-bearing if it fails when the `drop.dispose()` wiring is removed —
// verified by hand for this task; see the task-9 report.
test("a panel rebuild disposes the drop widget — no stray listener keeps the old params alive", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { art: "" };
  const panel = buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
    params, () => {});
  const dropEl = root.querySelector("[data-pf-drop]");
  panel.dispose();
  const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#111"/></svg>');
  const file = Object.assign(new Blob([SVG]), {
    name: "a.svg", arrayBuffer: async () => SVG.buffer.slice(0),
  });
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  expect(() => dropEl.dispatchEvent(ev)).not.toThrow();
  await new Promise((r) => setTimeout(r, 50));
  expect(params.art).toBe("");          // disposed: never wrote back
});

// ── thumbnail ────────────────────────────────────────────────────────────────
// The vector control's value is a parsed document, not a URL, so there is
// nothing an <img> could point at. It renders the artwork itself instead.
describe("thumbnail", () => {
  const doc = () => JSON.parse(readFileSync("src/parts/assets/emblem.vector.json", "utf8"));
  const mount = (params) => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    const panel = buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
      params, () => {});
    return { root, panel };
  };

  test("renders the artwork inline when the param holds a document", () => {
    const { root } = mount({ art: doc() });
    const svg = root.querySelector("[data-pf-thumb] svg");
    expect(svg, "an inline svg preview of the document").toBeTruthy();
    expect(svg.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  test("shows a placeholder, not an empty box, when there is no artwork yet", () => {
    const { root } = mount({ art: "" });
    expect(root.querySelector("[data-pf-thumb] svg")).toBeNull();
    expect(root.querySelector("[data-pf-thumb]"), "the tile is still there to drop onto").toBeTruthy();
  });

  test("the thumbnail is the drop target", () => {
    const { root } = mount({ art: doc() });
    expect(root.querySelector("[data-pf-thumb][data-pf-drop], [data-pf-drop] [data-pf-thumb], [data-pf-thumb] [data-pf-drop]"),
      "thumb and drop target are the same element or nested").toBeTruthy();
  });

  test("survives a malformed document instead of taking the control down", () => {
    // vectorThumb returns null rather than throwing; the widget must fall back.
    const { root } = mount({ art: { shapes: { a: [{ outer: { kind: "path", start: [0, NaN], segments: [{ kind: "line", to: [1, 1] }] } }] } } });
    expect(root.querySelector("[data-pf-thumb]")).toBeTruthy();
    expect(root.querySelector("[data-pf-thumb] svg")).toBeNull();
  });

  test("repaints when the document is replaced", () => {
    const params = { art: "" };
    const { root, panel } = mount(params);
    expect(root.querySelector("[data-pf-thumb] svg")).toBeNull();
    params.art = doc();
    panel.syncValues?.(["art"]);
    expect(root.querySelector("[data-pf-thumb] svg"), "sync repaints the thumbnail").toBeTruthy();
  });
});

// ── sourceField: false ───────────────────────────────────────────────────────
// The tile is preview, drop target and click-to-choose in one. The URL field is a
// fourth affordance for the same job, and on a 288 px rail it is the one earning
// its space least — so an author can drop it. It stays ON by default, because it
// is the only way to enter an https URL or a pfc-asset token by hand.
describe("sourceField: false", () => {
  const mount = (extra) => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork", ...extra }] }],
      { art: "" }, () => {});
    return root;
  };

  test("hides the URL field but keeps the drop tile", () => {
    const root = mount({ sourceField: false });
    expect(root.querySelector("input.text-input"), "no URL field").toBeNull();
    expect(root.querySelector("[data-pf-drop]"), "the tile is still there").toBeTruthy();
  });

  test("the field is present by default", () => {
    expect(mount({}).querySelector("input.text-input"), "default keeps the field").toBeTruthy();
  });
});

test("opens showing the part's declared artwork, not an empty tile", async () => {
  // Unlike an image there is nothing to point at — the document has to be fetched
  // and parsed before it can be drawn.
  const doc = JSON.parse(readFileSync("src/parts/assets/emblem.vector.json", "utf8"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => doc });
  try {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
      { art: "" }, () => {}, undefined,
      { declaredSource: () => "https://cdn.test/bundled.vector.json" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector("[data-pf-thumb] svg"), "the declared artwork is drawn").toBeTruthy();
  } finally { globalThis.fetch = realFetch; }
});

test("a declared document that fails to load leaves the tile empty, never throws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById("root");
    expect(() => buildControls(root, [{ id: "s", controls: [{ key: "art", type: "vector", label: "Artwork" }] }],
      { art: "" }, () => {}, undefined,
      { declaredSource: () => "https://cdn.test/gone.vector.json" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector("[data-pf-thumb] svg")).toBeNull();
    expect(root.querySelector("[data-pf-thumb]"), "the tile survives so a drop is still possible").toBeTruthy();
  } finally { globalThis.fetch = realFetch; }
});

