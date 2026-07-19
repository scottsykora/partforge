# vectorText — `k.text2d` → `Shape2D` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `k.text2d(string, opts) → Shape2D` — outline-font text as a `Shape2D` you can boolean/offset/extrude, with bring-your-own fonts (bundle or URL) and a default font.

**Architecture:** A consumer of F1/F2/F3, not new kernel plumbing. A pure module turns an opentype.js font + string into per-glyph curve-contour region specs (glyph outline → `pathProfile` contours, `Q`→cubic, containment-classified holes, laid out). `k.text2d` (defined once in `finishKernel`, backend-agnostic) maps each to `k.shape2d` and `union`s them. A part declares fonts in a new `fonts` field; the framework preloads them (async) before the synchronous `build`.

**Tech Stack:** plain ESM JS, vitest, opentype.js (new dep), Manifold + replicad (WASM), Node 24. Stacked on F3 (`shape2d-offset`) → F2 → main.

## Global Constraints

- **Node 24** — `source ~/.nvm/nvm.sh && nvm use` before any `npm`/`npx vitest`; confirm `node -v` = v24.x. If the sandbox lacks it, implement + report "needs controller verification".
- **Units mm**; geometry helpers pure & DOM-free; **OCCT and Manifold never co-boot** (separate test files).
- **opentype.js** is a runtime dependency (already added to `package.json` during planning — verify it's present; it's pure JS, works in Node + worker, no DOM).
- **`text2d` is backend-agnostic** — define it ONCE in `finishKernel` (kernel-front.js); it only uses `k.shape2d` + `Shape2D.union`. Do NOT add it per-backend.
- **opentype conventions:** `glyph.getPath(0, 0, unitsPerEm)` returns commands in **font units, y-DOWN** (flip `y → -y` for math/CCW). Cap height = `font.tables?.os2?.sCapHeight` or fallback to `font.charToGlyph("H").getBoundingBox().y2` (getBoundingBox is y-up). Kerning via `font.getKerningValue(gA, gB)` (guard with try/catch — synth fonts lack a kern table).
- **Lints:** `"text2d"` in `KERNEL_OPS` (kernel.js) + named in `docs/KERNEL-CONTRACT.md`. The font registry is internal (`kernel._fonts`, underscore → not lint-checked).
- **Version bump additive** — do NOT change `CONTRACT_VERSION`.
- **Do NOT touch** `embed-test.html` / `src/app-embed-test.js`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Shared helpers for the test path

Tests synthesize an opentype font in-memory (no binary asset). Reusable fixture:
```js
function synthFont() {
  const g = (name, unicode, adv, draw) => {
    const p = new opentype.Path(); draw(p);
    return new opentype.Glyph({ name, unicode, advanceWidth: adv, path: p });
  };
  const notdef = g(".notdef", 0, 650, () => {});
  // 'H' — sets cap height 700 (fallback path when os2.sCapHeight is absent)
  const H = g("H", 72, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(150,700);p.lineTo(150,400);
    p.lineTo(550,400);p.lineTo(550,700);p.lineTo(650,700);p.lineTo(650,0);p.lineTo(550,0);p.lineTo(550,300);
    p.lineTo(150,300);p.lineTo(150,0);p.close(); });
  // 'O' — outer contour + a counter (hole), for hole-classification + genus tests
  const O = g("O", 79, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(650,700);p.lineTo(650,0);p.close();
    p.moveTo(200,150);p.lineTo(500,150);p.lineTo(500,550);p.lineTo(200,550);p.close(); });
  // 'I' — a plain bar
  const I = g("I", 73, 400, (p) => { p.moveTo(150,0);p.lineTo(150,700);p.lineTo(250,700);p.lineTo(250,0);p.close(); });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H, O, I] });
  font.kerningPairs = {};
  return font;
}
```

---

### Task 1: Pure `text2d.js` — glyph → curve contours + layout

**Files:**
- Create: `src/framework/geometry/text2d.js`
- Test: `test/text2d.test.js`
- (verify `package.json` has `opentype.js`)

