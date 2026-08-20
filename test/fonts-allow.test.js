import { expect, test } from "vitest";
import { fontSourceAllowed, fontControlAllows, FONT_ALLOW_DEFAULT } from "../src/framework/font-source.js";

test("the default allow list accepts https and nothing else", () => {
  expect(FONT_ALLOW_DEFAULT).toEqual(["https"]);
  expect(fontSourceAllowed("https://fonts.gstatic.com/s/x/v1/y.ttf", FONT_ALLOW_DEFAULT)).toBe(true);
  expect(fontSourceAllowed("https://cdn.example.com/a.ttf", FONT_ALLOW_DEFAULT)).toBe(true);
  for (const bad of ["http://x.test/a.ttf", "file:///etc/passwd", "data:font/ttf;base64,AA", "blob:https://x/y", "not a url"]) {
    expect(fontSourceAllowed(bad, FONT_ALLOW_DEFAULT), bad).toBe(false);
  }
});

test('"gstatic" narrows to the Google font host only', () => {
  expect(fontSourceAllowed("https://fonts.gstatic.com/s/x/v1/y.ttf", ["gstatic"])).toBe(true);
  expect(fontSourceAllowed("https://cdn.example.com/a.ttf", ["gstatic"])).toBe(false);
  // a lookalike host must not pass
  expect(fontSourceAllowed("https://fonts.gstatic.com.evil.test/a.ttf", ["gstatic"])).toBe(false);
});

test('"asset" accepts a pfc-asset token; https alone does not', () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/roboto-700.ttf";
  expect(fontSourceAllowed(tok, ["asset"])).toBe(true);
  expect(fontSourceAllowed(tok, ["https"])).toBe(false);
  expect(fontSourceAllowed(tok, ["https", "asset"])).toBe(true);
});

test("non-string sources are never param-supplied and are not checked here", () => {
  expect(fontSourceAllowed(new ArrayBuffer(4), FONT_ALLOW_DEFAULT)).toBe(false);
});

test("fontControlAllows finds every font control and its allow list", () => {
  const part = { parameters: [
    { id: "t", controls: [
      { key: "face", type: "font" },                          // default allow
      { key: "alt",  type: "font", allow: ["gstatic"] },
      { key: "size", type: "slider" },
      { type: "group", controls: [{ key: "sub", type: "font", allow: ["asset"] }] },
    ] },
  ] };
  const m = fontControlAllows(part);
  expect(m.get("face")).toEqual(FONT_ALLOW_DEFAULT);
  expect(m.get("alt")).toEqual(["gstatic"]);
  expect(m.get("sub")).toEqual(["asset"]);
  expect(m.has("size")).toBe(false);
});

test("fontControlAllows also finds a legacy-shaped font control (advanced/control:)", () => {
  // Exact reproduction from the review: a legacy `advanced` descriptor spells
  // its type as `control`, not `type` — panel/legacy.js's toControl() maps
  // `control` -> `type` at render time, but that mapping never runs here, so
  // fontControlAllows must recognize `control: "font"` on its own.
  const part = { parameters: [{ id: "t", advanced: [{ key: "face", control: "font" }] }] };
  const m = fontControlAllows(part);
  expect(m.get("face")).toEqual(FONT_ALLOW_DEFAULT);
});

test("fontControlAllows finds a font control nested inside a legacy `features` array", () => {
  const part = { parameters: [
    { id: "t", features: [
      { key: "shown", on: 1 },                                  // an ordinary feature toggle, not a font
      { key: "face", control: "font", allow: ["gstatic"] },
    ] },
  ] };
  const m = fontControlAllows(part);
  expect(m.get("face")).toEqual(["gstatic"]);
  expect(m.has("shown")).toBe(false);
});

import { handle } from "../src/framework/jobs.js";

test("a param font source outside `allow` falls back to the default and warns", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/ok/v1/ok.ttf" },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const seen = [];
  const g = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }; };
  const posts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, (m) => posts.push(m));
  } finally { globalThis.fetch = g; }

  expect(seen).not.toContain("https://evil.test/x.ttf");     // never fetched
  expect(seen).toContain("https://fonts.gstatic.com/s/ok/v1/ok.ttf"); // fell back to the default
  const warn = posts.find((m) => m.type === "progress" && /not allowed/.test(m.phase));
  expect(warn, "a refused source must say so").toBeTruthy();
});

test("a disallowed font param with no declared default completes the job instead of erroring", async () => {
  // The reviewer's exact scenario: `defaults` has no entry for the font key,
  // so the refusal above sets p.face = undefined. `fonts: (p) => ({ face:
  // p.face })` then declares a font with no source — that must be treated as
  // "no font declared" (text2d's own bundled-Roboto fallback), not surfaced
  // as a resolveFonts throw. Asserting "no type:error post" rather than
  // pinning the old error string, since the point is that no error occurs.
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: {},                          // no fallback source for "face"
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const seen = [];
  const g = globalThis.fetch;
  globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) }; };
  const posts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, (m) => posts.push(m));
  } finally { globalThis.fetch = g; }

  expect(seen).not.toContain("https://evil.test/x.ttf");            // still never fetched
  expect(posts.find((m) => m.type === "error")).toBeUndefined();    // no error page
  expect(posts.find((m) => m.type === "meshes")).toBeTruthy();      // the job actually finished
});
