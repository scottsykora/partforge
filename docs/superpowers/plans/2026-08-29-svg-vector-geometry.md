# SVG Vector Geometry (`k.svg2d`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `k.svg2d(name, opts)` — an SVG file declared in a part's new `svgs` field becomes a `Shape2D`, with strokes outlined into real geometry.

**Architecture:** Eight new pure leaves under `src/framework/geometry/` form a one-directional pipeline (XML → path/transform/shape/style → document → regions), plus `svgs.js` on the existing `asset-resolve.js` core and ~6 lines in `kernel-front.js`. Everything is DOM-free and runs in the geometry worker, exactly like fonts. Stroke outlining is built on `contour-offset.js`, which is already a port of `paperjs-offset` — the library whose `offsetStroke` is the canonical outliner.

**Tech Stack:** Plain ESM, Node 24, vitest. Existing in-repo deps only — `paper` (via `paper-bridge.js`), no new packages.

**Spec:** `docs/superpowers/specs/2026-08-29-svg-vector-geometry-design.md`

## Global Constraints

- **Node 24.** Run `nvm use` before anything. The default shell Node is too old and geometry/tests fail confusingly.
- **Every new `src/framework/geometry/` file is worker-safe:** DOM-free, `three`-free, `node:`-free. `test/worker-layering.test.js:62` greps module *source* for `document`/`window` — a file may not even mention them. It walks the import closure, so it covers new files automatically once `jobs.js` reaches them.
- **No new runtime dependencies.** `svg-xml.js` is hand-rolled. **Tripwire:** if it exceeds ~200 lines or needs entity/CDATA handling to pass the Task 1 corpus, stop, report, and take `svg-parser` instead behind the same interface.
- **Units are millimetres** throughout, and SVG user units are **not** mm — conversion happens once, in Task 8.
- **`build` must stay a pure function of `(k, p, d)`.** No `Math.random`, no clock, no module-level mutable state beyond content-keyed memoization.
- **Contour IR:** `{ start: [x,y], segments: [ {to} | {to,via} | {to,c1,c2} ] }`. Lines, circular arcs (`via` = a point on the arc), cubic Béziers. Built with `pathProfile` from `polygon.js`.
- **Region IR:** `{ outer: Contour, holes: Contour[] }`, outer CCW and holes CW in model (y-up) space.
- **Commit after every task.** Do not batch.
- **Version bump belongs on this branch** (`0.91.0` → `0.92.0`), in Task 12. Forgetting it fails silently — the merge lands and the work never ships.

## File Structure

| File | Responsibility |
|---|---|
| `src/framework/geometry/svg-xml.js` | **Create.** Bytes/text → `{tag, attrs, children}` tree. No repo deps. |
| `src/framework/geometry/svg-path.js` | **Create.** `d` string → contours. Absolute + relative, `H/V/S/T` shorthands, `A` → cubics. |
| `src/framework/geometry/svg-transform.js` | **Create.** `transform=` → 2×3 matrix; compose; apply (degrading arcs to cubics when non-uniform). |
| `src/framework/geometry/svg-shapes.js` | **Create.** `rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon` → contours. |
| `src/framework/geometry/svg-style.js` | **Create.** Presentation attributes → resolved style, inherited through `<g>`. |
| `src/framework/geometry/svg-doc.js` | **Create.** Tree walk → flat `[{ contours, style, closed }]` in user units. |
| `src/framework/geometry/stroke-outline.js` | **Create.** Open/closed contour + stroke style → regions. |
| `src/framework/geometry/svg2d.js` | **Create.** Document + opts → `[{outer, holes}]` in mm. |
| `src/framework/geometry/contour-offset.js` | **Modify.** Export `joinSegs` as `_joinSegs`. One line. |
| `src/framework/svgs.js` | **Create.** Declared sources → decoded documents, on `asset-resolve.js`. |
| `src/framework/geometry/kernel-front.js` | **Modify.** `k._svgs` map + `k.svg2d`. |
| `src/framework/geometry/kernel.js` | **Modify.** Add `"svg2d"` to the op-name list. |
| `src/framework/jobs.js` | **Modify.** Register `k._svgs` in the async pre-phase. |
| `src/framework/lint/rules-svg.js` | **Create.** Two static rules. |
| `src/framework/lint/index.js` | **Modify.** Register `SVG_RULES`. |
| `src/parts/emblem.js` + `emblem.html` + `src/app-emblem.js` + `src/emblem-worker.js` | **Create.** Reference part. |
| `src/parts/assets/emblem.svg` | **Create.** Test artwork: one filled path, one stroked open path. |

**Why `stroke-outline.js` does not modify `_offsetContour`:** that function is ring-oriented throughout — wrap-around modulo indexing, a whole-ring collapse predicate, and an overlap-side trim gate with pinned performance numbers. Threading an "open" flag through it would put every one of those invariants at risk for no gain. `stroke-outline.js` instead calls the *lower-level* exports it already offers (`_offsetSegment`, and `_joinSegs` after Task 7's one-line export) and runs its own much simpler open-chain loop.

---

### Task 1: `svg-xml.js` — XML tree

**Files:**
- Create: `src/framework/geometry/svg-xml.js`
- Test: `test/svg-xml.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseSvgXml(input: string | ArrayBuffer | Uint8Array) → SvgNode`, where `SvgNode = { tag: string, attrs: Record<string,string>, children: SvgNode[] }`. `tag` has any namespace prefix stripped and is lowercased. Throws `Error` starting `"svg: "` on malformed input.

- [ ] **Step 1: Write the failing test**

Create `test/svg-xml.test.js`:

```js
import { expect, test } from "vitest";
import { parseSvgXml } from "../src/framework/geometry/svg-xml.js";

test("parses a root element with attributes", () => {
  const n = parseSvgXml('<svg viewBox="0 0 24 24" width="24"></svg>');
  expect(n.tag).toBe("svg");
  expect(n.attrs.viewBox).toBe("0 0 24 24");
  expect(n.attrs.width).toBe("24");
  expect(n.children).toEqual([]);
});

test("parses nested children and self-closing tags", () => {
  const n = parseSvgXml('<svg><g><path d="M0,0 L1,1"/><circle r="2"/></g></svg>');
  expect(n.children).toHaveLength(1);
  const g = n.children[0];
  expect(g.tag).toBe("g");
  expect(g.children.map((c) => c.tag)).toEqual(["path", "circle"]);
  expect(g.children[0].attrs.d).toBe("M0,0 L1,1");
});

test("strips namespace prefixes from tags and lowercases them", () => {
  const n = parseSvgXml('<svg:SVG xmlns:svg="http://www.w3.org/2000/svg"><svg:Path d="M0,0"/></svg:SVG>');
  expect(n.tag).toBe("svg");
  expect(n.children[0].tag).toBe("path");
});

test("accepts single-quoted attributes and decodes the five predefined entities", () => {
  const n = parseSvgXml("<svg title='a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'></svg>");
  expect(n.attrs.title).toBe(`a & b <c> "d" 'e'`);
});

test("skips comments, the XML declaration, and a DOCTYPE", () => {
  const n = parseSvgXml('<?xml version="1.0"?><!DOCTYPE svg><!-- hi --><svg><path d="M0,0"/></svg>');
  expect(n.tag).toBe("svg");
  expect(n.children).toHaveLength(1);
});

test("accepts a Uint8Array and an ArrayBuffer", () => {
  const bytes = new TextEncoder().encode("<svg></svg>");
  expect(parseSvgXml(bytes).tag).toBe("svg");
  expect(parseSvgXml(bytes.buffer.slice(0)).tag).toBe("svg");
});

test("throws on a mismatched closing tag", () => {
  expect(() => parseSvgXml("<svg><g></path></svg>")).toThrow(/svg: /);
});

test("throws on an unterminated tag rather than hanging", () => {
  expect(() => parseSvgXml('<svg><path d="M0,0"')).toThrow(/svg: /);
});

test("throws when there is no root element", () => {
  expect(() => parseSvgXml("   <!-- nothing -->  ")).toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-xml.test.js`
Expected: FAIL — "Failed to resolve import ... svg-xml.js"

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-xml.js`:

```js
// Minimal XML reader for the SVG subset this framework admits — elements,
// attributes, and the five predefined entities. NOT a general XML parser: no
// DTD, no CDATA, no entity declarations, no namespace resolution (prefixes are
// simply stripped). It exists because the geometry worker has no DOMParser and
// neither does Node, so the browser's parser is unavailable on both paths the
// framework has to serve (see the spec's "Why the worker" section).
//
// Pure leaf: no repo imports, no DOM, no node:.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decodeEntities = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (m, e) => {
    if (ENTITIES[e]) return ENTITIES[e];
    const code = e[1] === "x" || e[1] === "X"
      ? parseInt(e.slice(2), 16)
      : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

// Namespace prefixes carry no meaning for us (we only ever look at SVG
// elements), so `svg:path` and `path` are the same tag.
const normTag = (raw) => raw.replace(/^[^:]*:/, "").toLowerCase();

function toText(input) {
  if (typeof input === "string") return input;
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return new TextDecoder().decode(input);
  throw new Error("svg: input must be a string, ArrayBuffer, or typed array");
}

// `<name a="1" b='2' />` → { attrs, selfClosing }. `src` is the tag's interior,
// after the name.
function readAttrs(src, tagName) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) {
    // Attribute names keep their case: SVG is case-sensitive and `viewBox` is
    // spelled with a capital B. Only TAGS are lowercased.
    attrs[m[1].replace(/^xml:/, "")] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  if (/=\s*[^"'\s>]/.test(src.replace(re, ""))) {
    throw new Error(`svg: unquoted attribute value in <${tagName}>`);
  }
  return attrs;
}

export function parseSvgXml(input) {
  const text = toText(input);
  let i = 0;
  let root = null;
  const stack = [];

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt;

    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw new Error("svg: unterminated comment");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw new Error("svg: unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", i)) {
      // DOCTYPE and friends — skip to the matching '>', tolerating one level of
      // internal subset brackets (`<!DOCTYPE svg [ ... ]>`).
      let depth = 0, j = i + 2;
      for (; j < text.length; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
      }
      if (j >= text.length) throw new Error("svg: unterminated declaration");
      i = j + 1;
      continue;
    }

    const gt = text.indexOf(">", i);
    if (gt < 0) throw new Error("svg: unterminated tag");
    const raw = text.slice(i + 1, gt);
    i = gt + 1;

    if (raw.startsWith("/")) {                                  // closing tag
      const name = normTag(raw.slice(1).trim());
      const open = stack.pop();
      if (!open) throw new Error(`svg: unexpected closing tag </${name}>`);
      if (open.tag !== name) throw new Error(`svg: mismatched closing tag </${name}> for <${open.tag}>`);
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) throw new Error("svg: element with no tag name");
    const tag = normTag(nameMatch[1]);
    const node = { tag, attrs: readAttrs(body.slice(nameMatch[0].length), tag), children: [] };

    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) throw new Error("svg: more than one root element");
    else root = node;

    if (!selfClosing) stack.push(node);
  }

  if (stack.length) throw new Error(`svg: unclosed <${stack.at(-1).tag}>`);
  if (!root) throw new Error("svg: no root element found");
  return root;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-xml.test.js`
Expected: PASS, 8 tests.

Then confirm the tripwire: `wc -l src/framework/geometry/svg-xml.js`. If over 200, stop and report before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-xml.js test/svg-xml.test.js
git commit -m "svg: DOM-free XML reader for the admitted SVG subset"
```

---

### Task 2: `svg-path.js` — path data to contours

**Files:**
- Create: `src/framework/geometry/svg-path.js`
- Test: `test/svg-path.test.js`

**Interfaces:**
- Consumes: `pathProfile` from `./polygon.js`.
- Produces:
  - `svgPathToContours(d: string) → { contour: Contour, closed: boolean }[]` — one entry per subpath. Curve-native: `C`/`S` stay cubic, `Q`/`T` degree-elevate to cubic, `A` becomes ≤90° cubic pieces. Throws `Error` starting `"svg: "` on malformed data.
  - `svgArcToCubics(from: [number,number], rx, ry, rotDeg, largeArc: boolean, sweep: boolean, to: [number,number]) → {to, c1, c2}[]`

- [ ] **Step 1: Write the failing test**

Create `test/svg-path.test.js`:

```js
import { expect, test } from "vitest";
import { svgPathToContours, svgArcToCubics } from "../src/framework/geometry/svg-path.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const area = (c) => Math.abs(ringArea(tessellateContour(c, 64)));

test("absolute M/L/Z gives one closed square", () => {
  const subs = svgPathToContours("M0,0 L10,0 L10,10 L0,10 Z");
  expect(subs).toHaveLength(1);
  expect(subs[0].closed).toBe(true);
  expect(area(subs[0].contour)).toBeCloseTo(100, 6);
});

test("relative m/l/z gives the same square", () => {
  const subs = svgPathToContours("m0,0 l10,0 l0,10 l-10,0 z");
  expect(subs[0].closed).toBe(true);
  expect(area(subs[0].contour)).toBeCloseTo(100, 6);
});

test("H and V shorthands, absolute and relative", () => {
  expect(area(svgPathToContours("M0,0 H10 V10 H0 Z")[0].contour)).toBeCloseTo(100, 6);
  expect(area(svgPathToContours("M0,0 h10 v10 h-10 z")[0].contour)).toBeCloseTo(100, 6);
});

test("an implicit repeated command reuses the previous one (M then L, l then l)", () => {
  // "M0,0 10,0 10,10 0,10 Z" — the pairs after M are implicit L
  expect(area(svgPathToContours("M0,0 10,0 10,10 0,10 Z")[0].contour)).toBeCloseTo(100, 6);
});

test("C stays cubic — one segment with two handles", () => {
  const [{ contour }] = svgPathToContours("M0,0 C0,5 5,10 10,10");
  expect(contour.segments).toHaveLength(1);
  expect(contour.segments[0].c1).toEqual([0, 5]);
  expect(contour.segments[0].c2).toEqual([5, 10]);
  expect(contour.segments[0].to).toEqual([10, 10]);
});

test("S reflects the previous cubic's second handle", () => {
  const [{ contour }] = svgPathToContours("M0,0 C0,5 5,10 10,10 S20,5 20,0");
  const second = contour.segments[1];
  // reflection of c2 (5,10) about the join (10,10) is (15,10)
  expect(second.c1).toEqual([15, 10]);
  expect(second.c2).toEqual([20, 5]);
});

test("S with no preceding cubic uses the current point as its first handle", () => {
  const [{ contour }] = svgPathToContours("M0,0 S5,5 10,0");
  expect(contour.segments[0].c1).toEqual([0, 0]);
});

test("Q degree-elevates to a cubic", () => {
  const [{ contour }] = svgPathToContours("M0,0 Q5,10 10,0");
  const s = contour.segments[0];
  // elevation: c1 = p0 + 2/3(q - p0), c2 = p1 + 2/3(q - p1)
  expect(s.c1[0]).toBeCloseTo(10 / 3, 9);
  expect(s.c1[1]).toBeCloseTo(20 / 3, 9);
  expect(s.c2[0]).toBeCloseTo(10 - 10 / 3, 9);
  expect(s.c2[1]).toBeCloseTo(20 / 3, 9);
});

test("T reflects the previous quadratic's control point", () => {
  const [{ contour }] = svgPathToContours("M0,0 Q5,10 10,0 T20,0");
  expect(contour.segments).toHaveLength(2);
  // implied control is the reflection of (5,10) about (10,0) = (15,-10)
  const s = contour.segments[1];
  expect(s.c1[0]).toBeCloseTo(10 + (2 / 3) * 5, 9);
  expect(s.c1[1]).toBeCloseTo((2 / 3) * -10, 9);
});

test("S after Q falls back to the current point (Q is not a cubic for reflection)", () => {
  const [{ contour }] = svgPathToContours("M0,0 Q5,10 10,0 S20,5 20,0");
  expect(contour.segments[1].c1).toEqual([10, 0]);
});

test("T after C falls back to the current point", () => {
  const [{ contour }] = svgPathToContours("M0,0 C0,5 5,10 10,10 T20,10");
  expect(contour.segments[1].c1).toEqual([10, 10]);
});

test("A semicircle traces the true circle, not a chord", () => {
  // r=2 semicircle from (2,0) to (-2,0): area of the closed half-disc is 2π
  const [{ contour }] = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 Z");
  expect(area(contour)).toBeCloseTo(2 * Math.PI, 1);
});

test("two A commands reconstruct a full circle", () => {
  const [{ contour }] = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 A2,2 0 0 1 2,0 Z");
  expect(area(contour)).toBeCloseTo(Math.PI * 4, 1);
});

test("svgArcToCubics emits <=90 degree pieces with exact endpoints", () => {
  const pieces = svgArcToCubics([2, 0], 2, 2, 0, false, true, [-2, 0]);
  expect(pieces.length).toBeGreaterThanOrEqual(2);
  expect(pieces.at(-1).to[0]).toBeCloseTo(-2, 12);
  expect(pieces.at(-1).to[1]).toBeCloseTo(0, 12);
});

test("a zero radius on A degrades to a straight line", () => {
  const [{ contour }] = svgPathToContours("M0,0 A0,0 0 0 1 10,0");
  expect(contour.segments).toHaveLength(1);
  expect(contour.segments[0].c1).toBeUndefined();
});

test("multiple subpaths come back separately, each with its own closed flag", () => {
  const subs = svgPathToContours("M0,0 L10,0 L10,10 Z M20,0 L30,0 L30,10");
  expect(subs).toHaveLength(2);
  expect(subs[0].closed).toBe(true);
  expect(subs[1].closed).toBe(false);
});

test("a subpath after Z starts at the closed subpath's start point", () => {
  // m relative after z is relative to the START of the closed subpath, not its last point
  const subs = svgPathToContours("M5,5 l10,0 l0,10 z m0,0 l1,0");
  expect(subs[1].contour.start).toEqual([5, 5]);
});

test("minified arc flags parse without separators (SVGO output)", () => {
  // `a2,2 0 01-4,0` is the same semicircle as `A2,2 0 0 1 -2,0`: rot 0, then
  // the two single-character flags 0 and 1, then dx=-4 dy=0.
  const compact = svgPathToContours("M2,0 a2,2 0 01-4,0 z")[0].contour;
  const spaced = svgPathToContours("M2,0 A2,2 0 0 1 -2,0 Z")[0].contour;
  expect(area(compact)).toBeCloseTo(area(spaced), 6);
  expect(area(compact)).toBeCloseTo(2 * Math.PI, 1);
});

test("throws on an arc flag that is not 0 or 1", () => {
  expect(() => svgPathToContours("M0,0 A2,2 0 5 1 4,0")).toThrow(/arc flag/);
});

test("throws on an unknown command letter", () => {
  expect(() => svgPathToContours("M0,0 X10,10")).toThrow(/svg: /);
});

test("throws when a command is short of coordinates", () => {
  expect(() => svgPathToContours("M0,0 L10")).toThrow(/svg: /);
});

test("an empty or whitespace-only d yields no subpaths", () => {
  expect(svgPathToContours("   ")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-path.test.js`
Expected: FAIL — cannot resolve `svg-path.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-path.js`:

```js
// SVG path data (`d`) → curve-native contours. The front end of k.svg2d, and
// the exact analogue of text2d.js's glyphContours: same job (a foreign path
// language → this engine's contour IR), same y-up convention question, same
// "never flatten a curve" rule.
//
// Curve-native by design: C/S stay cubic, Q/T degree-elevate to cubic (the
// same elevation text2d.js already does for TrueType quadratics), and A
// becomes <=90-degree cubic pieces. Nothing is sampled to points here — that
// happens later and only where a backend asks for it.
//
// Coordinates come out in SVG user space, INCLUDING its y-down convention.
// The y flip happens once, in svg2d.js, after transforms are applied — doing
// it here would invert every transform matrix's shear and rotation terms.
//
// Pure leaf: DOM-free, node:-free, no kernel.
import { pathProfile } from "./polygon.js";

const NUM = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

// Tokenize into [{ cmd, args }]. Handles implicit repeats (a command's args
// repeated without re-stating the letter) and SVG's rule that a repeat after M
// is L (after m, l).
//
// Arc flags are scanned specially, and this is not a nicety. In minified path
// data — what SVGO emits, which is most real-world artwork — `a2,2 0 01-4,0`
// is legal: the large-arc and sweep flags are single characters needing no
// separator. A plain number scanner reads "01" as one, every following argument
// shifts by a place, and the result is silently wrong geometry with no error
// anywhere. Positions 3 and 4 of each 7-argument A group therefore consume
// exactly one '0' or '1'.
//
// Anything that is neither a command letter, a separator, nor a number THROWS.
// Skipping it (the obvious regex-scan design) turns "M0,0 X10,10" into a valid
// two-command path — a typo that silently draws a different shape.
const CMD_CHAR = /[MmLlHhVvCcSsQqTtAaZz]/;
const NUM_AT = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;

function tokenize(d) {
  const out = [];
  let i = 0, pending = null, args = [];

  const flush = () => {
    if (!pending) return;
    const need = ARG_COUNT[pending.toUpperCase()];
    if (need === 0) { out.push({ cmd: pending, args: [] }); args = []; return; }
    if (args.length === 0 || args.length % need !== 0)
      throw new Error(`svg: command "${pending}" expects a multiple of ${need} numbers, got ${args.length}`);
    for (let k = 0; k < args.length; k += need) {
      let cmd = pending;
      if (k > 0 && (pending === "M" || pending === "m")) cmd = pending === "M" ? "L" : "l";
      out.push({ cmd, args: args.slice(k, k + need) });
    }
    args = [];
  };

  while (i < d.length) {
    const c = d[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") { i++; continue; }
    if (CMD_CHAR.test(c)) { flush(); pending = c; i++; continue; }
    if (!pending) throw new Error("svg: path data begins with a coordinate, not a command");
    if ((pending === "A" || pending === "a") && (args.length % 7 === 3 || args.length % 7 === 4)) {
      if (c !== "0" && c !== "1") throw new Error(`svg: arc flag must be 0 or 1, got "${c}"`);
      args.push(Number(c)); i++; continue;
    }
    NUM_AT.lastIndex = i;
    const m = NUM_AT.exec(d);
    if (!m || m[0] === "") throw new Error(`svg: unexpected character "${c}" in path data`);
    args.push(parseFloat(m[0]));
    i = NUM_AT.lastIndex;
  }
  flush();
  if (out.length === 0 && d.trim()) throw new Error("svg: unparseable path data");
  return out;
}

// SVG elliptical arc (endpoint parameterization, W3C SVG 1.1 notes F.6) → cubic
// pieces of at most 90 degrees each. Centre-form recovery is the same math as
// shape2d-regions.js's sampleSvgArc — which the tests use as the truth oracle —
// but this emits curves instead of points, with the standard
// k = (4/3)tan(dTheta/4) handle construction (the same one
// paper-bridge.js's arcToCubicSegments uses for circular arcs).
export function svgArcToCubics(from, rx, ry, rotDeg, largeArc, sweep, to) {
  const [x1, y1] = from, [x2, y2] = to;
  if (!rx || !ry) return [{ to: [x2, y2] }];                 // zero radius → line, per spec
  const phi = (rotDeg * Math.PI) / 180, cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let RX = Math.abs(rx), RY = Math.abs(ry);
  const lambda = (x1p * x1p) / (RX * RX) + (y1p * y1p) / (RY * RY);
  if (lambda > 1) { const s = Math.sqrt(lambda); RX *= s; RY *= s; }   // spec: scale radii up
  const num = RX * RX * RY * RY - RX * RX * y1p * y1p - RY * RY * x1p * x1p;
  const den = RX * RX * y1p * y1p + RY * RY * x1p * x1p;
  if (den === 0) return [{ to: [x2, y2] }];
  let coef = Math.sqrt(Math.max(0, num / den));
  if (Boolean(largeArc) === Boolean(sweep)) coef = -coef;
  const cxp = (coef * RX * y1p) / RY, cyp = (-coef * RY * x1p) / RX;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dotv = ux * vx + uy * vy, l = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12;
    let a = Math.acos(Math.min(1, Math.max(-1, dotv / l)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / RX, (y1p - cyp) / RY);
  let dT = angle((x1p - cxp) / RX, (y1p - cyp) / RY, (-x1p - cxp) / RX, (-y1p - cyp) / RY);
  if (!sweep && dT > 0) dT -= 2 * Math.PI;
  if (sweep && dT < 0) dT += 2 * Math.PI;

  // Point and derivative on the rotated ellipse at parameter t.
  const P = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [cx + RX * c * cosP - RY * s * sinP, cy + RX * c * sinP + RY * s * cosP];
  };
  const D = (t) => {
    const c = Math.cos(t), s = Math.sin(t);
    return [-RX * s * cosP - RY * c * sinP, -RX * s * sinP + RY * c * cosP];
  };

  const pieces = Math.max(1, Math.ceil(Math.abs(dT) / (Math.PI / 2) - 1e-9));
  const out = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = t1 + dT * (i / pieces), a1 = t1 + dT * ((i + 1) / pieces);
    const k = (4 / 3) * Math.tan((a1 - a0) / 4);             // magic-number Bézier handle scale
    const p0 = P(a0), p1 = P(a1), d0 = D(a0), d1 = D(a1);
    out.push({
      to: p1,
      c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]],
      c2: [p1[0] - k * d1[0], p1[1] - k * d1[1]],
    });
  }
  out.at(-1).to = [x2, y2];                                   // pin the exact endpoint
  return out;
}

export function svgPathToContours(d) {
  if (typeof d !== "string" || !d.trim()) return [];
  const tokens = tokenize(d);
  const subs = [];
  let pen = null;                 // pathProfile builder for the open subpath
  let cur = [0, 0];               // current point (spec: a relative first moveto is absolute)
  let sub = null;                 // this subpath's start point
  let prevCubicC2 = null;         // for S
  let prevQuadC = null;           // for T
  let closed = false;

  const finish = () => {
    if (!pen) return;
    // A subpath with no segments (a lone M) contributes nothing.
    try { subs.push({ contour: pen.close(), closed }); } catch { /* no segments */ }
    pen = null;
  };
  const need = (args, n, cmd) => {
    if (args.length < n) throw new Error(`svg: command "${cmd}" is short of coordinates`);
  };

  for (const { cmd, args } of tokens) {
    const rel = cmd === cmd.toLowerCase() && cmd !== "Z";
    const C = cmd.toUpperCase();
    const ax = (v) => (rel ? cur[0] + v : v);
    const ay = (v) => (rel ? cur[1] + v : v);

    if (C === "Z") {
      if (pen) { closed = true; finish(); }
      cur = sub ? [sub[0], sub[1]] : cur;      // per spec the pen returns to the subpath start
      prevCubicC2 = prevQuadC = null;
      continue;
    }

    if (C === "M") {
      need(args, 2, cmd);
      finish();
      cur = [ax(args[0]), ay(args[1])];
      sub = [cur[0], cur[1]];
      closed = false;
      pen = pathProfile(cur);
      prevCubicC2 = prevQuadC = null;
      continue;
    }

    if (!pen) throw new Error(`svg: command "${cmd}" before any moveto`);

    if (C === "L") { need(args, 2, cmd); cur = [ax(args[0]), ay(args[1])]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "H") { need(args, 1, cmd); cur = [rel ? cur[0] + args[0] : args[0], cur[1]]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "V") { need(args, 1, cmd); cur = [cur[0], rel ? cur[1] + args[0] : args[0]]; pen.lineTo(cur); prevCubicC2 = prevQuadC = null; }
    else if (C === "C") {
      need(args, 6, cmd);
      const c1 = [ax(args[0]), ay(args[1])], c2 = [ax(args[2]), ay(args[3])], to = [ax(args[4]), ay(args[5])];
      pen.cubicTo(to, c1, c2); cur = to; prevCubicC2 = c2; prevQuadC = null;
    }
    else if (C === "S") {
      need(args, 4, cmd);
      // The implied first handle is the reflection of the previous cubic's
      // second handle about the current point; with no previous cubic the spec
      // says use the current point itself.
      const c1 = prevCubicC2 ? [2 * cur[0] - prevCubicC2[0], 2 * cur[1] - prevCubicC2[1]] : [cur[0], cur[1]];
      const c2 = [ax(args[0]), ay(args[1])], to = [ax(args[2]), ay(args[3])];
      pen.cubicTo(to, c1, c2); cur = to; prevCubicC2 = c2; prevQuadC = null;
    }
    else if (C === "Q" || C === "T") {
      let q, to;
      if (C === "Q") { need(args, 4, cmd); q = [ax(args[0]), ay(args[1])]; to = [ax(args[2]), ay(args[3])]; }
      else {
        need(args, 2, cmd);
        q = prevQuadC ? [2 * cur[0] - prevQuadC[0], 2 * cur[1] - prevQuadC[1]] : [cur[0], cur[1]];
        to = [ax(args[0]), ay(args[1])];
      }
      // Degree elevation, identical to text2d.js's TrueType quadratic handling.
      const c1 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
      const c2 = [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])];
      // prevCubicC2 is CLEARED, not set: per SVG 1.1 §8.3.6, `S` reflects only
      // when the previous command was C/c/S/s. After Q/q/T/t its implied first
      // handle is the current point. Setting it to the elevated c2 here makes
      // a following S bend the wrong way, silently, on legal input.
      pen.cubicTo(to, c1, c2); cur = to; prevQuadC = q; prevCubicC2 = null;
    }
    else if (C === "A") {
      need(args, 7, cmd);
      const to = [ax(args[5]), ay(args[6])];
      for (const piece of svgArcToCubics(cur, args[0], args[1], args[2], !!args[3], !!args[4], to)) {
        if (piece.c1) pen.cubicTo(piece.to, piece.c1, piece.c2);
        else pen.lineTo(piece.to);
      }
      cur = to; prevCubicC2 = prevQuadC = null;
    }
    else throw new Error(`svg: unsupported path command "${cmd}"`);
  }
  finish();
  return subs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-path.test.js`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-path.js test/svg-path.test.js
git commit -m "svg: curve-native path-data parser (relative, shorthands, arcs)"
```

---

### Task 3: `svg-transform.js` — matrices

**Files:**
- Create: `src/framework/geometry/svg-transform.js`
- Test: `test/svg-transform.test.js`

**Interfaces:**
- Consumes: `arcToCubicSegments` from `./paper-bridge.js`.
- Produces:
  - `parseTransform(spec: string) → Matrix` where `Matrix = [a,b,c,d,e,f]` in SVG order (`x' = a·x + c·y + e`, `y' = b·x + d·y + f`). An empty or absent spec gives the identity. Throws `Error` starting `"svg: "` on an unknown function.
  - `IDENTITY: Matrix`
  - `composeMatrix(parent: Matrix, child: Matrix) → Matrix` — parent applied after child, i.e. the ancestor-first accumulation order.
  - `isUniformMatrix(m: Matrix) → boolean` — true when the linear part is a similarity (rotation and/or reflection with one uniform scale), which is exactly when a circular arc stays a circular arc.
  - `applyMatrixToContour(contour: Contour, m: Matrix) → Contour` — degrades `{to,via}` arcs to cubics first when `m` is not uniform.

- [ ] **Step 1: Write the failing test**

Create `test/svg-transform.test.js`:

```js
import { expect, test } from "vitest";
import { parseTransform, composeMatrix, isUniformMatrix, applyMatrixToContour, IDENTITY }
  from "../src/framework/geometry/svg-transform.js";