**Interfaces:**
- Produces: `textGlyphs(font, string, opts) => { outer, holes }[]` — one region spec per
  glyph *contour-group*, each `outer`/`holes` a `pathProfile` curve contour
  (`{start, segments}`), already positioned + scaled (cap-height mm) + y-flipped to
  math coords. `opts`: `{ size, align, valign, lineHeight, tracking, kerning }`.

- [ ] **Step 1: Write the failing tests**

Create `test/text2d.test.js`:
```js
import { expect, test } from "vitest";
import opentype from "opentype.js";
import { textGlyphs } from "../src/framework/geometry/text2d.js";
// (paste synthFont() from the plan's "Shared helpers" block here)

const font = synthFont();
const bbox = (regions) => {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  const walk = (c) => { const pts = [c.start, ...c.segments.map((s) => s.to)];
    for (const [x, y] of pts) { lo[0]=Math.min(lo[0],x);lo[1]=Math.min(lo[1],y);hi[0]=Math.max(hi[0],x);hi[1]=Math.max(hi[1],y); } };
  for (const r of regions) { walk(r.outer); r.holes.forEach(walk); }
  return { lo, hi, w: hi[0]-lo[0], h: hi[1]-lo[1] };
};

test("size sets cap height (H is `size` mm tall)", () => {
  const regions = textGlyphs(font, "H", { size: 5 });
  expect(bbox(regions).h).toBeCloseTo(5, 3);          // caps == size mm
});

test("a counter becomes a hole (O = 1 outer + 1 hole)", () => {
  const regions = textGlyphs(font, "O", { size: 5 });
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("advance widths lay glyphs left-to-right; center align spans the origin", () => {
  const c = textGlyphs(font, "HI", { size: 5, align: "center" });
  const b = bbox(c);
  expect(b.w).toBeGreaterThan(5);                      // two glyphs wider than one
  expect(b.lo[0]).toBeLessThan(0); expect(b.hi[0]).toBeGreaterThan(0);   // centered on X
});

test("multi-line stacks lines downward", () => {
  const one = bbox(textGlyphs(font, "H", { size: 5 }));
  const two = bbox(textGlyphs(font, "H\nH", { size: 5 }));
  expect(two.h).toBeGreaterThan(one.h * 1.8);         // ~2 lines + line gap
});

test("tracking widens letter spacing", () => {
  const tight = bbox(textGlyphs(font, "HH", { size: 5, tracking: 0 })).w;
  const loose = bbox(textGlyphs(font, "HH", { size: 5, tracking: 2 })).w;
  expect(loose).toBeGreaterThan(tight + 1.5);
});

test("quadratic glyph commands elevate to cubic contours", () => {
  const Q = new opentype.Glyph({ name: "Q", unicode: 81, advanceWidth: 500,
    path: (() => { const p = new opentype.Path(); p.moveTo(0,0); p.quadraticCurveTo(250,700,500,0); p.close(); return p; })() });
  const f2 = new opentype.Font({ familyName:"T", styleName:"R", unitsPerEm:1000, ascender:800, descender:-200, glyphs:[new opentype.Glyph({name:".notdef",advanceWidth:650,path:new opentype.Path()}), Q] });
  f2.kerningPairs = {};
  const regions = textGlyphs(f2, "Q", { size: 5 });
  const hasCubic = regions[0].outer.segments.some((s) => s.c1 && s.c2);
  expect(hasCubic).toBe(true);                         // Q → cubicTo
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `text2d.js`**

Create `src/framework/geometry/text2d.js`:
```js
// Pure (kernel-free) text layout: an opentype.js font + string → per-glyph curve-
// contour region specs ({outer, holes}, pathProfile contours), positioned + scaled
// so uppercase letters are `size` mm tall, in math (y-up, CCW) coordinates. The
// kernel's text2d maps these to k.shape2d and unions them. No WASM, no DOM.
import { pathProfile } from "./polygon.js";
import { pointInRing } from "./shape2d-regions.js";

const capHeightUnits = (font) =>
  font.tables?.os2?.sCapHeight || font.charToGlyph("H").getBoundingBox().y2 || font.unitsPerEm * 0.7;

