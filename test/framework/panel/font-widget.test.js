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
