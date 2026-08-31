import { expect, test } from "vitest";
import { fontSourceAllowed, fontControlAllows, isNoFontSource, FONT_ALLOW_DEFAULT } from "../src/framework/font-source.js";

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

// Superseded by "BYTES bypass the allow check" below: bytes are now a
// legitimate param-supplied source (the panel's drop target), so they are no
// longer refused here. Kept only as a pointer so a reader who remembers the
// old assertion (`fontSourceAllowed(bytes, …) === false`) finds why it moved
// rather than assuming it was silently dropped.

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

import { readFileSync } from "node:fs";
import { handle } from "../src/framework/jobs.js";

// Real, parseable bytes: these two tests run the font all the way through
// parseFont, so the 4-byte stub the tests above use would fail the build for
// the wrong reason. resolveFonts memoizes per URL process-wide, so every test
// here uses a URL of its own.
const ROBOTO = readFileSync(new URL("../src/framework/geometry/fonts/Roboto-Regular.ttf", import.meta.url));
const fontBytes = () => ROBOTO.buffer.slice(ROBOTO.byteOffset, ROBOTO.byteOffset + ROBOTO.byteLength);

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

test("an empty-string font param (no font declared) posts no refusal notice, while a disallowed value still does", async () => {
  // Same guard, two branches — a fix that skipped everything would make the
  // "still does" half fail to fail, which is the trap noted in the review.
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "" },                // "" = the documented "unset" state
    fonts: (p) => (p.face ? { face: p.face } : {}),
    parts: {},
  };
  const g = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  const notRefused = (m) => m.type === "progress" && /not allowed/.test(m.phase);

  const emptyPosts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "" } }, (m) => emptyPosts.push(m));
  } finally { globalThis.fetch = g; }
  expect(emptyPosts.find(notRefused), "an empty source is not a refusal").toBeUndefined();
  expect(emptyPosts.find((m) => m.type === "meshes")).toBeTruthy();   // job still completes

  globalThis.fetch = async (u) => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  const badPosts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, (m) => badPosts.push(m));
  } finally { globalThis.fetch = g; }
  expect(badPosts.find(notRefused), "a genuinely disallowed source must still warn").toBeTruthy();
});

// The one shared definition of "no font source declared" (font-source.js). Three
// framework sites used to spell this out by hand, and twice one of them drifted.
test("isNoFontSource is exactly the empty triple — not a general falsiness test", () => {
  for (const v of [undefined, null, ""]) expect(isNoFontSource(v), String(v)).toBe(true);
  for (const v of ["https://x.test/a.ttf", 0, false, new ArrayBuffer(4), " "]) {
    expect(isNoFontSource(v), String(v)).toBe(false);
  }
});

// derive() must observe the params build() will. The refusal used to run AFTER
// resolveParams had already computed `d`, so a derived value read the refused
// URL while the build read the default — one part, two answers.
test("derive() sees the replacement, not the refused value", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const seen = [];
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/ok/v1/ok.ttf" },
    derive: (p) => { seen.push(p.face); return {}; },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const g = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, () => {});
  } finally { globalThis.fetch = g; }
  expect(seen).toEqual(["https://fonts.gstatic.com/s/ok/v1/ok.ttf"]);
});

// A progress phase is overwritten by the next busy chip milliseconds later, so
// it cannot be the only record: the result carries the refusal on `warnings`,
// where a host (or its agent) can still read it after the build lands.
test("a refused source rides the result's warnings, not just a progress phase", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/warn/v1/ok.ttf" },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const g = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => fontBytes() });
  const posts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://evil.test/x.ttf" } }, (m) => posts.push(m));
  } finally { globalThis.fetch = g; }
  const meshes = posts.find((m) => m.type === "meshes");
  expect(meshes.warnings).toEqual([{ part: null, message: expect.stringContaining('font source for "face" is not allowed') }]);
});

// …and a build with nothing refused must not grow a `warnings` field it never
// had: hosts key "did this build degrade?" on its presence.
test("an allowed source leaves the result's warnings absent", async () => {
  const kernel = { _fonts: new Map(), cleanup() {} };
  const part = {
    parameters: [{ id: "t", controls: [{ key: "face", type: "font", allow: ["gstatic"] }] }],
    defaults: { face: "https://fonts.gstatic.com/s/fine/v1/ok.ttf" },
    fonts: (p) => ({ face: p.face }),
    parts: {},
  };
  const g = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => fontBytes() });
  const posts = [];
  try {
    await handle(kernel, part, { type: "generate", subparts: [], view: "iso",
      params: { face: "https://fonts.gstatic.com/s/fine/v1/ok.ttf" } }, (m) => posts.push(m));
  } finally { globalThis.fetch = g; }
  expect(posts.find((m) => m.type === "meshes").warnings).toBeUndefined();
});

test("BYTES bypass the allow check — they cannot have come from a shared link", () => {
  expect(fontSourceAllowed(new ArrayBuffer(8), ["https"])).toBe(true);
  expect(fontSourceAllowed(new Uint8Array(8), ["https"])).toBe(true);
});

test("string sources still get the full allow treatment", () => {
  expect(fontSourceAllowed("http://cdn.test/f.ttf", ["https"])).toBe(false);
  expect(fontSourceAllowed("https://cdn.test/f.ttf", ["https"])).toBe(true);
  expect(fontSourceAllowed("javascript:alert(1)", ["https"])).toBe(false);
});