// opentype path commands (font units, y-DOWN) → array of pathProfile contours
// (y flipped to math up). Each M starts a new contour; Q elevates to cubic.
function glyphContours(glyph, font) {
  const cmds = glyph.getPath(0, 0, font.unitsPerEm).commands;
  const contours = [];
  let pen = null, cur = null, start = null;
  const P = ([x, y]) => [x, -y];                       // y-down → y-up
  for (const c of cmds) {
    if (c.type === "M") { if (pen) contours.push(pen.close()); start = cur = P([c.x, c.y]); pen = pathProfile(start); }
    else if (c.type === "L") { cur = P([c.x, c.y]); pen.lineTo(cur); }
    else if (c.type === "C") { pen.cubicTo(P([c.x, c.y]), P([c.x1, c.y1]), P([c.x2, c.y2])); cur = P([c.x, c.y]); }
    else if (c.type === "Q") {                          // quadratic → cubic elevation
      const p0 = cur, q = P([c.x1, c.y1]), end = P([c.x, c.y]);
      const c1 = [p0[0] + (2/3)*(q[0]-p0[0]), p0[1] + (2/3)*(q[1]-p0[1])];
      const c2 = [end[0] + (2/3)*(q[0]-end[0]), end[1] + (2/3)*(q[1]-end[1])];
      pen.cubicTo(end, c1, c2); cur = end;
    }
    else if (c.type === "Z") { if (pen) { contours.push(pen.close()); pen = null; } }
  }
  if (pen) contours.push(pen.close());
  return contours;
}

// Coarse-flatten a pathProfile contour to a ring for containment testing only.
function flatten(contour) {
  const ring = [contour.start.slice()];
  for (const s of contour.segments) ring.push(s.to.slice());   // controls omitted — endpoints suffice for inside/outside
  return ring;
}

// Group a glyph's contours into {outer, holes} by even-odd containment depth
// (font winding is unreliable). Returns region specs referencing the ORIGINAL
// curve contours.
function groupContours(contours) {
  const rings = contours.map(flatten);
  const depth = rings.map((r, i) =>
    rings.reduce((n, o, j) => (i !== j && pointInRing(r[0], o) ? n + 1 : n), 0));
  const regions = [];
  contours.forEach((c, i) => { if (depth[i] % 2 === 0) regions.push({ outer: c, holes: [], _i: i }); });
  contours.forEach((c, i) => {
    if (depth[i] % 2 === 1) {                            // hole → nearest containing outer
      const home = regions.find((rg) => pointInRing(rings[i][0], rings[rg._i]));
      (home ?? regions[0])?.holes.push(c);
    }
  });
  return regions.map(({ outer, holes }) => ({ outer, holes }));
}

// Translate a pathProfile contour by (dx,dy) and scale by s (about origin, post-translate order: scale then translate).
const xform = (contour, s, dx, dy) => {
  const T = ([x, y]) => [x * s + dx, y * s + dy];
  const out = { start: T(contour.start), segments: contour.segments.map((seg) => {
    const m = { to: T(seg.to) };
    if (seg.via) m.via = T(seg.via);
    if (seg.c1) { m.c1 = T(seg.c1); m.c2 = T(seg.c2); }
    return m;
  }) };
  return out;
};