test("an absent or empty spec is the identity", () => {
  expect(parseTransform(undefined)).toEqual(IDENTITY);
  expect(parseTransform("   ")).toEqual(IDENTITY);
});

test("translate with one and two arguments", () => {
  expect(parseTransform("translate(3 4)")).toEqual([1, 0, 0, 1, 3, 4]);
  expect(parseTransform("translate(3)")).toEqual([1, 0, 0, 1, 3, 0]);
});

test("scale with one and two arguments", () => {
  expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
  expect(parseTransform("scale(2,3)")).toEqual([2, 0, 0, 3, 0, 0]);
});

test("rotate about the origin and about a point", () => {
  const r = parseTransform("rotate(90)");
  expect(r[0]).toBeCloseTo(0, 12);
  expect(r[1]).toBeCloseTo(1, 12);
  const about = parseTransform("rotate(90 10 0)");
  // (10,0) is the fixed point
  expect(about[0] * 10 + about[2] * 0 + about[4]).toBeCloseTo(10, 9);
  expect(about[1] * 10 + about[3] * 0 + about[5]).toBeCloseTo(0, 9);
});

test("matrix() passes its six numbers through", () => {
  expect(parseTransform("matrix(1 2 3 4 5 6)")).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a list of transforms applies left-to-right", () => {
  // translate then scale: the scale is applied first to the point, per SVG
  const m = parseTransform("translate(10 0) scale(2)");
  expect(m[0] * 1 + m[2] * 0 + m[4]).toBeCloseTo(12, 9);
});

test("skewX shears", () => {
  const m = parseTransform("skewX(45)");
  expect(m[2]).toBeCloseTo(1, 9);
});

test("throws on an unknown transform function", () => {
  expect(() => parseTransform("wobble(3)")).toThrow(/svg: /);
});

test("composeMatrix applies the parent after the child", () => {
  const child = parseTransform("translate(1 0)");
  const parent = parseTransform("scale(10)");
  const m = composeMatrix(parent, child);
  // a point at origin: child moves it to (1,0), parent scales to (10,0)
  expect([m[0] * 0 + m[2] * 0 + m[4], m[1] * 0 + m[3] * 0 + m[5]]).toEqual([10, 0]);
});

test("isUniformMatrix accepts rotation, uniform scale, and reflection", () => {
  expect(isUniformMatrix(IDENTITY)).toBe(true);
  expect(isUniformMatrix(parseTransform("scale(3)"))).toBe(true);
  expect(isUniformMatrix(parseTransform("rotate(37)"))).toBe(true);
  expect(isUniformMatrix(parseTransform("scale(-1,1)"))).toBe(true);
});

test("isUniformMatrix rejects non-uniform scale and skew", () => {
  expect(isUniformMatrix(parseTransform("scale(2,3)"))).toBe(false);
  expect(isUniformMatrix(parseTransform("skewX(20)"))).toBe(false);
});

test("a uniform matrix keeps an arc symbolic", () => {
  const arc = { start: [1, 0], segments: [{ via: [0, 1], to: [-1, 0] }] };
  const out = applyMatrixToContour(arc, parseTransform("scale(2)"));
  expect(out.segments).toHaveLength(1);
  expect(out.segments[0].via).toEqual([0, 2]);
  expect(out.segments[0].c1).toBeUndefined();
});

test("a non-uniform matrix degrades an arc to cubics", () => {
  const arc = { start: [1, 0], segments: [{ via: [0, 1], to: [-1, 0] }] };
  const out = applyMatrixToContour(arc, parseTransform("scale(2,1)"));
  expect(out.segments.length).toBeGreaterThan(1);
  for (const s of out.segments) {
    expect(s.via).toBeUndefined();
    expect(s.c1).toBeDefined();
  }
  // endpoint still lands where the matrix says
  expect(out.segments.at(-1).to[0]).toBeCloseTo(-2, 9);
});

