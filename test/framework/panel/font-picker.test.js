// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";
import { openFontPicker } from "../../../src/framework/panel/font-picker.js";
import { buildControls } from "../../../src/framework/panel/render.js";

const fam = (family, variants, over = {}) => ({
  id: family, family, category: "sans", menuUrl: `https://fonts.gstatic.com/menu/${family}.ttf`,
  variants: variants.map((v) => ({ variant: v, label: v, url: `https://fonts.gstatic.com/s/${family}/v1/${v}.ttf`, bytes: 100 })),
  ...over,
});

const CATALOG = [fam("Anton", ["400"]), fam("Montserrat", ["400", "700"]), fam("Roboto", ["400", "700"])];
const catalog = { search: vi.fn(async (q) => CATALOG.filter((f) => !q || f.family.toLowerCase().includes(q.toLowerCase()))) };

function open(over = {}) {
  document.body.innerHTML = '<div id="anchor"></div>';
  const params = { face: CATALOG[2].variants[0].url };
  const handle = openFontPicker({
    node: { key: "face" }, params, allow: ["https"], fontCatalog: catalog,
    anchor: document.getElementById("anchor"), onPicked: () => {}, ...over,
  });
  return { handle, params };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a single-variant family commits on row click without opening variants", async () => {
  const { params } = open();
  await flush();
  const row = [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton"));
  row.click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Anton/v1/400.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
});

test("a multi-variant family opens the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelectorAll(".vrow").length).toBe(2);
  expect(params.face).toContain("/Montserrat/");        // default variant already committed
});

test("picking a weight commits and STAYS in the variants pane", async () => {
  const { params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Montserrat")).click();
  await flush();
  [...document.querySelectorAll(".vrow")].find((b) => b.dataset.v === "700").click();
  await flush();
  expect(params.face).toBe("https://fonts.gstatic.com/s/Montserrat/v1/700.ttf");
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(true);
  expect(document.querySelector(".vrow.on").dataset.v).toBe("700");
});

test("Done closes the picker; the last pick stands", async () => {
  const { handle, params } = open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Anton")).click();
  await flush();
  document.querySelector(".pk-done").click();
  expect(document.querySelector(".picker")).toBeNull();
  expect(params.face).toContain("/Anton/");
  handle.close();                                       // idempotent
});

test("Escape steps back from variants before it closes", async () => {
  open();
  await flush();
  [...document.querySelectorAll(".pk-row")].find((r) => r.textContent.startsWith("Roboto")).click();
  await flush();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker").classList.contains("at-variants")).toBe(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(document.querySelector(".picker")).toBeNull();
});

test("search filters, and rows do not go stale at a reused index", async () => {
  open();
  await flush();
  const first = () => document.querySelector(".pk-row .pk-face").textContent;
  expect(first()).toBe("Anton");
  const search = document.querySelector(".pk-search");
  search.value = "montse"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(first()).toBe("Montserrat");                   // index 0 re-rendered, not reused
});

test("an empty result shows an empty state, not a blank pane", async () => {
  open();
  await flush();
  const search = document.querySelector(".pk-search");
  search.value = "zzzznope"; search.dispatchEvent(new Event("input"));
  await flush();
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
});

test("a family whose url fails `allow` is not offered", async () => {
  const evil = { search: async () => [fam("Bad", ["400"], { variants: [{ variant: "400", label: "400", url: "http://evil.test/x.ttf", bytes: 1 }] })] };
  open({ fontCatalog: evil, allow: ["gstatic"] });
  await flush();
  expect(document.querySelectorAll(".pk-row").length).toBe(0);
  expect(document.querySelector(".pk-empty").hidden).toBe(false);
});

// ── the caption, the reserved height, and the wiring ────────────────────────

test("the row caption pluralizes: `1 style`, never `1 styles`", async () => {
  open();
  await flush();
  const caption = (name) => [...document.querySelectorAll(".pk-row")]
    .find((r) => r.textContent.startsWith(name)).querySelector(".pk-sub").textContent;
  expect(caption("Anton")).toBe("1 style · sans");
  expect(caption("Montserrat")).toBe("2 styles · sans");
});

// Height is reserved by the virtualizer BEFORE the face loads, which is what
// keeps a late-arriving face from shifting the list under the pointer.
test("rows reserve the 44px comfortable height and stack by index", async () => {
  open();
  await flush();
  const rows = [...document.querySelectorAll(".pk-row")];
  expect(rows.map((r) => r.style.height)).toEqual(["44px", "44px", "44px"]);
  expect(rows.map((r) => r.style.transform))
    .toEqual(["translateY(0px)", "translateY(44px)", "translateY(88px)"]);
});

test("the font control's button opens the picker — registration is wired", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: CATALOG[2].variants[0].url };
  buildControls(root, [{ id: "s", title: "S", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    params, () => {}, () => {}, { fontCatalog: catalog });
  expect(document.querySelector(".picker")).toBeNull();
  root.querySelector("button.font-btn").click();
  await flush();
  expect(document.querySelector(".picker")).toBeTruthy();
  document.querySelector(".pk-done").click();
  expect(document.querySelector(".picker")).toBeNull();
});

// ── faces ──────────────────────────────────────────────────────────────────
// happy-dom implements neither FontFace nor document.fonts, so every test above
// runs the degraded path — un-styled rows, no throw. These two stub the pair in
// to exercise the path a browser actually takes.

function withFontFace(load) {
  const seen = [];
  const prev = globalThis.FontFace;
  globalThis.FontFace = class {
    constructor(family, src) { this.family = family; this.src = src; seen.push({ family, src }); }
    load() { return load(this); }
  };
  Object.defineProperty(document, "fonts", { value: { add() {} }, configurable: true });
  return { seen, restore() { globalThis.FontFace = prev; delete document.fonts; } };
}

test("each family's menu face is loaded once, and only from an allowed host", async () => {
  const ff = withFontFace((f) => Promise.resolve(f));
  try {
    open({ allow: ["gstatic"], fontCatalog: { search: async () => [
      ...CATALOG,
      fam("Sketchy", ["400"], { menuUrl: "http://evil.test/menu.ttf" }),
    ] } });
    await flush();
    const search = document.querySelector(".pk-search");
    search.value = ""; search.dispatchEvent(new Event("input"));   // re-render the same rows
    await flush();
    expect(ff.seen.map((s) => s.family)).toEqual(["Anton", "Montserrat", "Roboto"]);
    expect(ff.seen.every((s) => s.src.includes("fonts.gstatic.com"))).toBe(true);
  } finally { ff.restore(); }
});

// A face is dimmed while it is PENDING. A 404 is settled, not pending, so the
// row must come back to full strength in the panel font rather than sitting at
// 38% forever — and the rejection must not escape as an unhandled error.
test("a menu face that fails to load settles the row instead of dimming it forever", async () => {
  const rejects = [];
  const ff = withFontFace(() => new Promise((_, r) => rejects.push(r)));
  try {
    open();
    await flush();
    expect(document.querySelector(".pk-row").classList.contains("loading")).toBe(true);
    for (const r of rejects) r(new Error("404"));
    await flush();
    expect(document.querySelectorAll(".pk-row").length).toBe(3);
    expect(document.querySelector(".pk-row").classList.contains("loading")).toBe(false);
  } finally { ff.restore(); }
});

test("with no FontFace at all the rows render un-styled rather than dimmed", async () => {
  open();                                              // happy-dom has no FontFace
  await flush();
  expect([...document.querySelectorAll(".pk-row")].some((r) => r.classList.contains("loading"))).toBe(false);
});