export function textGlyphs(font, string, { size = 10, align = "center", valign = "middle",
    lineHeight, tracking = 0, kerning = true } = {}) {
  const upm = font.unitsPerEm;
  const s = size / capHeightUnits(font);                        // font units → mm (cap height)
  const lineAdv = (lineHeight ?? (font.ascender - font.descender) / upm * size * 1.0);
  const kern = (a, b) => { if (!kerning || !a || !b) return 0; try { return font.getKerningValue(a, b); } catch { return 0; } };

  const lines = string.split("\n");
  // 1) lay out each line in font-unit x, collect glyph region specs + line width (mm)
  const laid = lines.map((line) => {
    const glyphs = font.stringToGlyphs(line);
    let penX = 0; const specs = [];
    glyphs.forEach((g, i) => {
      if (i > 0) penX += kern(glyphs[i - 1], g);
      for (const region of groupContours(glyphContours(g, font)))
        specs.push({ region, penX });                          // remember this glyph's pen origin (font units)
      penX += g.advanceWidth + (tracking / s);                  // tracking is mm → font units
    });
    return { specs, widthMm: penX * s };
  });

  const totalH = (lines.length - 1) * lineAdv + size;          // block height (mm), caps as the line box
  const blockDy = valign === "top" ? -size : valign === "bottom" ? totalH - size
    : valign === "middle" ? (totalH / 2 - size) : 0;           // "baseline" → 0

  const out = [];
  laid.forEach(({ specs, widthMm }, li) => {
    const alignDx = align === "center" ? -widthMm / 2 : align === "right" ? -widthMm : 0;
    const dy = -li * lineAdv + blockDy;                         // lines stack downward
    for (const { region, penX } of specs) {
      const dx = penX * s + alignDx;
      out.push({ outer: xform(region.outer, s, dx, dy), holes: region.holes.map((h) => xform(h, s, dx, dy)) });
    }
  });
  return out;
}
```
(Notes: `flatten` uses only segment endpoints for the inside/outside test — adequate for glyph counters, which are well-separated; the emitted geometry keeps the full curves. `tracking/s` converts mm spacing back to font units before the `* s` scale.)

- [ ] **Step 4: Run to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/framework/geometry/text2d.js test/text2d.test.js package.json package-lock.json
git commit -m "feat: pure text2d — opentype glyphs → pathProfile curve contours + layout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Kernel `k.text2d` + font registry

**Files:**
- Modify: `src/framework/geometry/kernel-front.js` (`k.text2d`, `k._fonts`, font resolution)
- Modify: `src/framework/geometry/kernel.js` (`KERNEL_OPS` += `"text2d"`)
- Modify: `docs/KERNEL-CONTRACT.md` (name `text2d`)
- Modify: `src/testing/manifold.js` (accept `{ fonts }` to preload for tests)
- Test: `test/text2d-manifold.test.js`

**Interfaces:**
- Consumes: `textGlyphs` (Task 1); `k.shape2d`, `Shape2D.union`.
- Produces: `k.text2d(string, { font, ...layout }) => Shape2D`. `font` = an
  `ArrayBuffer`/`Uint8Array` (parsed+memoized), a declared name (looked up in
  `k._fonts`), or omitted (the kernel's default font). `k._fonts: Map<string, ParsedFont>`
  is populated by the framework preload (Task 3); a parsed default may be set at boot.

- [ ] **Step 1: Write the failing test**

Create `test/text2d-manifold.test.js`:
```js
import { beforeAll, expect, test } from "vitest";
import opentype from "opentype.js";
import { bootManifoldKernel } from "../src/testing.js";
// (paste synthFont() here)

let k, fontBytes;
beforeAll(async () => {
  const font = synthFont();
  fontBytes = font.toArrayBuffer();
  k = await bootManifoldKernel({ fonts: { test: fontBytes } });   // declared font preloaded for the test
});

test("text2d('HI') by declared font → a Shape2D ~size tall with positive area", () => {
  const s = k.text2d("HI", { font: "test", size: 5 });
  expect(s._shape2d).toBe(true);
  const bb = s.boundingBox();
  expect(bb.max[1] - bb.min[1]).toBeCloseTo(5, 1);
  expect(s.area()).toBeGreaterThan(0);
});

test("text2d('O') extrudes to a solid with a real hole (genus 1)", () => {
  const solid = k.extrude({ profile: k.text2d("O", { font: "test", size: 6 }), h: 1 });
  expect(solid.genus()).toBe(1);
});

test("inline font bytes work without declaration", () => {
  expect(k.text2d("I", { font: fontBytes, size: 4 }).area()).toBeGreaterThan(0);
});

test("text2d is content-hash cached (hit on repeat)", () => {
  k.beginSubPart("t"); k.resetCacheStats();
  const one = () => k.text2d("HI", { font: "test", size: 5 }).area();
  one(); const before = k.cacheStats().hits; one();
  expect(k.cacheStats().hits).toBeGreaterThan(before);
  k.endSubPart();
});

