# vectorText — `k.text2d` → `Shape2D` — design

Date: 2026-07-18
Status: approved design, pre-implementation
Branch: vector-text (stacked on shape2d-offset / F3 #53 → shape2d-booleans / F2 #52,
both unmerged; rebase onto main once F2/F3 land)

## Problem

partforge can compose 2-D shapes (booleans, offset, curves) but can't put **text**
on a part — labels, part numbers, version marks, logos. This is the practical
payoff of the `Shape2D` thread: text as a `Shape2D` you can boolean into a plate
(emboss/deboss), offset for print clearance, and extrude to raised letters.

This is the JSCAD `vectorText` idea, re-scoped for outline (filled) fonts and the
`Shape2D` value.

## Architecture — a consumer of F1/F2/F3, not new kernel plumbing

`k.text2d(string, opts) → Shape2D`. A glyph outline is a set of curve contours
(exactly what `pathProfile` produces); a string is a union of glyphs (a
`Shape2D`). So the pipeline is entirely existing machinery:

```
opentype.js parses a font  →  per glyph: outline path (M/L/Q/C/Z)
  →  pathProfile contours (Q→cubic elevation, C→cubicTo)
  →  glyph counters (holes in O A e 8) classified outer/hole by containment
  →  per-glyph Shape2D  →  positioned by advance + kerning  →  union → text Shape2D
```

**No backend-specific code.** OCCT keeps the glyph curves exact (→ STEP `B_SPLINE`);
Manifold facets them at mesh LOD — both via the `Shape2D`/`pathProfile` paths that
already exist. `text2d` is a kernel method (it needs the kernel to build the
per-glyph `Shape2D`s and `union` them).

## Font sourcing — bring-your-own, from bundle or URL

Builds are **synchronous** pure functions, so a URL (async) can't be fetched
inside `build`. `font` therefore accepts three forms, all resolving to a
synchronous `text2d` call:

1. **Declared fonts (bundle *or* URL) — framework-preloaded. The primary path.**
   A part declares its fonts in a new `fonts` field; the framework resolves them
   (fetch, parse) **before** `build` runs and injects them into the kernel's font
   registry; `text2d` references them by name synchronously. This is the main
   real-world path because in Vite a bundled `import "./font.ttf"` resolves to a
   *URL string* (async fetch), same as a remote URL — the framework normalizes
   both:
   ```js
   export default {
     meta: { … },
     fonts: {
       label:   () => import("./fonts/Roboto.ttf"),        // bundled (async import → bytes)
       heading: "https://cdn.example.com/Orbitron.ttf",     // URL
     },
     parts: { plate: { build(k, p) {
       return k.extrude({ profile: k.text2d(p.name, { font: "heading", size: 8 }), h: 1 });
     } } },
   };
   ```
   A `fonts` value normalizes across: a URL string, an `ArrayBuffer`/`Uint8Array`,
   or a thunk `() => value | Promise<value | {default:value}>` (a dynamic
   `import("./font.ttf")` yields `{ default: url }` under Vite → fetched). The job
   runner resolves each once (memoized across builds, keyed by source), parses via
   opentype.js, registers it by name. URLs load exactly like the WASM assets do,
   off the sync path.
2. **Inline bytes — synchronous, secondary.** When the author already has a
   buffer in hand (Node/tests, or a base64-embedded font), `k.text2d(str, { font:
   bytes })` parses it synchronously (memoized by content hash), no declaration
   needed. In a Vite app the bytes usually aren't available synchronously, so
   path 1 is preferred there.
3. **Default font** — partforge bundles one clean open font (OFL/Apache); used
   when `font` is omitted, so `k.text2d("hi", { size: 5 })` works with zero setup.

### Preload wiring
- **New PartDefinition field `fonts`** (optional): `{ name: source }`.
- **Job runner** (`jobs.js` handler / `worker.js`): before `buildPosed` →
  `build`, `await resolveFonts(part.fonts)` → a `Map(name → parsedFont)`; inject
  into the kernel so `k.text2d` sees it. Memoized process-wide by source, so
  repeated builds don't refetch/reparse.
- **Kernel font registry:** `k` gains an internal `_fonts` map (name → parsed) +
  the parsed default; `k.text2d` resolves `opts.font` = bytes | name | undefined
  to a parsed font. Inline-bytes are parsed+memoized on the spot.
- **Testing helpers** (`bootManifoldKernel`/`bootOcctKernel`) accept an optional
  `{ fonts }` to preload for tests; Node reads font files via `readFileSync`.

## API

```js
k.text2d(string, {
  size,                 // mm — CAP HEIGHT (uppercase letter height); documented
  font,                 // bytes | declared-name | omitted (default font)
  align = "center",     // "left" | "center" | "right"
  valign = "middle",    // "baseline" | "top" | "middle" | "bottom"
  lineHeight,           // mm between baselines for multi-line (default from font metrics)
  tracking = 0,         // mm extra letter spacing
  kerning = true,       // use the font's kern pairs
}) => Shape2D
```

