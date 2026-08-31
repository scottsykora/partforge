// @vitest-environment happy-dom
//
// registry.js's `convert` thunk for "vector" is a genuine dynamic import
// (`() => import("./svg-ingest.js").then((m) => m.ingestSvg)`) — unlike
// fonts (whose row has `convert: null`), so the same warm-latency race
// test/file-drop.test.js and test/image-control.test.js document applies
// here: the FIRST call pays Vite's transform cost, which can outrun the
// single tick the drop test waits on if nothing has warmed the module yet.
// Warmed here, once, before any test's timing-sensitive assertion runs.
import { expect, test, beforeAll } from "vitest";
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