test("unknown declared font throws a clear error", () => {
  expect(() => k.text2d("H", { font: "nope", size: 5 })).toThrow(/font/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d-manifold.test.js`
Expected: FAIL — `k.text2d is not a function` / `bootManifoldKernel` ignores `fonts`.

- [ ] **Step 3: Implement `text2d` in `finishKernel`**

In `src/framework/geometry/kernel-front.js`, add the import and, inside `finishKernel(k)` (before `return k`):
```js
import opentype from "opentype.js";
import { textGlyphs } from "./text2d.js";
import { h } from "./solid-hash.js";
```
```js
  // 2-D text as a Shape2D. Backend-agnostic: builds per-glyph Shape2Ds and unions
  // them. Fonts come from k._fonts (framework-preloaded by name) or inline bytes.
  k._fonts ??= new Map();
  const parseCache = new Map();                                 // content-hash → parsed font (inline bytes)
  const resolveFont = (font) => {
    if (font == null) {
      if (!k._defaultFont) throw new Error("text2d: no font — pass { font } (bytes or a declared name) or configure a default font");
      return k._defaultFont;
    }
    if (typeof font === "string") {
      const f = k._fonts.get(font);
      if (!f) throw new Error(`text2d: unknown font "${font}" — declare it in the part's \`fonts\` field`);
      return f;
    }
    const buf = ArrayBuffer.isView(font) ? font.buffer : font;  // bytes → parse (memoized)
    const key = h("font", buf.byteLength);                      // cheap identity; good enough per-build
    let f = parseCache.get(key);
    if (!f) { f = opentype.parse(buf); parseCache.set(key, f); }
    return f;
  };
  const fontId = (font) => (typeof font === "string" ? font : font == null ? "default" : `bytes:${(ArrayBuffer.isView(font) ? font.byteLength : font.byteLength)}`);
  k.text2d = (string, opts = {}) => {
    const { font, size = 10, align = "center", valign = "middle", lineHeight, tracking = 0, kerning = true } = opts;
    const parsed = resolveFont(font);
    const regions = textGlyphs(parsed, string, { size, align, valign, lineHeight, tracking, kerning });
    if (regions.length === 0) throw new Error("text2d: string produced no glyph geometry (empty or all-whitespace?)");
    return regions.map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
  };
```
(`k._defaultFont` is set at boot in Task 5; until then, omitting `font` throws the clear error above.)

- [ ] **Step 4: List + document + test-boot fonts**

In `src/framework/geometry/kernel.js`, add `"text2d"` to `KERNEL_OPS` (after `"union"`). In `docs/KERNEL-CONTRACT.md`, name `text2d` in the kernel-op list:
```markdown
| `text2d(string, {size, font?, align?, valign?, lineHeight?, tracking?, kerning?})` | Outline-font text → `Shape2D`. `size` = cap height (mm). `font` = declared name / inline bytes / default. Build-time; curve-exact on OCCT, faceted on Manifold. |
```
In `src/testing/manifold.js`, extend `bootManifoldKernel` to accept `{ fonts }` and preload them (parse each and set `kernel._fonts`):
```js
export async function bootManifoldKernel({ quality = "preview", fonts } = {}) {
  const wasm = await Module();
  wasm.setup();
  const kernel = createManifoldKernel(wasm, { quality });
  if (fonts) { const opentype = (await import("opentype.js")).default;
    for (const [name, src] of Object.entries(fonts)) {
      const buf = ArrayBuffer.isView(src) ? src.buffer : src;
      kernel._fonts.set(name, opentype.parse(buf));
    } }
  return kernel;
}
```

- [ ] **Step 5: Run tests + lints**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d-manifold.test.js test/kernel-contract.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add src/framework/geometry/kernel-front.js src/framework/geometry/kernel.js docs/KERNEL-CONTRACT.md src/testing/manifold.js test/text2d-manifold.test.js
git commit -m "feat: k.text2d — text → Shape2D via glyph unions; font registry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Framework font preload — the `fonts` PartDefinition field

**Files:**
- Create: `src/framework/fonts.js` (`resolveFonts` — normalize + fetch + parse, memoized)
- Modify: `src/framework/jobs.js` (`handle`: preload `part.fonts` into the kernel before building)
- Modify: `docs/AUTHORING-PARTS.md` (document the `fonts` field — folded fully in Task 6; a stub pointer here is fine)
- Test: `test/fonts-preload.test.js`

**Interfaces:**
- Consumes: `kernel._fonts` (Task 2).
- Produces: `resolveFonts(fontsDecl) => Promise<Map<string, ArrayBuffer>>` — normalizes
  each declared source (URL string → fetch; bytes → as-is; thunk → await → `{default}`
  or value → recurse), memoized process-wide by source. `handle` awaits it and populates
  `kernel._fonts` (parsed) before the build loop.

- [ ] **Step 1: Write the failing test**

Create `test/fonts-preload.test.js`:
```js
import { expect, test, vi } from "vitest";
import opentype from "opentype.js";
import { resolveFonts } from "../src/framework/fonts.js";
// (paste synthFont() here)

test("resolveFonts normalizes bytes, thunks, and URLs to ArrayBuffers", async () => {
  const bytes = synthFont().toArrayBuffer();
  const g = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ arrayBuffer: async () => bytes }));   // stub URL fetch
  try {
    const map = await resolveFonts({
      a: bytes,                               // inline bytes
      b: () => Promise.resolve({ default: bytes }),   // dynamic-import shape
      c: "https://example.com/font.ttf",      // URL
    });
    expect(map.get("a").byteLength).toBe(bytes.byteLength);
    expect(map.get("b").byteLength).toBe(bytes.byteLength);
    expect(opentype.parse(map.get("c"))).toBeTruthy();   // fetched bytes parse
  } finally { globalThis.fetch = g; }
});