- **`size` = cap height in mm.** Glyph geometry is built in font units, then
  scaled by `size / capHeightUnits`, where `capHeightUnits` is the font's cap
  height (`font.tables.os2.sCapHeight`, or the `H` glyph's bbox height as a
  fallback) — so uppercase letters come out `size` mm tall. (Typographic em-size
  ≈ 1.4× cap height; we pick the intuitive metric and document it.)
- **Anchoring:** default `center`/`middle` puts the text block's bbox center at the
  origin, so `k.text2d(...).at([x,y])` and `plate.cut(text)` compose without extra
  translation.
- **Multi-line:** `\n` splits lines; each line is laid out and `align`-ed; the
  block is spaced by `lineHeight` and `valign`-anchored.
- **Missing glyphs** render the font's `.notdef` box (visible "something's wrong",
  not a silent skip).

## Glyph → contours & winding

- opentype `glyph.getPath(x, y, fontSize)` → commands `M/L/Q/C/Z`. Map: `M`=start,
  `L`=`lineTo`, `Q`=quadratic → elevate to cubic (`c1=p0+⅔(q−p0)`, `c2=p1+⅔(q−p1)`)
  → `cubicTo`, `C`=`cubicTo`, `Z`=close. (`pathProfile` already exists.)
- A glyph has one or more closed contours; counters (`O A e 8 …`) are holes. Font
  winding conventions are inconsistent (TrueType vs CFF), so classify contours
  into `{outer, holes}` by **geometric containment** (reuse the region-nesting
  logic from `shape2d-regions.js`), not by winding sign — then build the per-glyph
  `Shape2D`.

## Caching

`text2d` is content-hash cached like any `Shape2D`. Hash folds the string, a font
identity (content hash / declared name), and all layout opts:
`h("text2d", string, fontId, size, align, valign, lineHeight, tracking, kerning)`.
Glyph→contour construction is pure; the per-glyph `Shape2D`s and their `union`
are cached by the existing `Shape2D` machinery.

## Dependency & default font

- **`opentype.js`** — new runtime dependency (pure JS, works in Node + worker, no
  DOM). Consistent with the existing runtime deps (manifold-3d, replicad, three).
- **Default font** — bundle one clean open sans under a permissive license
  (OFL/Apache — e.g. a Roboto/Inter/Noto subset). Ship the license file. Subset to
  a reasonable character set (ASCII + Latin-1) to keep the bundle small; document
  how to supply a fuller font via `fonts`.

## Scope (v1)

**In:** `k.text2d(string, opts)` → `Shape2D`; `font` = inline bytes / declared name
/ default; the `fonts` PartDefinition field + framework preload; `size`(cap
height)/`align`/`valign`/`lineHeight`/`tracking`/`kerning`; multi-line via `\n`;
containment-based glyph hole classification; content-hash caching; a bundled
default font; curve-exact on OCCT (STEP `B_SPLINE`), faceted on Manifold.

**Deferred:** justification; RTL / vertical text; ligatures beyond kerning;
per-glyph styling; single-line/stroke (Hershey) fonts; font-feature settings;
text-on-a-path.

## Testing

**Pure-ish unit (no kernel):**
- opentype path → `pathProfile` contour conversion (Q elevation, C passthrough,
  Z close) on a known glyph;
- glyph hole classification (`O` → 1 outer + 1 hole; `i` → 2 disjoint outers; `8`
  → outer + 2 holes) via containment;
- layout math: advance/kerning/tracking positions; multi-line offsets; align/valign
  anchoring; `size`→scale (cap height).

**Manifold integration (`bootManifoldKernel`, own file):**
- `k.text2d("HI", { size: 5 })` → a `Shape2D` with sane bbox (~height 5) and area
  > 0; extrude → volume > 0;
- a glyph with a counter (`"O"`) → extrude has genus 1 (a real hole);
- caching: same text twice → cache hit.

**OCCT integration (`bootOcctKernel`, own file):**
- `k.text2d(...)` extrudes to a watertight solid; curve glyphs → STEP contains
  `B_SPLINE`;
- a declared-`fonts` preload path (font bytes via `readFileSync`) resolves and
  `text2d("A", {font:"x"})` renders.

**Font sourcing:**
- inline bytes parse + render; declared name (bytes and a mocked URL) preload +
  render; default font when `font` omitted; a clear error for an unknown declared
  name / unparseable bytes.

## Out of scope (explicitly)

- Single-line/stroke fonts (the "both" option we did not pick).
- Any change to the pure `offsetPolygon` helper or the `Shape2D` core ops.
- Rich text / markup / layout beyond the v1 opts above.
