// @vitest-environment happy-dom
// The status/busy/export-button chrome adapter. Element refs in, no document queries.
import { beforeEach, expect, test } from "vitest";
import { createStatusUi } from "../../src/framework/status-ui.js";

let els;
beforeEach(() => {
  document.body.innerHTML = `
    <div id="status"></div>
    <div id="busy"><div id="phase"></div></div>
    <button id="download"></button>
    <button id="download-step"></button>
    <button id="download-3mf"></button>`;
  els = {
    status: document.getElementById("status"),
    busy: document.getElementById("busy"),
    phase: document.getElementById("phase"),
    exports: ["download", "download-step", "download-3mf"].map((id) => document.getElementById(id)),
  };
});

test("setStatus writes the message and toggles the error class", () => {
  const ui = createStatusUi(els);
  ui.setStatus("928 triangles");
  expect(els.status.textContent).toBe("928 triangles");
  expect(els.status.classList.contains("err")).toBe(false);
  ui.setStatus("failed: boom", true);
  expect(els.status.classList.contains("err")).toBe(true);
  ui.setStatus("ok again");
  expect(els.status.classList.contains("err")).toBe(false);
});

test("showBusy shows the overlay with the phase; hideBusy hides it", () => {
  const ui = createStatusUi(els);
  ui.showBusy("generating");
  expect(els.phase.textContent).toBe("generating…");
  expect(els.busy.classList.contains("show")).toBe(true);
  ui.hideBusy();
  expect(els.busy.classList.contains("show")).toBe(false);
});

test("setExportEnabled toggles disabled on every export button", () => {
  const ui = createStatusUi(els);
  ui.setExportEnabled(true);
  for (const b of els.exports) expect(b.disabled).toBe(false);
  ui.setExportEnabled(false);
  for (const b of els.exports) expect(b.disabled).toBe(true);
});

test("missing (null) export buttons are skipped", () => {
  els.exports[2] = null; // page without the optional 3MF button
  const ui = createStatusUi(els);
  ui.setExportEnabled(true);
  expect(els.exports[0].disabled).toBe(false);
});