test("resolveFonts memoizes a repeated source (fetch once)", async () => {
  const bytes = synthFont().toArrayBuffer();
  const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => bytes }));
  globalThis.fetch = fetchMock;
  const url = "https://example.com/same.ttf";
  await resolveFonts({ x: url }); await resolveFonts({ y: url });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/fonts-preload.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `resolveFonts` + wire `handle`**

Create `src/framework/fonts.js`:
```js
// Resolve a part's declared `fonts` ({ name: source }) to ArrayBuffers, before the
// synchronous build. A source is: an ArrayBuffer/Uint8Array (bytes), a URL string
// (fetched — a Vite `import('./x.ttf')` yields { default: url }), or a thunk
// returning any of those (possibly async). Memoized process-wide by source so
// repeated builds don't refetch. DOM-free (uses global fetch, present in workers).
const cache = new Map();   // source (string|object) → Promise<ArrayBuffer>

function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer;
  return null;
}

async function resolveOne(source) {
  if (cache.has(source)) return cache.get(source);
  const p = (async () => {
    let v = source;
    if (typeof v === "function") v = await v();
    if (v && typeof v === "object" && "default" in v && !toBuffer(v)) v = v.default;   // dynamic-import module
    const buf = toBuffer(v);
    if (buf) return buf;
    if (typeof v === "string") return await (await fetch(v)).arrayBuffer();
    throw new Error("resolveFonts: a font source must be bytes, a URL string, or a thunk returning one");
  })();
  cache.set(source, p);
  return p;
}

export async function resolveFonts(fontsDecl) {
  const out = new Map();
  if (!fontsDecl) return out;
  await Promise.all(Object.entries(fontsDecl).map(async ([name, src]) => out.set(name, await resolveOne(src))));
  return out;
}
```
In `src/framework/jobs.js`, at the top of `handle` (inside the `try`, before the job-type branches), preload declared fonts into the kernel once:
```js
    if (part.fonts && kernel._fonts) {
      const opentype = (await import("opentype.js")).default;
      const bufs = await resolveFonts(part.fonts);
      for (const [name, buf] of bufs) if (!kernel._fonts.has(name)) kernel._fonts.set(name, opentype.parse(buf));
    }
```
Add the import at the top of `jobs.js`: `import { resolveFonts } from "./fonts.js";`

- [ ] **Step 4: Run to verify pass**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/fonts-preload.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/framework/fonts.js src/framework/jobs.js test/fonts-preload.test.js
git commit -m "feat: fonts PartDefinition field — framework preloads (bundle/URL) before build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: OCCT integration (curve-exact text → STEP)