test("cubic handles transform along with their endpoints", () => {
  const c = { start: [0, 0], segments: [{ to: [10, 0], c1: [0, 5], c2: [10, 5] }] };
  const out = applyMatrixToContour(c, parseTransform("translate(1 2)"));
  expect(out.start).toEqual([1, 2]);
  expect(out.segments[0].c1).toEqual([1, 7]);
  expect(out.segments[0].to).toEqual([11, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-transform.test.js`
Expected: FAIL — cannot resolve `svg-transform.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-transform.js`:

```js
// SVG `transform=` attributes: parse, compose down the element tree, and apply
// to a contour.
//
// The one non-obvious rule is arc survival. A circular arc ({to,via}) stays a
// circular arc only under a SIMILARITY — rotation, uniform scale, reflection.
// Under a non-uniform scale or a skew it becomes an ellipse, which this
// engine's contour IR cannot represent, so applyMatrixToContour degrades such
// arcs to cubics FIRST (cubics being closed under affine transform). Uniform
// matrices keep arcs symbolic, which is what lets OCCT build true circular
// B-rep edges from transformed artwork.
//
// Matrices are SVG-ordered [a,b,c,d,e,f]:  x' = a*x + c*y + e
//                                          y' = b*x + d*y + f
//
// Pure leaf: DOM-free, node:-free.
import { arcToCubicSegments } from "./paper-bridge.js";

export const IDENTITY = [1, 0, 0, 1, 0, 0];

const UNIFORM_EPS = 1e-9;

// parent ∘ child — the parent's matrix applied AFTER the child's, which is the
// order an ancestor-to-descendant walk needs.
export function composeMatrix(p, c) {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

const rad = (deg) => (deg * Math.PI) / 180;

function primitive(name, a) {
  const n = (i, dflt = 0) => (a.length > i ? a[i] : dflt);
  switch (name) {
    case "matrix":
      if (a.length !== 6) throw new Error("svg: matrix() takes exactly 6 numbers");
      return [...a];
    case "translate": return [1, 0, 0, 1, n(0), n(1)];
    case "scale":     return [n(0, 1), 0, 0, a.length > 1 ? a[1] : n(0, 1), 0, 0];
    case "rotate": {
      const c = Math.cos(rad(n(0))), s = Math.sin(rad(n(0)));
      const R = [c, s, -s, c, 0, 0];
      if (a.length < 3) return R;
      const cx = a[1], cy = a[2];
      // translate(cx,cy) ∘ R ∘ translate(-cx,-cy)
      return composeMatrix(composeMatrix([1, 0, 0, 1, cx, cy], R), [1, 0, 0, 1, -cx, -cy]);
    }
    case "skewx": return [1, 0, Math.tan(rad(n(0))), 1, 0, 0];
    case "skewy": return [1, Math.tan(rad(n(0))), 0, 1, 0, 0];
    default: throw new Error(`svg: unsupported transform function "${name}()"`);
  }
}

export function parseTransform(spec) {
  if (typeof spec !== "string" || !spec.trim()) return [...IDENTITY];
  let m = [...IDENTITY];
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let hit = null, consumed = 0;
  while ((hit = re.exec(spec))) {
    const nums = (hit[2].match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    // Left-to-right in the attribute means each successive primitive composes
    // on the RIGHT — it is applied to the point earlier.
    m = composeMatrix(m, primitive(hit[1].toLowerCase(), nums));
    consumed += hit[0].length;
  }
  if (consumed === 0) throw new Error(`svg: unparseable transform "${spec}"`);
  return m;
}

// A similarity: columns orthogonal and of equal length. That is precisely the
// condition under which circles map to circles.
export function isUniformMatrix(m) {
  const [a, b, c, d] = m;
  const col1 = a * a + b * b, col2 = c * c + d * d;
  const scale = Math.max(col1, col2, 1);
  return Math.abs(col1 - col2) <= UNIFORM_EPS * scale
      && Math.abs(a * c + b * d) <= UNIFORM_EPS * scale;
}

const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function applyMatrixToContour(contour, m) {
  const uniform = isUniformMatrix(m);
  const start = apply(m, contour.start);
  const segments = [];
  let prev = contour.start;
  for (const s of contour.segments) {
    if (s.via && !uniform) {
      // Ellipse-under-affine: expand to cubics in SOURCE space (where the arc
      // is still circular), then transform the cubics, which are closed under
      // affine maps.
      for (const piece of arcToCubicSegments(prev, s.via, s.to)) {
        segments.push(piece.c1
          ? { to: apply(m, piece.to), c1: apply(m, piece.c1), c2: apply(m, piece.c2) }
          : { to: apply(m, piece.to) });
      }
    } else if (s.via) segments.push({ via: apply(m, s.via), to: apply(m, s.to) });
    else if (s.c1) segments.push({ to: apply(m, s.to), c1: apply(m, s.c1), c2: apply(m, s.c2) });
    else segments.push({ to: apply(m, s.to) });
    prev = s.to;
  }
  return { start, segments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-transform.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-transform.js test/svg-transform.test.js
git commit -m "svg: transform parsing, composition, and arc-safe application"
```

---

### Task 4: `svg-shapes.js` — shape elements

**Files:**
- Create: `src/framework/geometry/svg-shapes.js`
- Test: `test/svg-shapes.test.js`

**Interfaces:**
- Consumes: `svgPathToContours` from `./svg-path.js`, `pathProfile` from `./polygon.js`.
- Produces: `shapeToContours(tag: string, attrs: Record<string,string>) → { contour: Contour, closed: boolean }[]`. Returns `[]` for a degenerate shape (zero or negative width/height/radius) — that is not an error, it is a shape with no area, and SVG renders nothing for it. Throws `Error` starting `"svg: "` only for a tag it does not handle.

- [ ] **Step 1: Write the failing test**

Create `test/svg-shapes.test.js`:

```js
import { expect, test } from "vitest";
import { shapeToContours } from "../src/framework/geometry/svg-shapes.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const area = (c) => Math.abs(ringArea(tessellateContour(c, 128)));
const only = (tag, attrs) => {
  const subs = shapeToContours(tag, attrs);
  expect(subs).toHaveLength(1);
  return subs[0];
};

test("rect without radii is a closed four-segment box", () => {
  const { contour, closed } = only("rect", { x: "1", y: "2", width: "10", height: "4" });
  expect(closed).toBe(true);
  expect(area(contour)).toBeCloseTo(40, 6);
});

test("rect with rx rounds its corners and loses the corner area", () => {
  const { contour } = only("rect", { width: "10", height: "10", rx: "2" });
  // 100 minus the four corner offcuts: 4r^2 - pi*r^2
  expect(area(contour)).toBeCloseTo(100 - (4 - Math.PI) * 4, 1);
});

test("rect with only ry mirrors it to rx, per spec", () => {
  const a = area(only("rect", { width: "10", height: "10", ry: "2" }).contour);
  const b = area(only("rect", { width: "10", height: "10", rx: "2" }).contour);
  expect(a).toBeCloseTo(b, 6);
});

test("rect radii clamp to half the side", () => {
  const { contour } = only("rect", { width: "10", height: "10", rx: "50" });
  expect(area(contour)).toBeCloseTo(Math.PI * 25, 1);   // becomes a circle
});

test("a degenerate rect contributes nothing", () => {
  expect(shapeToContours("rect", { width: "0", height: "10" })).toEqual([]);
  expect(shapeToContours("rect", { width: "-3", height: "10" })).toEqual([]);
});

test("circle is exact — arcs, not cubics — and has the right area", () => {
  const { contour } = only("circle", { cx: "5", cy: "5", r: "3" });
  expect(contour.segments.every((s) => s.via)).toBe(true);
  expect(area(contour)).toBeCloseTo(Math.PI * 9, 1);
});

test("ellipse with equal radii is also exact", () => {
  const { contour } = only("ellipse", { rx: "3", ry: "3" });
  expect(contour.segments.every((s) => s.via)).toBe(true);
});

test("ellipse with unequal radii has the right area", () => {
  const { contour } = only("ellipse", { rx: "6", ry: "3" });
  expect(area(contour)).toBeCloseTo(Math.PI * 18, 1);
});

test("line is a single open segment", () => {
  const { contour, closed } = only("line", { x1: "0", y1: "0", x2: "10", y2: "5" });
  expect(closed).toBe(false);
  expect(contour.segments).toHaveLength(1);
  expect(contour.segments[0].to).toEqual([10, 5]);
});

test("polyline is open, polygon is closed, same points", () => {
  const pts = { points: "0,0 10,0 10,10" };
  expect(only("polyline", pts).closed).toBe(false);
  expect(only("polygon", pts).closed).toBe(true);
  expect(area(only("polygon", pts).contour)).toBeCloseTo(50, 6);
});

test("polygon points accept comma or whitespace separation", () => {
  const a = area(only("polygon", { points: "0,0 10,0 10,10 0,10" }).contour);
  const b = area(only("polygon", { points: "0 0 10 0 10 10 0 10" }).contour);
  expect(a).toBeCloseTo(b, 9);
  expect(a).toBeCloseTo(100, 6);
});

test("a polygon with fewer than two points contributes nothing", () => {
  expect(shapeToContours("polygon", { points: "5,5" })).toEqual([]);
});

test("path delegates to the path parser", () => {
  expect(area(only("path", { d: "M0,0 L10,0 L10,10 L0,10 Z" }).contour)).toBeCloseTo(100, 6);
});

test("throws on a tag it does not handle", () => {
  expect(() => shapeToContours("banana", {})).toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-shapes.test.js`
Expected: FAIL — cannot resolve `svg-shapes.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-shapes.js`:

```js
// SVG shape elements → contours.
//
// Most shapes are expressed as a `d` string and handed to svgPathToContours,
// which keeps this file to geometry-free bookkeeping and means the path parser
// stays the single implementation of every command.
//
// The ONE exception is a circular shape (`circle`, or `ellipse` with rx === ry).
// The d-string route would send it through `A`, which emits cubics, and a
// circle is the case where staying symbolic pays: an arc contour gives OCCT a
// true circular B-rep edge. So circles are built directly with pathProfile's
// arcTo, as two semicircles.
//
// A degenerate shape (zero/negative extent) returns [] rather than throwing —
// SVG renders nothing for it, and an icon with an empty <rect> in it is
// perfectly ordinary artwork, not an error.
//
// Pure leaf: DOM-free, node:-free.
import { pathProfile } from "./polygon.js";
import { svgPathToContours } from "./svg-path.js";

const num = (attrs, name, dflt = 0) => {
  const v = parseFloat(attrs[name]);
  return Number.isFinite(v) ? v : dflt;
};

// Two semicircles through the left and right extremes — exact, symbolic, and
// the winding comes out CCW in SVG's y-down space (which svg2d.js flips).
function circleContour(cx, cy, rx, ry) {
  const right = [cx + rx, cy], left = [cx - rx, cy];
  return pathProfile(right)
    .arcTo(left, [cx, cy + ry])
    .arcTo(right, [cx, cy - ry])
    .close();
}

function rectPath(attrs) {
  const x = num(attrs, "x"), y = num(attrs, "y");
  const w = num(attrs, "width"), h = num(attrs, "height");
  if (!(w > 0) || !(h > 0)) return null;
  // Per spec: a missing rx takes ry's value and vice versa; both clamp to half
  // the corresponding side.
  const hasRx = attrs.rx != null && attrs.rx !== "", hasRy = attrs.ry != null && attrs.ry !== "";
  let rx = hasRx ? num(attrs, "rx") : hasRy ? num(attrs, "ry") : 0;
  let ry = hasRy ? num(attrs, "ry") : hasRx ? num(attrs, "rx") : 0;
  rx = Math.max(0, Math.min(rx, w / 2));
  ry = Math.max(0, Math.min(ry, h / 2));
  if (rx === 0 || ry === 0) {
    return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
  }
  return [
    `M${x + rx},${y}`,
    `H${x + w - rx}`,
    `A${rx},${ry} 0 0 1 ${x + w},${y + ry}`,
    `V${y + h - ry}`,
    `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}`,
    `H${x + rx}`,
    `A${rx},${ry} 0 0 1 ${x},${y + h - ry}`,
    `V${y + ry}`,
    `A${rx},${ry} 0 0 1 ${x + rx},${y}`,
    "Z",
  ].join(" ");
}

const parsePoints = (raw) =>
  (String(raw ?? "").match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);

function polyPath(attrs, close) {
  const n = parsePoints(attrs.points);
  if (n.length < 4) return null;                       // fewer than two points
  const pairs = [];
  for (let i = 0; i + 1 < n.length; i += 2) pairs.push(`${n[i]},${n[i + 1]}`);
  return `M${pairs[0]} L${pairs.slice(1).join(" L")}${close ? " Z" : ""}`;
}

export function shapeToContours(tag, attrs) {
  switch (tag) {
    case "path":
      return svgPathToContours(attrs.d ?? "");

    case "rect": {
      const d = rectPath(attrs);
      return d ? svgPathToContours(d) : [];
    }

    case "circle": {
      const r = num(attrs, "r");
      if (!(r > 0)) return [];
      return [{ contour: circleContour(num(attrs, "cx"), num(attrs, "cy"), r, r), closed: true }];
    }

    case "ellipse": {
      const rx = num(attrs, "rx"), ry = num(attrs, "ry");
      if (!(rx > 0) || !(ry > 0)) return [];
      const cx = num(attrs, "cx"), cy = num(attrs, "cy");
      if (rx === ry) return [{ contour: circleContour(cx, cy, rx, ry), closed: true }];
      return svgPathToContours(
        `M${cx + rx},${cy} A${rx},${ry} 0 0 1 ${cx - rx},${cy} A${rx},${ry} 0 0 1 ${cx + rx},${cy} Z`);
    }

    case "line": {
      const x1 = num(attrs, "x1"), y1 = num(attrs, "y1");
      const x2 = num(attrs, "x2"), y2 = num(attrs, "y2");
      if (x1 === x2 && y1 === y2) return [];
      return [{ contour: pathProfile([x1, y1]).lineTo([x2, y2]).close(), closed: false }];
    }

    case "polyline":
    case "polygon": {
      const d = polyPath(attrs, tag === "polygon");
      return d ? svgPathToContours(d) : [];
    }

    default:
      throw new Error(`svg: <${tag}> is not a shape element`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-shapes.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-shapes.js test/svg-shapes.test.js
git commit -m "svg: shape elements to contours, exact arcs for circles"
```

---

### Task 5: `svg-style.js` — presentation attributes

**Files:**
- Create: `src/framework/geometry/svg-style.js`
- Test: `test/svg-style.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ROOT_STYLE: Style` — the SVG initial values.
  - `resolveStyle(parent: Style, attrs: Record<string,string>) → Style`, where `Style = { fill: boolean, fillRule: "nonzero"|"evenodd", stroke: boolean, strokeWidth: number, linecap: "butt"|"round"|"square", linejoin: "miter"|"round"|"bevel", miterLimit: number, display: boolean }`.

Only *whether* paint is present is modelled — `fill`/`stroke` collapse to booleans, because this op produces geometry and not colour.

- [ ] **Step 1: Write the failing test**

Create `test/svg-style.test.js`:

```js
import { expect, test } from "vitest";
import { resolveStyle, ROOT_STYLE } from "../src/framework/geometry/svg-style.js";

const r = (attrs, parent = ROOT_STYLE) => resolveStyle(parent, attrs);

test("SVG initial values: filled black, no stroke, nonzero", () => {
  expect(ROOT_STYLE.fill).toBe(true);
  expect(ROOT_STYLE.stroke).toBe(false);
  expect(ROOT_STYLE.fillRule).toBe("nonzero");
  expect(ROOT_STYLE.strokeWidth).toBe(1);
  expect(ROOT_STYLE.display).toBe(true);
});

test("fill=none turns fill off; any colour turns it on", () => {
  expect(r({ fill: "none" }).fill).toBe(false);
  expect(r({ fill: "#ff0000" }).fill).toBe(true);
  expect(r({ fill: "NONE" }).fill).toBe(false);
});

test("stroke presence and width", () => {
  const s = r({ stroke: "#000", "stroke-width": "2.5" });
  expect(s.stroke).toBe(true);
  expect(s.strokeWidth).toBeCloseTo(2.5, 9);
});

test("stroke-width defaults to 1 when stroke is set without it", () => {
  expect(r({ stroke: "#000" }).strokeWidth).toBe(1);
});

test("fill-rule evenodd is picked up; an unknown value keeps nonzero", () => {
  expect(r({ "fill-rule": "evenodd" }).fillRule).toBe("evenodd");
  expect(r({ "fill-rule": "sideways" }).fillRule).toBe("nonzero");
});

test("linecap and linejoin are read, unknown values fall back", () => {
  expect(r({ "stroke-linecap": "round" }).linecap).toBe("round");
  expect(r({ "stroke-linejoin": "bevel" }).linejoin).toBe("bevel");
  expect(r({ "stroke-linecap": "flange" }).linecap).toBe("butt");
  expect(r({ "stroke-linejoin": "flange" }).linejoin).toBe("miter");
});

test("values inherit from the parent when the child says nothing", () => {
  const parent = r({ fill: "none", stroke: "#000", "stroke-width": "4", "stroke-linecap": "round" });
  const child = resolveStyle(parent, {});
  expect(child.fill).toBe(false);
  expect(child.stroke).toBe(true);
  expect(child.strokeWidth).toBe(4);
  expect(child.linecap).toBe("round");
});

test("a child overrides an inherited value", () => {
  const parent = r({ fill: "none" });
  expect(resolveStyle(parent, { fill: "#000" }).fill).toBe(true);
});

test("an inline style= attribute wins over a presentation attribute", () => {
  const s = r({ fill: "#000", style: "fill:none;stroke-width:3" });
  expect(s.fill).toBe(false);
  expect(s.strokeWidth).toBe(3);
});

test("style= tolerates spacing and a trailing semicolon", () => {
  expect(r({ style: " fill : none ; " }).fill).toBe(false);
});

test("display:none is off and inherits", () => {
  expect(r({ display: "none" }).display).toBe(false);
  expect(resolveStyle(r({ display: "none" }), {}).display).toBe(false);
  expect(r({ style: "display:none" }).display).toBe(false);
});

test("stroke-width of zero disables the stroke", () => {
  expect(r({ stroke: "#000", "stroke-width": "0" }).stroke).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-style.test.js`
Expected: FAIL — cannot resolve `svg-style.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-style.js`:

```js
// Presentation attributes → a resolved style, inherited down the element tree.
//
// This op produces geometry, not paint, so `fill` and `stroke` collapse to
// BOOLEANS — "is there paint here" is the only question their values answer for
// us. Colour, opacity and gradients are read and discarded.
//
// The inline `style=` attribute IS honored (it wins over the matching
// presentation attribute, per CSS specificity). CSS `<style>` blocks and
// `class=` are NOT — those need a cascade, and the spec excludes them; svg-doc.js
// rejects them loudly rather than letting them silently change nothing.
//
// Pure leaf: DOM-free, node:-free.

export const ROOT_STYLE = Object.freeze({
  fill: true,             // SVG initial fill is black
  fillRule: "nonzero",
  stroke: false,          // SVG initial stroke is none
  strokeWidth: 1,
  linecap: "butt",
  linejoin: "miter",
  miterLimit: 4,
  display: true,
});

const LINECAPS = new Set(["butt", "round", "square"]);
const LINEJOINS = new Set(["miter", "round", "bevel"]);

// `style="fill:none; stroke-width:3"` → { fill: "none", "stroke-width": "3" }.
// No cascade, no selectors — a declaration list is not CSS, it is just a map.
function parseInlineStyle(raw) {
  const out = {};
  if (typeof raw !== "string") return out;
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const k = decl.slice(0, i).trim().toLowerCase();
    const v = decl.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

const hasPaint = (v) => typeof v === "string" && v.trim().toLowerCase() !== "none" && v.trim() !== "";

export function resolveStyle(parent, attrs) {
  const inline = parseInlineStyle(attrs.style);
  // Inline style wins; otherwise the presentation attribute; otherwise inherit.
  const get = (name) => (name in inline ? inline[name] : attrs[name]);

  const s = { ...parent };

  const fill = get("fill");
  if (fill != null) s.fill = hasPaint(fill);

  const stroke = get("stroke");
  if (stroke != null) s.stroke = hasPaint(stroke);

  const fillRule = get("fill-rule");
  if (fillRule != null) s.fillRule = fillRule.trim().toLowerCase() === "evenodd" ? "evenodd" : "nonzero";

  const sw = get("stroke-width");
  if (sw != null) {
    const v = parseFloat(sw);
    if (Number.isFinite(v) && v >= 0) s.strokeWidth = v;
  }

  const cap = get("stroke-linecap");
  if (cap != null) { const v = cap.trim().toLowerCase(); s.linecap = LINECAPS.has(v) ? v : "butt"; }

  const join = get("stroke-linejoin");
  if (join != null) { const v = join.trim().toLowerCase(); s.linejoin = LINEJOINS.has(v) ? v : "miter"; }

  const ml = get("stroke-miterlimit");
  if (ml != null) { const v = parseFloat(ml); if (Number.isFinite(v) && v >= 1) s.miterLimit = v; }

  const display = get("display");
  if (display != null && display.trim().toLowerCase() === "none") s.display = false;

  // A zero-width stroke paints nothing. Collapsing it here means every consumer
  // can ask one question (`style.stroke`) instead of two.
  if (s.strokeWidth <= 0) s.stroke = false;

  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-style.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-style.js test/svg-style.test.js
git commit -m "svg: presentation-attribute and inline-style resolution"
```

---

### Task 6: `svg-doc.js` — tree walk

**Files:**
- Create: `src/framework/geometry/svg-doc.js`
- Test: `test/svg-doc.test.js`

**Interfaces:**
- Consumes: `parseSvgXml` (Task 1), `shapeToContours` (Task 4), `parseTransform`/`composeMatrix`/`applyMatrixToContour`/`IDENTITY` (Task 3), `ROOT_STYLE`/`resolveStyle` (Task 5).
- Produces: `decodeSvgDocument(input: string|ArrayBuffer|Uint8Array) → SvgDocument`, where
  `SvgDocument = { elements: SvgElement[] }` and
  `SvgElement = { subpaths: { contour: Contour, closed: boolean }[], style: Style }`.
  Coordinates are in SVG user space, **y-down**. Throws `Error` starting `"svg: "` on an unsupported element or a `class=` attribute.

**One element, many subpaths — deliberately.** A `<path>`'s fill rule applies *across* its own subpaths (that is how the counter of an "O" becomes a hole), so subpaths must stay grouped by element. Strokes, by contrast, apply per subpath. Both consumers are served by this shape.

**`viewBox` is ignored.** Sizing normalizes on the tight geometric bbox (spec §2), so the root's `viewBox`/`width`/`height` only ever contributed a uniform scale that gets discarded a step later. The default `preserveAspectRatio` is uniform, so nothing is lost.

- [ ] **Step 1: Write the failing test**

Create `test/svg-doc.test.js`:

```js
import { expect, test } from "vitest";
import { decodeSvgDocument } from "../src/framework/geometry/svg-doc.js";

const doc = (s) => decodeSvgDocument(s);

test("collects a path element with its style", () => {
  const { elements } = doc('<svg><path d="M0,0 L10,0 L10,10 Z" fill="#f00"/></svg>');
  expect(elements).toHaveLength(1);
  expect(elements[0].subpaths).toHaveLength(1);
  expect(elements[0].style.fill).toBe(true);
});

test("a path's several subpaths stay grouped in one element", () => {
  const { elements } = doc('<svg><path d="M0,0 L9,0 L9,9 Z M2,2 L7,2 L7,7 Z" fill-rule="evenodd"/></svg>');
  expect(elements).toHaveLength(1);
  expect(elements[0].subpaths).toHaveLength(2);
  expect(elements[0].style.fillRule).toBe("evenodd");
});

test("style inherits through nested groups", () => {
  const { elements } = doc('<svg><g fill="none" stroke="#000" stroke-width="3"><g><path d="M0,0 L5,5"/></g></g></svg>');
  expect(elements[0].style.fill).toBe(false);
  expect(elements[0].style.stroke).toBe(true);
  expect(elements[0].style.strokeWidth).toBe(3);
});

test("transforms compose from the root down", () => {
  const { elements } = doc('<svg><g transform="translate(10 0)"><g transform="scale(2)"><path d="M1,0 L2,0"/></g></g></svg>');
  // scale first (1,0)->(2,0), then translate -> (12,0)
  expect(elements[0].subpaths[0].contour.start).toEqual([12, 0]);
});

test("a uniform ancestor transform keeps a circle's arcs symbolic", () => {
  const { elements } = doc('<svg><g transform="scale(3) rotate(20)"><circle r="2"/></g></svg>');
  expect(elements[0].subpaths[0].contour.segments.every((s) => s.via)).toBe(true);
});

test("a non-uniform ancestor transform degrades the circle to cubics", () => {
  const { elements } = doc('<svg><g transform="scale(3,1)"><circle r="2"/></g></svg>');
  const segs = elements[0].subpaths[0].contour.segments;
  expect(segs.every((s) => s.c1)).toBe(true);
});

test("display:none prunes an element and its whole subtree", () => {
  expect(doc('<svg><path d="M0,0 L1,1" display="none"/></svg>').elements).toHaveLength(0);
  expect(doc('<svg><g display="none"><path d="M0,0 L1,1"/></g></svg>').elements).toHaveLength(0);
});

test("title, desc and metadata are skipped silently", () => {
  const { elements } = doc('<svg><title>x</title><desc>y</desc><metadata>z</metadata><path d="M0,0 L1,1"/></svg>');
  expect(elements).toHaveLength(1);
});

test("every shape element type is decoded", () => {
  const { elements } = doc(
    '<svg><rect width="2" height="2"/><circle r="1"/><ellipse rx="2" ry="1"/>'
    + '<line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/><polygon points="0,0 1,0 1,1"/></svg>');
  expect(elements).toHaveLength(6);
});

test("open and closed subpaths are flagged correctly", () => {
  const { elements } = doc('<svg><polyline points="0,0 1,1"/><polygon points="0,0 1,0 1,1"/></svg>');
  expect(elements[0].subpaths[0].closed).toBe(false);
  expect(elements[1].subpaths[0].closed).toBe(true);
});

test("an element that yields no geometry is dropped, not kept empty", () => {
  expect(doc('<svg><rect width="0" height="5"/><path d="M0,0 L1,1"/></svg>').elements).toHaveLength(1);
});

for (const tag of ["use", "defs", "symbol", "style", "text", "image", "clipPath", "mask", "filter"]) {
  test(`<${tag}> is rejected by name`, () => {
    expect(() => doc(`<svg><${tag}></${tag}></svg>`)).toThrow(new RegExp(`svg: .*${tag}`, "i"));
  });
}

test("a class attribute is rejected — there is no cascade to resolve it", () => {
  expect(() => doc('<svg><path class="icon" d="M0,0 L1,1"/></svg>')).toThrow(/svg: .*class/i);
});

test("the root must be an <svg> element", () => {
  expect(() => doc('<html><path d="M0,0"/></html>')).toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg-doc.test.js`
Expected: FAIL — cannot resolve `svg-doc.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg-doc.js`:

```js
// The SVG tree walk: XML → a flat list of drawable elements, each carrying its
// subpaths (in accumulated user space, still y-DOWN) and its resolved style.
//
// One entry per ELEMENT, not per subpath, because a fill rule applies across an
// element's own subpaths — that is how the counter of an "O" becomes a hole.
// Strokes apply per subpath, and each subpath carries its own `closed` flag for
// that consumer.
//
// `viewBox` is deliberately ignored: sizing normalizes on the tight geometric
// bbox, so the root's viewBox/width/height only ever contributed a uniform
// scale that svg2d.js discards a step later.
//
// Unsupported elements THROW rather than being skipped. Every one of them
// removes geometry the author can see in their editor, and a silent skip
// produces a part that is quietly missing a shape with nothing to grep for.
//
// Pure leaf: DOM-free, node:-free.
import { parseSvgXml } from "./svg-xml.js";
import { shapeToContours } from "./svg-shapes.js";
import { IDENTITY, applyMatrixToContour, composeMatrix, parseTransform } from "./svg-transform.js";
import { ROOT_STYLE, resolveStyle } from "./svg-style.js";

const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const CONTAINERS = new Set(["svg", "g", "a", "switch"]);
const IGNORED = new Set(["title", "desc", "metadata", "script"]);
const REJECTED = new Map([
  ["use", "referenced content is not resolved"],
  ["defs", "referenced content is not resolved"],
  ["symbol", "referenced content is not resolved"],
  ["style", "CSS is not applied"],
  ["text", "use k.text2d for lettering"],
  ["image", "raster content has no geometry"],
  ["clippath", "clipping is not applied"],
  ["mask", "masking is not applied"],
  ["filter", "filters are not applied"],
  ["pattern", "paint servers are not applied"],
]);

// Preserve the author's spelling in the message — they will be searching their
// file for it, and `clipPath` is not spelled `clippath` there.
const ORIGINAL_SPELLING = { clippath: "clipPath" };

export function decodeSvgDocument(input) {
  const root = parseSvgXml(input);
  if (root.tag !== "svg") throw new Error(`svg: root element is <${root.tag}>, expected <svg>`);

  const elements = [];

  const visit = (node, parentMatrix, parentStyle) => {
    if ("class" in node.attrs) {
      throw new Error(`svg: <${node.tag}> uses class="${node.attrs.class}" — CSS classes are not supported; `
        + "inline the presentation attributes (or run the file through an SVG optimizer that does)");
    }
    if (REJECTED.has(node.tag)) {
      const shown = ORIGINAL_SPELLING[node.tag] ?? node.tag;
      throw new Error(`svg: <${shown}> is not supported — ${REJECTED.get(node.tag)}`);
    }
    if (IGNORED.has(node.tag)) return;

    const style = resolveStyle(parentStyle, node.attrs);
    if (!style.display) return;                       // prunes the whole subtree

    const matrix = composeMatrix(parentMatrix, parseTransform(node.attrs.transform));

    if (SHAPES.has(node.tag)) {
      const subpaths = shapeToContours(node.tag, node.attrs)
        .map(({ contour, closed }) => ({ contour: applyMatrixToContour(contour, matrix), closed }));
      if (subpaths.length) elements.push({ subpaths, style });
      return;                                          // shapes have no drawable children
    }

    if (!CONTAINERS.has(node.tag)) {
      throw new Error(`svg: <${node.tag}> is not a supported element`);
    }
    for (const child of node.children) visit(child, matrix, style);
  };

  visit(root, IDENTITY, ROOT_STYLE);
  return { elements };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg-doc.test.js`
Expected: PASS, 22 tests (the `for` loop contributes 9).

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg-doc.js test/svg-doc.test.js
git commit -m "svg: element-tree walk with transform and style accumulation"
```

---

### Task 7: `stroke-outline.js` — strokes become geometry

**Files:**
- Modify: `src/framework/geometry/contour-offset.js` (export `joinSegs` as `_joinSegs` — one line)
- Create: `src/framework/geometry/stroke-outline.js`
- Test: `test/stroke-outline.test.js`

**Interfaces:**
- Consumes: `_offsetSegment`, `_offsetContour`, `_joinSegs` from `./contour-offset.js`; `segTangent`, `SMOOTH_JOINT_DEG` from `./contour-ops.js`; `reverseContour`, `closeContourGap` from `./profile.js`; `resolveCurveFill` from `./curve-fill.js`.
- Produces: `outlineStroke(contour: Contour, closed: boolean, style: Style) → Region[]` (regions in the same coordinate space as the input). Throws `Error` starting `"svg: "` when the outline collapses.

**`stroke-miterlimit` is resolved but NOT applied.** `joinSegs` carries a fixed
`MITER_LIMIT = 2` (`contour-offset.js:89`) and takes no parameter for it;
threading one through would change a signature shared with the whole offset
engine for a nuance visible only on corners sharper than about 60 degrees. SVG's
default is 4, so affected corners bevel slightly earlier than a browser draws
them. `svg-style.js` keeps the value so a later change has somewhere to read it
from. Do not add a test asserting the SVG limit is honored — it is not.

**Why `_offsetContour` is reused for the closed case and not the open one.** A closed stroked contour is exactly an annulus: offset the ring one way, offset the *reversed* ring the same way, and nonzero winding does the rest. `_offsetContour` already does closed rings correctly, so the closed case is two calls and no new geometry code. The open case genuinely has no closed ring to hand it, so it gets a small purpose-built chain walker built from the same lower-level parts.

- [ ] **Step 1: Write the failing test**

Create `test/stroke-outline.test.js`:

```js
import { expect, test } from "vitest";
import { outlineStroke } from "../src/framework/geometry/stroke-outline.js";
import { ROOT_STYLE } from "../src/framework/geometry/svg-style.js";
import { pathProfile } from "../src/framework/geometry/polygon.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const style = (o) => ({ ...ROOT_STYLE, stroke: true, ...o });
const netArea = (regions) => regions.reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);

const openLine = pathProfile([0, 0]).lineTo([10, 0]).close();
const square = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).lineTo([0, 10]).lineTo([0, 0]).close();

test("round caps: a length-10 stroke of width 2 has area 20 + pi", () => {
  const regions = outlineStroke(openLine, false, style({ strokeWidth: 2, linecap: "round" }));
  expect(netArea(regions)).toBeCloseTo(20 + Math.PI, 1);
});

test("butt caps: the same stroke is a plain 10 x 2 rectangle", () => {
  const regions = outlineStroke(openLine, false, style({ strokeWidth: 2, linecap: "butt" }));
  expect(netArea(regions)).toBeCloseTo(20, 4);
});

test("square caps add a half-width block at each end", () => {
  const regions = outlineStroke(openLine, false, style({ strokeWidth: 2, linecap: "square" }));
  expect(netArea(regions)).toBeCloseTo(24, 4);
});

test("stroke width scales the outline linearly", () => {
  const a = netArea(outlineStroke(openLine, false, style({ strokeWidth: 1, linecap: "butt" })));
  const b = netArea(outlineStroke(openLine, false, style({ strokeWidth: 4, linecap: "butt" })));
  expect(b / a).toBeCloseTo(4, 6);
});

test("a closed square stroked width 2 with miter joins is a 144 - 64 annulus", () => {
  const regions = outlineStroke(square, true, style({ strokeWidth: 2, linejoin: "miter" }));
  expect(netArea(regions)).toBeCloseTo(80, 3);
  expect(regions).toHaveLength(1);
  expect(regions[0].holes).toHaveLength(1);
});

test("a closed square with round joins loses the mitre corners", () => {
  const regions = outlineStroke(square, true, style({ strokeWidth: 2, linejoin: "round" }));
  // outer corners rounded at r=1: 144 - 4*(1 - pi/4); inner unchanged at 64
  expect(netArea(regions)).toBeCloseTo(144 - (4 - Math.PI) - 64, 1);
});

test("an L-shaped open stroke is a single region", () => {
  const L = pathProfile([0, 0]).lineTo([10, 0]).lineTo([10, 10]).close();
  const regions = outlineStroke(L, false, style({ strokeWidth: 2, linecap: "butt", linejoin: "miter" }));
  expect(regions).toHaveLength(1);
  // two 10x2 arms sharing a 2x2 corner square
  expect(netArea(regions)).toBeCloseTo(20 + 20 - 4, 2);
});

test("an open arc stroke keeps positive area and one region", () => {
  const arc = pathProfile([2, 0]).arcTo([-2, 0], [0, 2]).close();
  const regions = outlineStroke(arc, false, style({ strokeWidth: 1, linecap: "butt" }));
  expect(regions).toHaveLength(1);
  // annular half-ring: pi/2*(2.5^2 - 1.5^2) = 2*pi
  expect(netArea(regions)).toBeCloseTo(2 * Math.PI, 1);
});

test("a self-crossing open stroke normalizes to a simple region, not double-counted area", () => {
  const cross = pathProfile([0, 0]).lineTo([10, 10]).lineTo([10, 0]).lineTo([0, 10]).close();
  const regions = outlineStroke(cross, false, style({ strokeWidth: 1, linecap: "butt" }));
  expect(regions.length).toBeGreaterThanOrEqual(1);
  // four arms of length ~14.14 at width 1 is ~56.6 before the overlaps at the
  // crossing are removed; the union must be strictly less.
  expect(netArea(regions)).toBeLessThan(4 * Math.hypot(10, 10) * 1);
  expect(netArea(regions)).toBeGreaterThan(0);
});

test("a zero-width stroke throws rather than returning nothing", () => {
  expect(() => outlineStroke(openLine, false, style({ strokeWidth: 0 })))
    .toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stroke-outline.test.js`
Expected: FAIL — cannot resolve `stroke-outline.js`.

- [ ] **Step 3a: Export `joinSegs` from `contour-offset.js`**

In `src/framework/geometry/contour-offset.js`, find:

```js
function joinSegs(corner, aEnd, bStart, inTan, outTan, delta, corners) {
```

and add an aliasing export immediately after that function's closing brace (just before the `// Offset one explicitly-closed ring.` comment):

```js
// Exposed for stroke-outline.js, which walks OPEN chains and so cannot use
// _offsetContour's ring loop, but needs exactly this join vocabulary
// (round/chamfer/sharp + miter limit) at its interior vertices.
export const _joinSegs = joinSegs;
```

- [ ] **Step 3b: Write `stroke-outline.js`**

Create `src/framework/geometry/stroke-outline.js`:

```js
// Stroke → filled geometry. The half of paperjs-offset that contour-offset.js
// did not port: `offsetStroke`.
//
// Both cases reduce to "offset the path, offset its reverse, let nonzero
// winding assemble the result":
//
//   CLOSED  outer = offset(contour, +w/2), inner = offset(reverse(contour), +w/2).
//           Two rings of opposite handedness → an annulus. _offsetContour
//           already does closed rings correctly, so this case adds no geometry
//           code at all.
//   OPEN    the same two offsets as open CHAINS, joined end to end by caps into
//           one closed ring.
//
// Per SVG semantics a stroke is applied in the element's LOCAL user space and
// the result is then transformed, so callers outline before applying a
// non-uniform ancestor matrix. That is both simpler and more correct than
// outlining afterwards, and it sidesteps elliptical stroke profiles entirely.
//
// Pure leaf: DOM-free, node:-free.
import { _joinSegs, _offsetContour, _offsetSegment } from "./contour-offset.js";
import { SMOOTH_JOINT_DEG, segTangent } from "./contour-ops.js";
import { closeContourGap, reverseContour } from "./profile.js";
import { resolveCurveFill } from "./curve-fill.js";

const JOIN_EPS = 1e-6;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scl = (v, s) => [v[0] * s, v[1] * s];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const rightOf = ([x, y]) => [y, -x];

// SVG's linejoin vocabulary is contour-offset.js's `corners` vocabulary under
// different names. miter-clip and arcs are not SVG 1.1 and fall back to miter.
const CORNERS = { miter: "sharp", round: "round", bevel: "chamfer" };

// The start point of each segment, and the segments themselves with
// zero-length lines dropped (they carry no direction, so they have no offset).
function chainParts(contour) {
  const segs = [], froms = [];
  let p = contour.start;
  for (const s of contour.segments) {
    if (s.c1 || s.via || dist(p, s.to) > 1e-9) { segs.push(s); froms.push(p); }
    p = s.to;
  }
  return { segs, froms, end: p };
}

// Offset an OPEN chain by `delta`, joining at interior vertices only. Mirrors
// _offsetContour's join decision exactly (gap side gets a join, overlap side
// gets a bevel the winding rule then cancels) minus the wrap-around and the
// whole-ring collapse predicate, neither of which means anything for a chain.
function offsetOpenChain(contour, delta, corners) {
  const { segs, froms } = chainParts(contour);
  if (segs.length === 0) return null;
  const pieces = segs.map((s, i) => _offsetSegment(froms[i], s, delta));
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) {
      const aEnd = pieces[i - 1].segments.at(-1).to, bStart = pieces[i].start;
      const inTan = segTangent(froms[i - 1], segs[i - 1], false);
      const outTan = segTangent(froms[i], segs[i], true);
      const turn = cross(inTan, outTan);
      const turnDeg = (Math.atan2(Math.abs(turn), Math.max(-1, Math.min(1, dot(inTan, outTan)))) * 180) / Math.PI;
      if (dist(aEnd, bStart) > JOIN_EPS && turnDeg >= SMOOTH_JOINT_DEG) {
        // turn === 0 with a large turnDeg is an exact 180° reversal — the same
        // ambiguity _offsetContour calls out; treat it as gap side so a round
        // join is honored rather than flat-capped.
        if (turn * delta > 0 || turn === 0) out.push(..._joinSegs(froms[i], aEnd, bStart, inTan, outTan, delta, corners));
        else out.push({ to: [bStart[0], bStart[1]] });     // overlap side: bevel; nonzero cancels the loop
      }
    }
    out.push(...pieces[i].segments);
  }
  return { start: pieces[0].start, segments: out };
}

// Bridge `from` → `to` around the path endpoint `tip`, where `tangent` points
// OUT of the path at that end and `hw` is the half stroke width.
function capSegments(tip, tangent, hw, linecap, to) {
  if (linecap === "round") return [{ via: add(tip, scl(tangent, hw)), to }];
  if (linecap === "square") {
    const ext = scl(tangent, hw);
    // `from` is tip + hw*rightOf(tangent); extend both corners outward.
    const n = scl(rightOf(tangent), hw);
    return [{ to: add(add(tip, n), ext) }, { to: add(sub(tip, n), ext) }, { to }];
  }
  return [{ to }];                                          // butt
}

export function outlineStroke(contour, closed, style) {
  const hw = style.strokeWidth / 2;
  if (!(hw > 0)) throw new Error("svg: cannot outline a stroke of zero width");
  const corners = CORNERS[style.linejoin] ?? "sharp";

  if (closed) {
    const ring = closeContourGap(contour);
    const a = _offsetContour(ring, hw, corners).contour;
    const b = _offsetContour(closeContourGap(reverseContour(ring)), hw, corners).contour;
    const rings = [a, b].filter(Boolean);
    if (rings.length < 2) throw new Error("svg: stroke outline collapsed — stroke-width is too large for this shape");
    return resolveCurveFill(rings, { fillRule: "nonzero" });
  }

  const fwd = offsetOpenChain(contour, hw, corners);
  const rev = offsetOpenChain(reverseContour(contour), hw, corners);
  if (!fwd || !rev) throw new Error("svg: stroke path has no length to outline");

  const { segs, froms, end } = chainParts(contour);
  const endTan = segTangent(froms.at(-1), segs.at(-1), false);        // points out of the far end
  const startTanIn = segTangent(contour.start, segs[0], true);
  const startTanOut = [-startTanIn[0], -startTanIn[1]];               // points out of the near end

  const segments = [
    ...fwd.segments,
    ...capSegments(end, endTan, hw, style.linecap, rev.start),
    ...rev.segments,
    ...capSegments(contour.start, startTanOut, hw, style.linecap, fwd.start),
  ];

  // A stroke path that crosses itself makes this ring self-intersecting.
  // resolveCurveFill under nonzero is exactly the normalizer for that — the
  // same one svg2d.js uses for fills, not a second mechanism.
  return resolveCurveFill([{ start: fwd.start, segments }], { fillRule: "nonzero" });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/stroke-outline.test.js`
Expected: PASS, 10 tests. The `20 + pi` case is the load-bearing one — it is the stadium figure `joinSegs`' own comment pins, and it proves the round caps survived.

Then confirm nothing regressed in the offset engine: `npx vitest run test/contour-offset.test.js`

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/stroke-outline.js src/framework/geometry/contour-offset.js test/stroke-outline.test.js
git commit -m "svg: stroke outlining on the existing offset engine"
```

---

### Task 8: `svg2d.js` — assembly, sizing, alignment

**Files:**
- Create: `src/framework/geometry/svg2d.js`
- Test: `test/svg2d.test.js`

**Interfaces:**
- Consumes: `decodeSvgDocument` (Task 6), `outlineStroke` (Task 7), `applyMatrixToContour` (Task 3), `resolveCurveFill`, `tessellateContour`.
- Produces: `svgToRegions(doc: SvgDocument, opts) → Region[]` in **millimetres, y-up**. `opts` is `{ width?, height?, fit?, align?, valign?, strokes?, fillRule? }`. Throws `Error` starting `"svg: "` for a missing size, a document with no geometry, or a degenerate extent.

**Pipeline order is load-bearing** (spec §2): flip to y-up → outline strokes in user units → assemble regions → measure the tight bbox of the *final* regions → scale and align. Measuring before outlining would leave stroke thickness fixed while the artwork scaled.

- [ ] **Step 1: Write the failing test**

Create `test/svg2d.test.js`:

```js
import { expect, test } from "vitest";
import { svgToRegions } from "../src/framework/geometry/svg2d.js";
import { decodeSvgDocument } from "../src/framework/geometry/svg-doc.js";
import { tessellateContour } from "../src/framework/geometry/profile.js";
import { ringArea } from "../src/framework/geometry/shape2d-regions.js";

const regions = (svg, opts) => svgToRegions(decodeSvgDocument(svg), opts);
const netArea = (rs) => rs.reduce((a, r) =>
  a + Math.abs(ringArea(tessellateContour(r.outer, 256)))
    - r.holes.reduce((h, c) => h + Math.abs(ringArea(tessellateContour(c, 256))), 0), 0);
const bbox = (rs) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rs) for (const [x, y] of tessellateContour(r.outer, 256)) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
};

const SQUARE = '<svg><rect width="20" height="10"/></svg>';

test("width sizes the tight bbox and preserves aspect", () => {
  const b = bbox(regions(SQUARE, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect(b.h).toBeCloseTo(20, 4);
});

test("height sizes the other axis", () => {
  const b = bbox(regions(SQUARE, { height: 5 }));
  expect(b.h).toBeCloseTo(5, 4);
  expect(b.w).toBeCloseTo(10, 4);
});

test("fit sizes the longer edge", () => {
  const b = bbox(regions(SQUARE, { fit: 30 }));
  expect(Math.max(b.w, b.h)).toBeCloseTo(30, 4);
});

test("omitting all three size options throws and names them", () => {
  expect(() => regions(SQUARE, {})).toThrow(/width.*height.*fit/s);
});

test("the tight bbox ignores viewBox padding", () => {
  // the same 20x10 rect in a hugely padded viewBox must come out the same size
  const padded = '<svg viewBox="0 0 1000 1000"><rect x="400" y="700" width="20" height="10"/></svg>';
  const b = bbox(regions(padded, { width: 40 }));
  expect(b.w).toBeCloseTo(40, 4);
  expect(b.h).toBeCloseTo(20, 4);
});

test("default alignment centres the artwork on the origin", () => {
  const b = bbox(regions(SQUARE, { width: 20 }));
  expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6);
  expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6);
});

test("align left puts the left edge on the origin; valign bottom the bottom edge", () => {
  const b = bbox(regions(SQUARE, { width: 20, align: "left", valign: "bottom" }));
  expect(b.minX).toBeCloseTo(0, 6);
  expect(b.minY).toBeCloseTo(0, 6);
});

test("align right and valign top put the far edges on the origin", () => {
  const b = bbox(regions(SQUARE, { width: 20, align: "right", valign: "top" }));
  expect(b.maxX).toBeCloseTo(0, 6);
  expect(b.maxY).toBeCloseTo(0, 6);
});

test("y is flipped from SVG's y-down to model y-up", () => {
  // a tall thin bar at the TOP of the SVG must end up at the TOP in model space
  const svg = '<svg><rect x="0" y="0" width="10" height="2"/><rect x="0" y="8" width="2" height="2"/></svg>';
  const rs = regions(svg, { width: 10, align: "left", valign: "bottom" });
  const b = bbox(rs);
  // the WIDE bar was at SVG y=0 (top); after the flip it must be the high one
  const wideIsHigh = rs.some((r) => {
    const pts = tessellateContour(r.outer, 64);
    const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const yTop = Math.max(...pts.map((p) => p[1]));
    return w > 5 && yTop > b.maxY - 1e-6;
  });
  expect(wideIsHigh).toBe(true);
});

test("evenodd on one path makes a hole; nonzero on the same path does not", () => {
  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  const eo = regions(`<svg><path fill-rule="evenodd" d="${d}"/></svg>`, { width: 30 });
  const nz = regions(`<svg><path fill-rule="nonzero" d="${d}"/></svg>`, { width: 30 });
  expect(netArea(eo)).toBeCloseTo(900 - 100, 2);
  expect(netArea(nz)).toBeCloseTo(900, 2);
});

test("an explicit opts.fillRule overrides the document's own", () => {
  const d = "M0,0 L30,0 L30,30 L0,30 Z M10,10 L20,10 L20,20 L10,20 Z";
  const rs = regions(`<svg><path fill-rule="nonzero" d="${d}"/></svg>`, { width: 30, fillRule: "evenodd" });
  expect(netArea(rs)).toBeCloseTo(800, 2);
});

test("two overlapping filled shapes union rather than double-count", () => {
  const svg = '<svg><rect width="10" height="10"/><rect x="5" width="10" height="10"/></svg>';
  const rs = regions(svg, { width: 15 });   // 15 wide user units -> scale 1
  expect(netArea(rs)).toBeCloseTo(150, 2);
});

test("fill=none with a stroke produces the stroke outline only", () => {
  const svg = '<svg><path fill="none" stroke="#000" stroke-width="2" stroke-linecap="butt" d="M0,0 L10,0"/></svg>';
  const rs = regions(svg, { width: 10 });   // bbox is 10 x 2 -> scale 1
  expect(netArea(rs)).toBeCloseTo(20, 2);
});

test("stroke thickness scales with the artwork", () => {
  const svg = '<svg><path fill="none" stroke="#000" stroke-width="2" stroke-linecap="butt" d="M0,0 L10,0"/></svg>';
  const small = bbox(regions(svg, { width: 10 }));
  const big = bbox(regions(svg, { width: 20 }));
  expect(big.h / small.h).toBeCloseTo(2, 6);
});

test("strokes:'ignore' drops stroke geometry", () => {
  const svg = '<svg><rect width="10" height="10" stroke="#000" stroke-width="4"/></svg>';
  const withStroke = bbox(regions(svg, { width: 14 }));
  const without = regions(svg, { width: 10, strokes: "ignore" });
  expect(netArea(without)).toBeCloseTo(100, 2);
  expect(withStroke.w).toBeCloseTo(14, 4);
});

test("a document with no drawable geometry throws", () => {
  expect(() => regions('<svg><path fill="none" d="M0,0 L10,0"/></svg>', { width: 10 }))
    .toThrow(/svg: /);
});

test("a zero-extent artwork throws rather than dividing by zero", () => {
  expect(() => regions('<svg><rect width="10" height="10"/></svg>', { height: 0 }))
    .toThrow(/svg: /);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svg2d.test.js`
Expected: FAIL — cannot resolve `svg2d.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/framework/geometry/svg2d.js`:

```js
// SVG document → curve regions in millimetres. The sibling of text2d.js: same
// job (a foreign description of 2-D shapes → {outer,holes} region specs the
// kernel lifts with k.shape2d), same "never flatten" rule, same alignment
// vocabulary.
//
// PIPELINE ORDER IS LOAD-BEARING (spec §2):
//   1. flip y (SVG is y-down, the model frame is y-up)
//   2. outline strokes, still in user units
//   3. assemble regions — per element with its own fill rule, then one union
//   4. measure the tight bbox of the FINAL regions
//   5. scale uniformly and align
//
// Steps 2 and 4 are the ones that must not swap. Measuring the fill geometry
// first and outlining afterwards leaves stroke thickness fixed while the
// artwork scales, so the same icon at 28 mm and at 60 mm gets identical stroke
// weight — visibly wrong, and only ever noticed when someone changes `width`.
//
// Pure leaf: DOM-free, node:-free, no kernel.
import { applyMatrixToContour } from "./svg-transform.js";
import { outlineStroke } from "./stroke-outline.js";
import { resolveCurveFill } from "./curve-fill.js";
import { tessellateContour } from "./profile.js";

const FLIP_Y = [1, 0, 0, -1, 0, 0];    // a reflection: uniform, so arcs survive
const BBOX_SEGS = 64;
const EXTENT_EPS = 1e-9;

function bboxOfRegions(regions) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of regions) {
    for (const [x, y] of tessellateContour(r.outer, BBOX_SEGS)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function scaleFor({ width, height, fit }, w, h) {
  const need = (extent, label) => {
    if (!(extent > EXTENT_EPS)) throw new Error(`svg: artwork has no ${label} to size against`);
  };
  if (width != null) {
    if (!(width > 0)) throw new Error("svg: width must be a positive number of millimetres");
    need(w, "width"); return width / w;
  }
  if (height != null) {
    if (!(height > 0)) throw new Error("svg: height must be a positive number of millimetres");
    need(h, "height"); return height / h;
  }
  if (fit != null) {
    if (!(fit > 0)) throw new Error("svg: fit must be a positive number of millimetres");
    const longer = Math.max(w, h);
    need(longer, "extent"); return fit / longer;
  }
  // No honest default exists: SVG user units have no physical meaning (the same
  // icon ships as viewBox="0 0 24 24" or "0 0 512 512"), unlike a font's cap
  // height, which is why k.text2d can default `size` and this cannot.
  throw new Error('svg2d: a size is required — pass one of { width }, { height }, or { fit } in millimetres');
}

export function svgToRegions(doc, opts = {}) {
  const { align = "center", valign = "middle", strokes = "outline", fillRule } = opts;

  // 1 + 2 + 3a — flip, outline, resolve each element under its own fill rule.
  const resolved = [];
  for (const { subpaths, style } of doc.elements) {
    const flipped = subpaths.map(({ contour, closed }) => ({
      contour: applyMatrixToContour(contour, FLIP_Y),
      closed,
    }));

    if (style.fill) {
      // Per ELEMENT, not per subpath: a fill rule applies across an element's
      // own subpaths, which is what makes the counter of an "O" a hole.
      resolved.push(...resolveCurveFill(flipped.map((s) => s.contour),
        { fillRule: fillRule ?? style.fillRule }));
    }
    if (style.stroke && strokes !== "ignore") {
      // Per SUBPATH: each is stroked on its own, with its own open/closed sense.
      for (const { contour, closed } of flipped) {
        resolved.push(...outlineStroke(contour, closed, style));
      }
    }
  }

  if (resolved.length === 0) {
    throw new Error("svg: no drawable geometry — every element is fill=\"none\" with no stroke, "
      + "display=\"none\", or empty");
  }

  // 3b — one union across every element. The regions already carry the storage
  // winding invariant (outer CCW, holes CW), so nonzero over the flattened
  // contour list IS the union, holes included.
  const union = resolveCurveFill(resolved.flatMap((r) => [r.outer, ...r.holes]), { fillRule: "nonzero" });
  if (union.length === 0) throw new Error("svg: geometry cancelled to nothing under the fill rule");

  // 4 + 5 — measure the final regions, then place them.
  const { minX, minY, maxX, maxY } = bboxOfRegions(union);
  const w = maxX - minX, h = maxY - minY;
  const s = scaleFor(opts, w, h);

  const dx = align === "left" ? -minX * s : align === "right" ? -maxX * s : -((minX + maxX) / 2) * s;
  const dy = valign === "bottom" ? -minY * s : valign === "top" ? -maxY * s : -((minY + maxY) / 2) * s;
  const place = [s, 0, 0, s, dx, dy];      // uniform: arcs stay arcs

  return union.map((r) => ({
    outer: applyMatrixToContour(r.outer, place),
    holes: r.holes.map((c) => applyMatrixToContour(c, place)),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/svg2d.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/framework/geometry/svg2d.js test/svg2d.test.js
git commit -m "svg: region assembly, tight-bbox sizing, and alignment"
```

---

### Task 9: Wiring — `svgs.js`, `k.svg2d`, and every boot path

**Files:**
- Create: `src/framework/svgs.js`
- Modify: `src/framework/geometry/kernel-front.js`
- Modify: `src/framework/geometry/kernel.js` (op-name list, ~line 24)
- Modify: `src/framework/jobs.js` (after the `ensureImports` call, ~line 228)
- Modify: `src/testing/manifold.js`, `src/testing/occt.js` (Node boot)
- Modify: `bin/cli.js` (`bootKernel`, ~line 104)
- Modify: `docs/KERNEL-CONTRACT.md`
- Test: `test/svgs.test.js`

**Interfaces:**
- Consumes: `makeAssetResolver`/`resolveDecl` from `./asset-resolve.js`, `decodeSvgDocument` (Task 6), `svgToRegions` (Task 8).
- Produces:
  - `resolveSvgs(svgsDecl) → Promise<Map<string, SvgDocument>>`
  - `ensureSvgs(kernel, svgsDecl) → Promise<void>` — registers on `kernel._svgs`, pruning names the declaration no longer supplies.
  - `k.svg2d(name, opts) → Shape2D`

**Why the Node boot paths matter.** `bin/cli.js` boots its own kernel through `src/testing/manifold.js` / `occt.js` — it does not go through `jobs.js`. Wiring only `jobs.js` gives a part that builds in the browser and dies under `partforge measure` with `svg2d: unknown svg`, which is exactly the failure `bin/cli.js:96` records for fonts. All three paths get wired here.

- [ ] **Step 1: Write the failing test**

Create `test/svgs.test.js`:

```js
import { expect, test } from "vitest";
import { resolveSvgs, ensureSvgs } from "../src/framework/svgs.js";

const SQUARE = '<svg><rect width="10" height="10"/></svg>';
const CIRCLE = '<svg><circle r="5"/></svg>';
const bytes = (s) => new TextEncoder().encode(s);

test("resolves inline bytes to a decoded document", async () => {
  const map = await resolveSvgs({ box: bytes(SQUARE) });
  expect(map.get("box").elements).toHaveLength(1);
});

test("resolves a thunk returning bytes", async () => {
  const map = await resolveSvgs({ box: () => bytes(SQUARE) });
  expect(map.get("box").elements).toHaveLength(1);
});

test("memoizes by source identity — one decode per source", async () => {
  let calls = 0;
  const src = () => { calls++; return bytes(SQUARE); };
  await resolveSvgs({ a: src });
  await resolveSvgs({ b: src });
  expect(calls).toBe(1);
});

test("an undecodable source rejects with a message naming the failure", async () => {
  await expect(resolveSvgs({ bad: bytes("<svg><path") })).rejects.toThrow(/svg: /);
});

test("a source that is not bytes, a URL, or a thunk rejects", async () => {
  await expect(resolveSvgs({ bad: 42 })).rejects.toThrow(/must be bytes, a URL, or a thunk/);
});

test("ensureSvgs registers on the kernel and prunes stale names", async () => {
  const kernel = { _svgs: new Map() };
  await ensureSvgs(kernel, { a: bytes(SQUARE), b: bytes(CIRCLE) });
  expect([...kernel._svgs.keys()].sort()).toEqual(["a", "b"]);
  await ensureSvgs(kernel, { a: bytes(SQUARE) });
  expect([...kernel._svgs.keys()]).toEqual(["a"]);
});

test("ensureSvgs is a no-op on a kernel with no _svgs map", async () => {
  await expect(ensureSvgs({}, { a: bytes(SQUARE) })).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/svgs.test.js`
Expected: FAIL — cannot resolve `svgs.js`.

- [ ] **Step 3a: Create `src/framework/svgs.js`**

```js
// Resolve a part's declared `svgs` ({ name: source }) to decoded SVG documents,
// before the synchronous build — the vector-art sibling of fonts.js and
// imports.js: same source grammar and identity-memoization rule (an svg source
// is content-stable for a session), built on the shared resolution core in
// asset-resolve.js. DOM-free and node:-free.
//
// Unlike imports.js there is no content digest here, and that is deliberate:
// k.svg2d lowers to k.shape2d(regions), and the Shape2D hash keys on the actual
// coordinates — different artwork gives different coordinates gives a different
// cache entry, automatically. Imports need a digest because a Solid master is
// registered on the kernel BY NAME and is opaque to that hash; a decoded SVG is
// not.
import { makeAssetResolver, resolveDecl } from "./asset-resolve.js";
import { decodeSvgDocument } from "./geometry/svg-doc.js";

const cache = new Map();   // source → Promise<SvgDocument>
const resolveOne = makeAssetResolver(
  cache,
  (bytes) => decodeSvgDocument(bytes),
  "resolveSvgs: an svg source must be bytes, a URL, or a thunk returning one",
);

export async function resolveSvgs(svgsDecl) {
  return resolveDecl(svgsDecl, resolveOne);
}

// Register a part's svgs on a booted kernel. Called in the async phase before
// every job's synchronous build — worker (jobs.js) and Node boots
// (src/testing/) alike.
export async function ensureSvgs(kernel, svgsDecl) {
  if (!kernel?._svgs) return;
  const declared = svgsDecl ?? {};
  for (const [name, doc] of await resolveSvgs(declared)) kernel._svgs.set(name, doc);
  // Drop every name this declaration does not supply. `_svgs` is the kernel's
  // and the kernel outlives the job (worker-rebind, many parts), so without
  // this a name from a previous part stays resolvable — the same stale-
  // registration bug jobs.js's font prune exists to prevent.
  for (const name of [...kernel._svgs.keys()]) {
    if (!Object.hasOwn(declared, name)) kernel._svgs.delete(name);
  }
}
```

- [ ] **Step 3b: Add `k.svg2d` in `kernel-front.js`**

Add the import at the top, next to the existing `textGlyphs` import:

```js
import { svgToRegions } from "./svg2d.js";
```

Then, immediately after the `k.text2d = (string, opts = {}) => { ... };` block, add:

```js
  // 2-D vector art as a Shape2D. Backend-agnostic for the same reason text2d
  // is: it lowers to k.shape2d + union, so both backends get the identical
  // curve regions. Documents come from k._svgs (framework-preloaded by name).
  k._svgs ??= new Map();
  k.svg2d = (name, opts = {}) => {
    if (typeof name !== "string" || !name)
      throw new Error("svg2d: first argument must be the name of an entry in the part's `svgs` field");
    const doc = k._svgs.get(name);
    if (!doc) throw new Error(`svg2d: unknown svg "${name}" — declare it in the part's \`svgs\` field`);
    const regions = svgToRegions(doc, opts);
    return regions.map((r) => k.shape2d(r)).reduce((a, b) => a.union(b));
  };
```

- [ ] **Step 3c: Add the op name in `kernel.js`**

In the op-name list at `src/framework/geometry/kernel.js:24`, add `"svg2d"` immediately after `"text2d"`:

```js
  "loft", "sweep", "helixSweptTube", "screwSweep", "union", "shape2d", "text2d", "svg2d", "hull", "hullChain", "toSTEP",
```

- [ ] **Step 3d: Register in `jobs.js`**

Add the import beside the imports one:

```js
import { ensureSvgs } from "./svgs.js";
```

Then, immediately after the existing `if (part.imports) await ensureImports(...)` line (~228):

```js
    // Vector art, the third asset family after fonts and imports. Same
    // pre-build timing; ensureSvgs owns the prune, so this stays one line.
    if (part.svgs) await ensureSvgs(kernel, part.svgs);
```

- [ ] **Step 3e: Wire the Node boots**

In `src/testing/manifold.js`, add the import and extend the signature:

```js
import { ensureSvgs } from "../framework/svgs.js";
```

Change the signature line to include `svgs`:

```js
export async function bootManifoldKernel({ quality = "preview", fonts, imports, importMeshes, svgs } = {}) {
```

and add, immediately before `return kernel;`:

```js
  if (svgs) await ensureSvgs(kernel, nodeAssetSources(svgs));
```

Make the identical three changes in `src/testing/occt.js` (import, signature, and the `ensureSvgs` line before its `return kernel;`).

- [ ] **Step 3f: Pass `svgs` from the CLI**

In `bin/cli.js`, in `bootKernel` (~line 104), change:

```js
  const opts = { fonts: fontsFor(part, p), imports: part.imports };
```

to:

```js
  const opts = { fonts: fontsFor(part, p), imports: part.imports, svgs: part.svgs };
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/svgs.test.js test/worker-layering.test.js test/kernel-contract.test.js
```

Expected: `svgs.test.js` PASS (7 tests). `worker-layering` PASS — this is the DOM-free assertion for all eight new files at once, now that `jobs.js` reaches them.

`kernel-contract.test.js` will FAIL until `docs/KERNEL-CONTRACT.md` documents the new op — that test holds the doc's op coverage to the code. Read the failure, then add a `svg2d` row to the contract's op table in the same shape as the neighbouring `text2d` row, recording: **conformance — both backends** (it lowers to `shape2d`), **semantics — identical across backends by construction** (curve-native regions; no sampling), and bump the contract's version header if the test asks for it. Re-run until green.

- [ ] **Step 5: Commit**

```bash
git add src/framework/svgs.js src/framework/geometry/kernel-front.js src/framework/geometry/kernel.js \
        src/framework/jobs.js src/testing/manifold.js src/testing/occt.js bin/cli.js \
        docs/KERNEL-CONTRACT.md test/svgs.test.js
git commit -m "svg: k.svg2d, the svgs declaration, and every kernel boot path"
```

---

### Task 10: Lint rules

**Files:**
- Create: `src/framework/lint/rules-svg.js`
- Modify: `src/framework/lint/index.js:11-22`
- Test: `test/lint-svg.test.js`

**Interfaces:**
- Consumes: `err` from `./finding.js`; the lint context's `part` and `probe()` (whose `.calls` entries are `{ scope, op, args }` with `args` as raw **source text**, exactly as `rules-imports.js` uses them).
- Produces: `SVG_RULES` — an array of two rule objects.

`partforge/lint` has zero runtime dependencies and never imports geometry. Both rules read only the part module's source and its `svgs` field.

- [ ] **Step 1: Write the failing test**

Create `test/lint-svg.test.js`:

```js
// SVG lint rules — static, geometry-free checks that move two build-time
// throws earlier: a call naming an svg the part never declared, and a call
// with no size (which k.svg2d refuses, since SVG user units have no physical
// meaning to default from).
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const ids = (findings) => findings.map((f) => f.rule);
const find = (r, rule) => [...r.errors, ...r.warnings].find((f) => f.rule === rule);

const partWith = (build, extra = {}) => ({
  meta: { title: "T" },
  defaults: {},
  parts: { body: { views: ["main"], build } },
  views: { main: { label: "Main" } },
  ...extra,
});

// --- svg-unknown-name -------------------------------------------------------

test("a k.svg2d call naming an undeclared svg is an error", () => {
  const part = partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") } });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("svg-unknown-name");
  expect(find(r, "svg-unknown-name").message).toContain("logo");
  expect(find(r, "svg-unknown-name").message).toContain("badge");
});

test("a part with no svgs field at all still reports the unknown name", () => {
  const part = partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1));
  expect(ids(lintPart(part).errors)).toContain("svg-unknown-name");
});

test("a declared name is clean", () => {
  const part = partWith((k) => k.svg2d("badge", { width: 10 }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-unknown-name");
});

test("a non-literal name argument is skipped rather than guessed at", () => {
  const part = partWith((k, p) => k.svg2d(p.which, { width: 10 }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") }, defaults: { which: "badge" } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-unknown-name");
});

test("the same unknown name is reported once, not per call", () => {
  const part = partWith((k) => k.svg2d("logo", { width: 10 }).extrude(1)
    .union(k.svg2d("logo", { width: 5 }).extrude(1)));
  expect(ids(lintPart(part).errors).filter((i) => i === "svg-unknown-name")).toHaveLength(1);
});

// --- svg-size-missing -------------------------------------------------------

test("a k.svg2d call with no options object is an error", () => {
  const part = partWith((k) => k.svg2d("badge").extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") } });
  const r = lintPart(part);
  expect(ids(r.errors)).toContain("svg-size-missing");
  expect(find(r, "svg-size-missing").message).toMatch(/width|height|fit/);
});

test("an options literal with none of width/height/fit is an error", () => {
  const part = partWith((k) => k.svg2d("badge", { align: "left" }).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") } });
  expect(ids(lintPart(part).errors)).toContain("svg-size-missing");
});

test("each of width, height and fit clears the rule", () => {
  for (const opt of ['{ width: 10 }', '{ height: 10 }', '{ fit: 10 }']) {
    const build = new Function("k", `return k.svg2d("badge", ${opt}).extrude(1)`);
    const part = partWith(build, { svgs: { badge: new URL("file:///badge.svg") } });
    expect(ids(lintPart(part).errors)).not.toContain("svg-size-missing");
  }
});

test("a non-literal options argument is skipped", () => {
  const part = partWith((k, p) => k.svg2d("badge", p.opts).extrude(1),
    { svgs: { badge: new URL("file:///badge.svg") }, defaults: { opts: { width: 10 } } });
  expect(ids(lintPart(part).errors)).not.toContain("svg-size-missing");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/lint-svg.test.js`
Expected: FAIL — no `svg-unknown-name` finding is produced.

- [ ] **Step 3a: Create `src/framework/lint/rules-svg.js`**

```js
// Group 10 — vector-art call well-formedness. Both conditions throw at build
// time anyway; these rules move them ahead of the kernel boot, which is where
// an authoring agent actually wants them.
//
// Both are deliberately conservative in the same way rules-imports.js is: only
// LITERAL arguments are judged. A name computed from a param, or an options
// object passed by reference, carries no statically-visible answer, and
// guessing would produce false errors on perfectly good parts. Those cases
// still fail correctly at build time — this exists to catch the common case
// early, not to replace that runtime authority.
import { err } from "./finding.js";

const declaredSvgs = (part) => Object.keys(part?.svgs ?? {});

// The probe hands us raw source text per argument, so a name is only knowable
// when it is a string literal — which JSON.parse recognizes and nothing else
// does (rules-imports.js's import-unknown-name reads its name the same way).
const literalName = (src) => {
  try { const v = JSON.parse(src); return typeof v === "string" ? v : null; } catch { return null; }
};

const svgCalls = (probe) => probe().calls.filter((c) => c.scope === "kernel" && c.op === "svg2d");

export const SVG_RULES = [
  {
    id: "svg-unknown-name",
    run: ({ part, probe }) => {
      const known = new Set(declaredSvgs(part));
      const seen = new Set();
      const out = [];
      for (const call of svgCalls(probe)) {
        const name = literalName(call.args[0]);
        if (name == null || known.has(name) || seen.has(name)) continue;
        seen.add(name);
        out.push(err("svg-unknown-name",
          `build calls k.svg2d with name "${name}", which the part's svgs field does not declare: ${[...known].join(", ") || "(nothing)"}`,
          "Declare the file under svgs: { name: source }, or fix the name to match an existing entry.",
          "svgs"));
      }
      return out;
    },
  },
  {
    id: "svg-size-missing",
    run: ({ probe }) => {
      const out = [];
      for (const call of svgCalls(probe)) {
        const opts = call.args[1]?.trim();
        // Only an object LITERAL can be judged; anything else is skipped.
        if (opts != null && !opts.startsWith("{")) continue;
        if (opts && /\b(width|height|fit)\s*:/.test(opts)) continue;
        const name = literalName(call.args[0]) ?? "…";
        out.push(err("svg-size-missing",
          `k.svg2d("${name}", …) declares no size — one of { width }, { height }, or { fit } is required, in millimetres`,
          "SVG user units have no physical meaning, so there is no safe default to fall back on (unlike k.text2d's cap-height `size`). "
          + `Add one, e.g. k.svg2d("${name}", { width: 20 }).`,
          "build"));
      }
      return out;
    },
  },
];
```

- [ ] **Step 3b: Register the rules in `src/framework/lint/index.js`**

Add the import beside the others (after the `FONT_RULES` line):

```js
import { SVG_RULES } from "./rules-svg.js";
```

and add `...SVG_RULES` to the `RULES` array, after `...FONT_RULES`:

```js
export const RULES = [...SHAPE_RULES, ...SCHEMA_RULES, ...BUILD_RULES, ...VERIFY_RULES, ...ANIMATION_RULES, ...PLACE_RULES, ...IMPORT_RULES, ...FONT_RULES, ...SVG_RULES, ...SOURCE_RULES];
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/lint-svg.test.js test/lint-registry.test.js
```

Expected: `lint-svg` PASS (10 tests). `lint-registry.test.js` enforces that every rule id is registered and documented — if it fails, it will name what it wants (typically the rule ids listed in the AUTHORING-PARTS rule catalog, which Task 12 adds). If it demands the doc entry now, add the catalog lines from Task 12 here instead and note it.

- [ ] **Step 5: Commit**

```bash
git add src/framework/lint/rules-svg.js src/framework/lint/index.js test/lint-svg.test.js
git commit -m "svg: lint rules for unknown names and missing sizes"
```

---

### Task 11: The `emblem` reference part

**Files:**
- Create: `src/parts/assets/emblem.svg`
- Create: `src/parts/emblem.js`
- Create: `emblem.html`, `src/app-emblem.js`, `src/emblem-worker.js`
- Modify: `vite.config.js` (add `emblem` to `rollupOptions.input`)
- Modify: `.github/workflows/ci.yml` (add the smoke check)
- Test: `test/emblem-part.test.js`, `test/svg2d-occt.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: `src/parts/emblem.js` default-exporting a `PartDefinition` with an `svgs` field — the worked example the docs point at.

**The artwork is chosen to exercise both paths and to be arithmetically checkable.** A filled `<circle>` (radius 10 at 24,24 → spans 14–34 in both axes) plus a stroked open `<polyline>` at y=42, width 4 with round caps (→ spans x 4–44, y 40–44). Their union's tight bbox is therefore **40 × 30 user units** — a number the tests assert directly, and one that is wrong if strokes are dropped, if caps are missed, or if the bbox is taken from the `viewBox` instead of the geometry.

- [ ] **Step 1: Write the failing test**

Create `test/emblem-part.test.js`:

```js
// The k.svg2d reference part. Manifold-booting only; never boot OCCT in this
// file (AGENTS.md — the two WASM kernels must not share a process).
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel({ svgs: part.svgs }); });

const build = (overrides = {}) => {
  const p = { ...part.defaults, ...overrides };
  const d = part.derive ? part.derive(p) : {};
  return part.parts.plate.build(k, p, d);
};

test("the part declares its artwork under svgs", () => {
  expect(Object.keys(part.svgs)).toEqual(["emblem"]);
});

test("the plate builds, is solid, and carries the emboss", () => {
  const s = build();
  expect(s.toMesh().triangles).toBeGreaterThan(0);
  expect(s.volume()).toBeGreaterThan(0);
  // the emboss adds material above the bare plate
  const bare = k.box({ min: [-20, -16, 0], max: [20, 16, 3] });
  expect(s.volume()).toBeGreaterThan(bare.volume());
});

test("the emblem's own aspect is 40:30 — the union of fill and stroke, not the viewBox", () => {
  const shape = k.svg2d("emblem", { width: 40 });
  const { min, max } = shape.extrude(1).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 1);
  expect(max[1] - min[1]).toBeCloseTo(30, 1);
});

test("dropping strokes shrinks the artwork to the filled circle alone", () => {
  const { min: minA, max: maxA } = k.svg2d("emblem", { width: 40, strokes: "ignore" }).extrude(1).boundingBox();
  // the circle alone is square, so a width-40 fit makes it 40 x 40
  expect(maxA[1] - minA[1]).toBeCloseTo(40, 1);
});

test("emblem_w drives the emboss size", () => {
  expect(build({ emblem_w: 30 }).volume()).toBeGreaterThan(build({ emblem_w: 15 }).volume());
});
```

Create `test/svg2d-occt.test.js`:

```js
// Cross-backend agreement for k.svg2d. It lowers to k.shape2d, which both
// backends implement, and the regions are curve-native — so the extruded
// volume must match the Manifold figure to within meshing tolerance.
// OCCT-booting: this file must contain NO Manifold boot (AGENTS.md).
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing.js";
import part from "../src/parts/emblem.js";

let k;
beforeAll(async () => { k = await bootOcctKernel({ svgs: part.svgs }); });

test("the emblem extrudes to the same bbox on OCCT as on Manifold", () => {
  const { min, max } = k.svg2d("emblem", { width: 40 }).extrude(2).boundingBox();
  expect(max[0] - min[0]).toBeCloseTo(40, 2);
  expect(max[1] - min[1]).toBeCloseTo(30, 2);
  expect(max[2] - min[2]).toBeCloseTo(2, 3);
});

test("a stroked-only document outlines on OCCT too", () => {
  const { min, max } = k.svg2d("emblem", { width: 40, strokes: "ignore" }).extrude(1).boundingBox();
  expect(max[1] - min[1]).toBeCloseTo(40, 2);   // the filled circle alone
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/emblem-part.test.js`
Expected: FAIL — cannot resolve `src/parts/emblem.js`.

- [ ] **Step 3a: Create the artwork**

Create `src/parts/assets/emblem.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <!-- A filled shape and a stroked OPEN shape, so this one file exercises both
       of k.svg2d's geometry paths. The union's tight bbox is 40 x 30 user
       units: the circle spans 14..34 in both axes, the stroked bar spans
       4..44 in x (round caps add half the 4-unit width at each end) and
       40..44 in y. Deliberately NOT centred in the viewBox, so anything that
       sizes from the viewBox instead of the geometry gets a visibly wrong
       answer. -->
  <circle cx="24" cy="24" r="10" fill="#111"/>
  <polyline points="6 42 42 42" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 3b: Create `src/parts/emblem.js`**

```js
// The k.svg2d reference part — vector art embossed on a plate.
//
// `svgs` is declared with `new URL(..., import.meta.url)`, the same form
// import-demo.js uses for its STL: Vite turns it into a bundled asset URL, and
// in Node it is a file: URL that src/testing/assets.js reads off disk. A bare
// `() => import("./assets/emblem.svg")` would work in Vite and fail in the CLI.
export default {
  meta: { title: "Emblem", units: "mm", background: 0x15181d },
  svgs: {
    emblem: new URL("./assets/emblem.svg", import.meta.url),
  },
  parameters: [
    {
      id: "plate",
      title: "Plate",
      description: "The backing plate the artwork is embossed on.",
      advanced: [
        { key: "plate_w", label: "Width", unit: "mm", min: 20, max: 80, step: 1,
          description: "Plate width." },
        { key: "plate_h", label: "Depth", unit: "mm", min: 16, max: 60, step: 1,
          description: "Plate depth." },
        { key: "plate_t", label: "Thickness", unit: "mm", min: 1, max: 10, step: 0.5,
          description: "Plate thickness." },
      ],
    },
    {
      id: "art",
      title: "Artwork",
      description: "The embossed vector art. `emblem.svg` carries a filled circle and a stroked bar, so both of `k.svg2d`'s geometry paths are exercised.",
      advanced: [
        { key: "emblem_w", label: "Emblem width", unit: "mm", min: 8, max: 70, step: 1,
          description: "Width of the artwork's **tight bounding box** in mm — not its `viewBox`. Stroke thickness scales with it." },
        { key: "emboss", label: "Emboss height", unit: "mm", min: 0.4, max: 4, step: 0.2,
          description: "How far the artwork stands proud of the plate." },
      ],
    },
  ],
  defaults: { plate_w: 40, plate_h: 32, plate_t: 3, emblem_w: 30, emboss: 1 },
  parts: {
    plate: {
      label: "Plate",
      views: ["plate"],
      export: { name: "emblem-plate" },
      build: (k, p) => k
        .box({ min: [-p.plate_w / 2, -p.plate_h / 2, 0], max: [p.plate_w / 2, p.plate_h / 2, p.plate_t] })
        .union(k.svg2d("emblem", { width: p.emblem_w }).extrude(p.emboss).translate([0, 0, p.plate_t])),
    },
  },
  views: { plate: { label: "Plate" } },
  verify: {
    expect: {
      plate: { bbox: "<=[81,61,15]" },
      _view: { overlaps: 0 },
    },
  },
};
```

- [ ] **Step 3c: Create the three glue files**

`src/emblem-worker.js`:

```js
import part from "./parts/emblem.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
```

`src/app-emblem.js`:

```js
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import emblemPart from "./parts/emblem.js";
import { mount } from "./framework/index.js";

// Dev-only example app for the emblem part (the k.svg2d reference).
// `npm run dev`, then open /emblem.html.
window.__pfRuntime = mount(emblemPart, {
  createWorker: (name) =>
    new Worker(new URL("./emblem-worker.js", import.meta.url), { type: "module", name }),
});
```

`emblem.html` — copy `demo.html` verbatim, then change exactly four things: the `<title>` to `Emblem — SVG reference part`, the `<h1>` to `Emblem`, the `<p class="sub">` to `k.svg2d reference · vector art embossed on a plate`, and the final `<script type="module" src="...">` to `/src/app-emblem.js`. Leave every id and class untouched — mount binds to them by name.

- [ ] **Step 3d: Register the page and the CI check**

In `vite.config.js`, add to `rollupOptions.input`, after the `screw` line:

```js
        emblem: "emblem.html",
```

In `.github/workflows/ci.yml`, after the `lofted-bottle.html` line:

```yaml
      - run: CHECK_PORT=5189 node scripts/check-app.mjs emblem.html # k.svg2d reference part (filled + stroked artwork)
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/emblem-part.test.js
npx vitest run test/svg2d-occt.test.js
npx partforge lint src/parts/emblem.js
npx partforge measure src/parts/emblem.js
```

Expected: both test files PASS; `lint` exits 0 with no findings; `measure` exits 0 and reports a watertight plate whose bbox is 40 × 32 × 4.

Then the browser smoke check: `node scripts/check-app.mjs emblem.html`

- [ ] **Step 5: Commit**

```bash
git add src/parts/emblem.js src/parts/assets/emblem.svg src/app-emblem.js src/emblem-worker.js \
        emblem.html vite.config.js .github/workflows/ci.yml \
        test/emblem-part.test.js test/svg2d-occt.test.js
git commit -m "svg: emblem reference part, wired into the dev pages and CI"
```

---

### Task 12: Documentation and release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md`
- Modify: `docs/ERROR-PATTERNS.md`
- Modify: `docs/REFERENCE-PARTS.md`
- Modify: `skills/partforge/SKILL.md`
- Modify: `AGENTS.md` (the parts inventory sentence)
- Modify: `package.json` (`0.91.0` → `0.92.0`)

**Interfaces:**
- Consumes: the finished surface from Tasks 1–11.
- Produces: no code.

- [ ] **Step 1: Add the `svgs` field to the PartDefinition table**

In `docs/AUTHORING-PARTS.md`, after the `imports?` line (~line 76):

```
  svgs?,                                   // { name: source } — SVG files a part's k.svg2d() needs; same source grammar and preload timing as fonts
```

And after the `imports` bullet (~line 133), a matching bullet:

```
- `svgs` declares the SVG files a part's `k.svg2d()` calls need, same source
  grammar and preload timing as `fonts` above. See "Vector art (SVG)" below.
```

- [ ] **Step 2: Write the "Vector art (SVG)" section**

Add it immediately after the `k.text2d` section ends and before "Importing geometry (STEP/STL/3MF)". Write it as `text2d`'s sibling and cover, in this order:

1. **The op** — `k.svg2d(name, { width | height | fit, align, valign, strokes, fillRule })` returns a `Shape2D`, so union/cut/offset/fillet/extrude all apply; point at `src/parts/emblem.js`.
2. **The `svgs` field** — the `{ name: source }` map, with the `new URL("./art/x.svg", import.meta.url)` form called out as the one that works in **both** Vite and the Node CLI, and a note that a bare `() => import("./x.svg")` works only in Vite.
3. **Sizing** — exactly one of `width`/`height`/`fit`, in mm, measured on the **tight geometric bounding box, not the `viewBox`**. Say why there is no default (SVG user units have no physical meaning, unlike a font's cap height), and that stroke thickness scales with the artwork.
4. **What is supported** — `path` (full `d` grammar, absolute and relative), `rect`/`circle`/`ellipse`/`line`/`polyline`/`polygon`, `g`, `transform=`, the presentation attributes, and inline `style=`.
5. **What is not, and throws** — `<use>`, `<defs>`, `<symbol>`, `<style>`, `<text>`, `<image>`, `<clipPath>`, `<mask>`, `<filter>`, and `class=`. State plainly that these throw rather than being skipped, because each removes geometry the author can see in their editor.
6. **Strokes** — outlined into real geometry; `stroke-linecap` and `stroke-linejoin` are honored; `strokes: "ignore"` opts out. Record that `stroke-miterlimit` is read but not applied (a fixed limit of 2 is used, against SVG's default of 4), so very sharp mitres bevel earlier than a browser would draw them.
7. **Painting order is not modelled** — every element contributes material and the results union. An SVG that fakes a hole by painting a white shape over a black one gives a solid shape. Cross-reference the ERROR-PATTERNS entry.

Also update the "Editing profiles" line (~1231) so its "imported SVG" reference points at this section instead of being aspirational.

- [ ] **Step 3: Add the rule catalog entries**

In the AUTHORING-PARTS "Linting" → Rule catalog, after the **Font controls** paragraph, add:

```
**Vector art** — `svg-unknown-name` (a build calls `k.svg2d` with a name the
part's `svgs` field doesn't declare — this throws at build time) (error);
`svg-size-missing` (a `k.svg2d` call whose options literal carries none of
`width`/`height`/`fit`; SVG user units have no physical meaning, so there is no
default to fall back on) (error). Both judge only literal arguments — a name or
an options object computed at build time is skipped, and still fails correctly
at build time.
```

- [ ] **Step 4: Add the ERROR-PATTERNS entries**

Add one `##` section per pattern to `docs/ERROR-PATTERNS.md`, each following the file's existing symptom → cause → fix shape:

- `svg-unknown-name` — literal text `svg2d: unknown svg "…"`.
- `svg-unsupported-element` — literal text `svg: <use> is not supported — …`.
- `svg-no-geometry` — literal text `svg: no drawable geometry`.
- `svg-size-required` — literal text `svg2d: a size is required`.
- `svg-stroke-collapsed` — literal text `svg: stroke outline collapsed`.
- `svg-malformed` — the `svg: ` parse failures from `svg-xml.js`/`svg-path.js`.
- `svg-painting-order` — **no error text**; this one is a "my part looks wrong" entry. Symptom: a shape that is a hole in the editor comes out solid. Cause: the artwork paints a background-coloured shape on top instead of using a fill rule. Fix: make it a real hole — one `<path>` with two subpaths and `fill-rule="evenodd"`, or subtract it in the part with `.cut()`.

- [ ] **Step 5: Update the inventories and the skill**

- `docs/REFERENCE-PARTS.md` — add `emblem.js` as the `k.svg2d` reference part, in the shape the neighbouring entries use.
- `skills/partforge/SKILL.md` — add `svg2d` to the op vocabulary next to `text2d`.
- `AGENTS.md` — the "`src/parts/` now has fifteen" sentence becomes **sixteen**, with `emblem.js` described as "(the `k.svg2d` reference part — vector art embossed on a plate, filled and stroked)".

- [ ] **Step 6: Bump the version**

In `package.json`, change `"version": "0.91.0"` to `"version": "0.92.0"`.

This is not optional and it is not a release-day step. The publish workflow tags and publishes on merge; if the version is unchanged the merge lands, npm already has that version, the workflow correctly does nothing, and the work silently never ships. See AGENTS.md "Releasing".

- [ ] **Step 7: Run the full suite**

```bash
npm test
npm run typecheck
npx partforge lint src/parts/emblem.js
node scripts/check-app.mjs emblem.html
```

Expected: all green. `test/error-patterns.test.js` reads `docs/ERROR-PATTERNS.md` and will fail if a pattern id referenced in code has no `##` section — that is the check on Step 4.

- [ ] **Step 8: Commit**

```bash
git add docs/AUTHORING-PARTS.md docs/ERROR-PATTERNS.md docs/REFERENCE-PARTS.md \
        skills/partforge/SKILL.md AGENTS.md package.json
git commit -m "svg: document k.svg2d and bump to 0.92.0"
```

---

## Notes for the executor

- **If `resolveCurveFill` throws `"curve-fill: resolved hole has no containing outer"`** on real artwork, that is a winding problem upstream, not a bug in the resolver — check that the y-flip in `svg2d.js` was applied before the fill resolve and not after.
- **If a stroke test's area is short by exactly the cap area**, the 180°-reversal branch in `offsetOpenChain` is not firing. `contour-offset.js:117-126` documents the same bug and the same symptom; the `turn === 0` clause is what fixes it.
- **Do not add an `svgs` digest.** It looks like a missing piece next to `imports.js`; it is not. `kernel-front.js:117-121` records the argument — the `Shape2D` hash keys on coordinates, so different artwork already invalidates its own cache node.
- **Never boot OCCT and Manifold in the same process.** `test/svg2d-occt.test.js` is OCCT-only for this reason; vitest isolates per file.
