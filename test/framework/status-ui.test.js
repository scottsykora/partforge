// @vitest-environment happy-dom
// The status/busy/export-button chrome adapter, extracted from mount.js.
import { beforeEach, expect, test } from "vitest";
import { createStatusUi } from "../../src/framework/status-ui.js";

beforeEach(() => {
  document.body.innerHTML = `
    <div id="status"></div>
    <div id="busy"><div id="phase"></div></div>
    <button id="download"></button>
    <button id="download-step"></button>
    <button id="download-3mf"></button>`;
});

test("setStatus writes the message and toggles the error class", () => {
  const ui = createStatusUi();
  ui.setStatus("928 triangles");
  const el = document.getElementById("status");
  expect(el.textContent).toBe("928 triangles");
  expect(el.classList.contains("err")).toBe(false);
  ui.setStatus("failed: boom", true);
  expect(el.classList.contains("err")).toBe(true);
  ui.setStatus("ok again");
  expect(el.classList.contains("err")).toBe(false);
});

test("showBusy shows the overlay with the phase; hideBusy hides it", () => {
  const ui = createStatusUi();
  ui.showBusy("generating");
  expect(document.getElementById("phase").textContent).toBe("generating…");
  expect(document.getElementById("busy").classList.contains("show")).toBe(true);
  ui.hideBusy();
  expect(document.getElementById("busy").classList.contains("show")).toBe(false);
});

test("setExportEnabled toggles disabled on every export button", () => {
  const ui = createStatusUi();
  ui.setExportEnabled(true);
  for (const id of ["download", "download-step", "download-3mf"]) {
    expect(document.getElementById(id).disabled).toBe(false);
  }
  ui.setExportEnabled(false);
  for (const id of ["download", "download-step", "download-3mf"]) {
    expect(document.getElementById(id).disabled).toBe(true);
  }
});

test("a page without the optional 3MF button still works", () => {
  document.getElementById("download-3mf").remove();
  const ui = createStatusUi();
  ui.setExportEnabled(true);
  expect(document.getElementById("download").disabled).toBe(false);
});