**Files:**
- Modify: `src/testing/occt.js` (accept `{ fonts }` like the Manifold boot helper)
- Test: `test/text2d-occt.test.js`

**Interfaces:**
- Consumes: `k.text2d` (Task 2), `bootOcctKernel({ fonts })`.

- [ ] **Step 1: Add `{ fonts }` to `bootOcctKernel`**

In `src/testing/occt.js`, after `createOcctKernel(replicad)`, accept + preload fonts the same way as the Manifold helper (parse each into `kernel._fonts`), and change the signature to `bootOcctKernel({ fonts } = {})`.

- [ ] **Step 2: Write the failing test**

Create `test/text2d-occt.test.js`:
```js
import { beforeAll, expect, test } from "vitest";
import opentype from "opentype.js";
import { bootOcctKernel } from "../src/testing/occt.js";
// (paste synthFont() here — but add a glyph with a curve so STEP has a spline)

let k;
beforeAll(async () => { k = await bootOcctKernel({ fonts: { test: curvedFont().toArrayBuffer() } }); });

test("text2d extrudes to a watertight solid on OCCT", () => {
  const solid = k.extrude({ profile: k.text2d("O", { font: "test", size: 6 }), h: 1 });
  expect(solid.volume()).toBeGreaterThan(0);
});

test("a curved glyph keeps exact curves → STEP has a B_SPLINE", async () => {
  const solid = k.extrude({ profile: k.text2d("Q", { font: "test", size: 6 }), h: 1 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "t", solid }]));
  expect(step).toMatch(/B_SPLINE/);
});
```
where `curvedFont()` is `synthFont()` plus a `Q` glyph drawn with `quadraticCurveTo` (see Task 1's Q fixture) so an outline carries a real curve.

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d-occt.test.js`
Expected: FAIL first (`{fonts}` unsupported / text2d absent on this boot), PASS after Step 1 + the already-landed text2d. (text2d itself is backend-agnostic from Task 2 — no OCCT code needed; this task only wires the test-boot fonts and pins OCCT behavior.)

- [ ] **Step 4: Commit**
```bash
git add src/testing/occt.js test/text2d-occt.test.js
git commit -m "test: OCCT text2d — watertight extrude + curve glyphs → STEP B_SPLINE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Default bundled font (Roboto)

**Files:**
- Create: `src/framework/geometry/fonts/default-font.js` (base64-decoded `Uint8Array` of the TTF)
- Modify: `src/framework/geometry/kernel-front.js` (parse + set `k._defaultFont`)
- Test: `test/text2d-manifold.test.js` (a "default font when omitted" case)

**ASSET — already in the repo.** The font is vendored (done during planning):
`src/framework/geometry/fonts/Roboto-Regular.ttf` (Roboto, **SIL OFL 1.1** — the
current Roboto license; note: not Apache 2.0) with `Roboto-LICENSE.txt` beside it.
opentype.js parses it (verified: 1326 glyphs, `os2.sCapHeight` present). No download
needed.

- [ ] **Step 1: Generate the sync bytes module**

Vite serves a plain `.ttf` import as a URL (async), so bundle the bytes as a
synchronously-importable module. Run a small one-off to base64-encode the vendored
TTF into `src/framework/geometry/fonts/default-font.js`:
```js
// scripts-style one-liner (Node): read the ttf, write a base64 module
import { readFileSync, writeFileSync } from "node:fs";
const b64 = readFileSync("src/framework/geometry/fonts/Roboto-Regular.ttf").toString("base64");
writeFileSync("src/framework/geometry/fonts/default-font.js",
  `// Generated from Roboto-Regular.ttf (SIL OFL 1.1 — see Roboto-LICENSE.txt). Do not edit.\n` +
  `const B64 = "${b64}";\n` +
  `export const DEFAULT_FONT_BYTES = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0));\n`);
```
(`atob` exists in Node 24, workers, and browsers. Keep the raw `.ttf` + license for
provenance; the `.js` is what's imported.)

- [ ] **Step 2: Wire it as the default**

In `kernel-front.js`, import the bytes and lazily parse+memoize in the `font == null`
branch of `resolveFont` (replacing the "no default" throw):
```js
import { DEFAULT_FONT_BYTES } from "./fonts/default-font.js";
// …in resolveFont(), the font == null branch:
if (!k._defaultFont) k._defaultFont = opentype.parse(DEFAULT_FONT_BYTES.buffer);
return k._defaultFont;
```

- [ ] **Step 3: Test the default path**

Add to `test/text2d-manifold.test.js`:
```js
test("text2d works with the bundled default font (no { font })", () => {
  expect(k.text2d("A", { size: 5 }).area()).toBeGreaterThan(0);
});
```
Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run test/text2d-manifold.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add src/framework/geometry/fonts/ package.json package-lock.json test/text2d-manifold.test.js
git commit -m "feat: bundle a default font for text2d (zero-config)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs + version bump

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (a "Text" section: `k.text2d`, the `fonts` field, size=cap-height, compose examples)
- Modify: `package.json` (+ lockfile) — minor bump
- Test: full suite + smoke

- [ ] **Step 1: AUTHORING-PARTS**

Add a "Text (`text2d`)" subsection: the `k.text2d(string, {size, ...})` → `Shape2D`
example (emboss/deboss/extrude), the `fonts` PartDefinition field (bundle + URL +
default), `size` = cap height, and that it composes with booleans/offset like any
`Shape2D`. Note it's build-time and curve-exact on OCCT.

- [ ] **Step 2: Version bump**

Edit `package.json` — minor bump (do NOT touch `CONTRACT_VERSION`); sync lockfile:
`source ~/.nvm/nvm.sh && nvm use && npm install --package-lock-only`.

- [ ] **Step 3: Full suite (+ smoke if available)**

Run: `source ~/.nvm/nvm.sh && nvm use && npx vitest run`
Expected: all green. Then `npm run check` if Playwright is available (or note skipped).

- [ ] **Step 4: Commit**
```bash
git add docs/AUTHORING-PARTS.md package.json package-lock.json
git commit -m "docs: document text2d + the fonts field; version bump

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `k.text2d(string, opts)` → `Shape2D` via glyph unions → Tasks 1 (layout) + 2 (kernel). ✅
- Font sourcing: declared (bundle/URL, preloaded) → Task 3; inline bytes → Task 2; default → Task 5. ✅
- `fonts` PartDefinition field + framework preload → Task 3. ✅
- size=cap-height, align/valign/lineHeight/tracking/kerning, multi-line → Task 1. ✅
- Glyph→pathProfile (Q→cubic), containment hole classification → Task 1. ✅
- Content-hash caching → Task 2 (via `Shape2D` union) + test. ✅
- Curve-exact OCCT (STEP `B_SPLINE`), faceted Manifold → Tasks 2 (Manifold) + 4 (OCCT). ✅
- opentype.js dep + default font + license → Tasks 1 (dep) + 5 (font). ✅
- Contract lint (`text2d` in KERNEL_OPS + KERNEL-CONTRACT) → Task 2. ✅

**Placeholder scan:** no logic placeholders. Task 5 has an explicit ASSET hand-off
(a real `.ttf` must be added; core ships without it) — flagged, not hidden. The
`fontId`/parse-memo uses byteLength as a cheap identity — acceptable within a build
(a stronger content hash is a possible refinement, noted).

**Type consistency:** `textGlyphs(font, string, opts) → {outer, holes}[]` (curve
contours) is produced in Task 1 and consumed in Task 2's `k.text2d`; `k._fonts:
Map<name, ParsedFont>` is populated by Task 3's preload and Task 2/5's boot helpers,
read by Task 2's `resolveFont`; `resolveFonts → Map<name, ArrayBuffer>` (bytes,
parsed at injection). opentype conventions (y-down getPath, cap-height fallback,
guarded kerning) are stated once in Global Constraints and applied in Task 1.

**Out of scope (from spec):** single-line/stroke fonts, justification, RTL/vertical,
ligatures beyond kerning, per-glyph styling, text-on-path.
