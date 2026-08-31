# Unified Asset Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One way to get a file into a part — drop an SVG, a photo, or a font onto the control panel and it becomes the right internal format on the right part field; the same machinery, from the CLI, puts it into a part's asset tree.

**Architecture:** A DOM-free converter registry and byte sniffer answer "what does this file become?". A single drop widget uses them and is shared by three thin control types (`image`, `vector`, `font`). Field routing needs no new machinery — the existing declaration-function pattern (`fonts: (p) => …`) already routes a param to its field. The same registry backs a new `partforge ingest` CLI command.

**Tech Stack:** ESM, vitest, happy-dom (tests + optional CLI peer), paper.js (SVG converter, existing).

**Spec:** `docs/superpowers/specs/2026-08-30-unified-asset-ingest-design.md`

## Global Constraints

- **Node 24 is required.** `.nvmrc` pins v24.16.0; the default shell Node is too old and fails confusingly. Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`.
- **Never use `git stash`.** This repo's stash stack is shared across worktrees and concurrent sessions. To compare against pre-fix code, copy files aside.
- **Everything under `src/framework/ingest/` is main-thread and must never enter the geometry worker's import closure.** `test/worker-layering.test.js` walks that closure statically and fails on any module naming a DOM global. If it fails, remove the import — never weaken the test.
- **`registry.js` and `sniff.js` must be DOM-free AND converter-free at module scope** — the CLI reads the table without loading paper.js. Converters load lazily, per row, on use.
- **Adding a control type touches four parity registries**, not one. See Task 9's list. Grep for others before assuming that list is complete.
- **A security-rule test must be watched failing** before it is accepted (Task 7).
- **`CONTRACT_VERSION` is unrelated to this work — do not touch it.**
- **Version bump is Task 11.** Main is shipping fast; check `npm view partforge version` at that point rather than trusting any number written here.

## Open item resolved before planning

**Does the CLI's SVG path ship in the published package?** Probed:

- `happy-dom` is a **devDependency**, 17 MB.
- `package.json`'s `files` lists `src`, `bin`, `types`, four docs — **not `scripts/`**, so `scripts/ingest-svg.mjs` is already unpublished.
- `bin/cli.js` is DOM-free today.
- **happy-dom has no canvas raster backend** — `scripts/ingest-svg.mjs` stubs `getContext` with no-ops precisely because "paper never touches the raster context for geometry".

**Resolution:** `happy-dom` becomes an **optional peer dependency**, so the 17 MB does not land on every consumer. The CLI supports:

| Kind | CLI behaviour |
| --- | --- |
| SVG | Converts, **requires happy-dom**; a clear install message when absent |
| Font | Identity + validation — works anywhere, no DOM |
| PNG | **Passes through with validation.** It is already the target format; no conversion needed |
| JPEG/WebP/other raster | **Refused** with a message pointing at the browser path — headless conversion needs a real codec happy-dom does not have |

---

### Task 1: `vectors` gains the function-of-params form

Blocking: a `type: "vector"` control has nothing to drive without it.

**Files:**
- Modify: `src/framework/vectors.js`
- Modify: `src/framework/jobs.js` (the `ensureVectors(kernel, part.vectors)` call)
- Modify: `bin/cli.js` (three `part.vectors` sites)
- Test: `test/vectors.test.js`

**Interfaces:**
- Produces: `vectorsFor(part, p) -> object | undefined` — mirrors `fontsFor`/`imagesFor` exactly.

- [ ] **Step 1: Write the failing test**

```js
// append to test/vectors.test.js
import { vectorsFor } from "../src/framework/vectors.js";

test("vectorsFor resolves the function form with params", () => {
  const part = { vectors: (p) => (p.art ? { art: p.art } : {}) };
  expect(vectorsFor(part, { art: "x" })).toEqual({ art: "x" });
  expect(vectorsFor(part, {})).toEqual({});
});

test("vectorsFor passes a static object through unchanged", () => {
  const decl = { art: "https://cdn.test/a.vector.json" };
  expect(vectorsFor({ vectors: decl }, {})).toBe(decl);
});

test("vectorsFor is undefined-safe for a part with no vectors", () => {
  expect(vectorsFor({}, {})).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/vectors.test.js`
Expected: FAIL — `vectorsFor` is not exported

- [ ] **Step 3: Implement**

In `src/framework/vectors.js`, mirroring `fontsFor` in `src/framework/fonts.js` (read it first — copy its comment shape, not just its code):

```js
// `vectors` may be a plain { name: source } map, or a function of the resolved
// params — the second form is what lets a `type: "vector"` control drive the
// artwork. Resolving it needs `p`, which is why this is a separate step from
// resolveVectors rather than folded into it. Mirrors fontsFor/imagesFor.
export function vectorsFor(part, p) {
  const decl = part?.vectors;
  return typeof decl === "function" ? decl(p) : decl;
}
```

- [ ] **Step 4: Update the call sites**

`src/framework/jobs.js` — the `ensureVectors` call currently passes `part.vectors` raw. Read the comment above it: it explains why the call is **unconditional** (ensureVectors owns the prune). Preserve that property — pass `vectorsFor(part, p)` and keep the call unconditional.

`bin/cli.js` — three sites use `part.vectors`: the `bootKernel` opts and two `resolveVectorDocs(part.vectors)` calls. `bootKernel` already computes `p`; the other two must too. Read how `bootKernel` derives `p` and follow it.

- [ ] **Step 5: Run the affected tests**

Run: `npx vitest run test/vectors.test.js test/lint-vector.test.js test/cli-assets.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/vectors.js src/framework/jobs.js bin/cli.js test/vectors.test.js
git commit -m "feat: vectors gains the function-of-params form"
```

---

### Task 2: The byte sniffer

**Files:**
- Create: `src/framework/ingest/sniff.js`
- Test: `test/ingest-sniff.test.js`

**Interfaces:**
- Produces: `sniffMediaType(bytes) -> string | null` — `bytes` is an `ArrayBuffer` or `Uint8Array`; returns a media type string (`"image/png"`, `"image/jpeg"`, `"image/webp"`, `"image/svg+xml"`, `"font/ttf"`, `"font/otf"`, `"font/woff2"`) or `null` when unrecognised. **WOFF2 is recognised deliberately** so the registry can refuse it by name rather than as "unknown".

- [ ] **Step 1: Write the failing test**

```js
// test/ingest-sniff.test.js
import { describe, test, expect } from "vitest";
import { sniffMediaType } from "../src/framework/ingest/sniff.js";

const u8 = (...b) => Uint8Array.from(b);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

describe("sniffMediaType", () => {
  test("PNG magic", () => {
    expect(sniffMediaType(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });
  test("JPEG magic", () => {
    expect(sniffMediaType(u8(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe("image/jpeg");
  });
  test("WebP magic (RIFF….WEBP)", () => {
    expect(sniffMediaType(cat(ascii("RIFF"), u8(0, 0, 0, 0), ascii("WEBP")))).toBe("image/webp");
  });
  test("TrueType magic (0x00010000)", () => {
    expect(sniffMediaType(u8(0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0))).toBe("font/ttf");
  });
  test("OpenType magic (OTTO)", () => {
    expect(sniffMediaType(cat(ascii("OTTO"), u8(0, 0, 0, 0)))).toBe("font/otf");
  });
  test("WOFF2 is recognised, so it can be refused by name", () => {
    expect(sniffMediaType(cat(ascii("wOF2"), u8(0, 0, 0, 0)))).toBe("font/woff2");
  });
  test("SVG by root element", () => {
    expect(sniffMediaType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("image/svg+xml");
  });
  test("SVG behind an XML declaration and a comment", () => {
    expect(sniffMediaType(ascii('<?xml version="1.0"?>\n<!-- hi -->\n<svg></svg>'))).toBe("image/svg+xml");
  });
  test("unknown bytes are null, not a guess", () => {
    expect(sniffMediaType(u8(1, 2, 3, 4, 5, 6, 7, 8))).toBe(null);
  });
  test("empty input is null", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBe(null);
  });
  test("accepts an ArrayBuffer as well as a view", () => {
    const v = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(sniffMediaType(v.buffer)).toBe("image/png");
  });

  // The adversarial pair — the whole reason this file exists rather than an
  // extension check. A caller passes only bytes, so a misnamed file cannot lie.
  test("a PNG's bytes sniff as PNG regardless of any filename", () => {
    expect(sniffMediaType(u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });
  test("an SVG's bytes sniff as SVG regardless of any filename", () => {
    expect(sniffMediaType(ascii("<svg></svg>"))).toBe("image/svg+xml");
  });
  test("HTML that merely mentions svg is not claimed", () => {
    expect(sniffMediaType(ascii("<html><body>svg</body></html>"))).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ingest-sniff.test.js`
Expected: FAIL — cannot resolve `sniff.js`

- [ ] **Step 3: Implement**

```js
// src/framework/ingest/sniff.js
// Bytes -> media type. The whole point is that a caller passes BYTES, never a
// filename: a file's claimed type is user input, and this is the path a
// mislabelled upload would travel. Nothing here trusts an extension because
// nothing here is given one.
//
// DOM-free and node:-free, and free of any converter import, so both the panel
// and the CLI can read it without loading paper.js.

const MAGIC = [
  { type: "image/png",  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "font/otf",   bytes: [0x4f, 0x54, 0x54, 0x4f] },              // "OTTO"
  { type: "font/woff2", bytes: [0x77, 0x4f, 0x46, 0x32] },              // "wOF2"
  { type: "font/ttf",   bytes: [0x00, 0x01, 0x00, 0x00] },
  { type: "font/ttf",   bytes: [0x74, 0x72, 0x75, 0x65] },              // "true"
];

const startsWith = (u8, sig) => {
  if (u8.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (u8[i] !== sig[i]) return false;
  return true;
};

// How far into a text file we look for an <svg root. Enough for an XML
// declaration, a DOCTYPE and a licence comment; bounded so a huge non-SVG text
// file is not scanned end to end.
const SVG_SCAN = 4096;

export function sniffMediaType(input) {
  if (!input) return null;
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length === 0) return null;

  for (const m of MAGIC) if (startsWith(u8, m.bytes)) return m.type;

  // WebP is RIFF????WEBP — the size field sits between the two tags.
  if (u8.length >= 12 && startsWith(u8, [0x52, 0x49, 0x46, 0x46])
      && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
    return "image/webp";
  }

  // SVG has no magic number, so look for an <svg ROOT element — not the mere
  // substring "svg", which any HTML page mentioning it would match.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(u8.subarray(0, SVG_SCAN));
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";

  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/ingest-sniff.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/ingest/sniff.js test/ingest-sniff.test.js
git commit -m "feat: byte sniffer for asset ingest"
```

---

### Task 3: The converter registry

**Files:**
- Create: `src/framework/ingest/registry.js`
- Test: `test/ingest-registry.test.js`

**Interfaces:**
- Consumes: `sniffMediaType` from `./sniff.js` (Task 2).
- Produces:
  - `ASSET_KINDS = ["image", "vector", "font"]`
  - `rowFor(kind) -> { kind, accepts: string[], label, convert: (() => Promise<fn>) | null }`
  - `classify(bytes, kind) -> { ok: true, mediaType } | { ok: false, reason, mediaType, suggestKind }`
  - `convertFor(kind, mediaType) -> Promise<fn | null>` — lazily imports the converter; `null` means "used as-is".

`convert` is a **thunk returning a dynamic import**, never a direct import, so `registry.js` stays converter-free at module scope.

- [ ] **Step 1: Write the failing test**

```js
// test/ingest-registry.test.js
import { describe, test, expect } from "vitest";
import { ASSET_KINDS, rowFor, classify, convertFor } from "../src/framework/ingest/registry.js";

const u8 = (...b) => Uint8Array.from(b);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const PNG = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const SVG = ascii("<svg></svg>");
const TTF = u8(0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0);
const WOFF2 = ascii("wOF2");

describe("registry", () => {
  test("declares exactly the three asset kinds", () => {
    expect(ASSET_KINDS).toEqual(["image", "vector", "font"]);
  });

  test("every kind has a row with a non-empty accepts list and a label", () => {
    for (const k of ASSET_KINDS) {
      const row = rowFor(k);
      expect(row, k).toBeTruthy();
      expect(row.accepts.length, k).toBeGreaterThan(0);
      expect(typeof row.label, k).toBe("string");
    }
  });

  test("an unknown kind has no row", () => {
    expect(rowFor("nope")).toBeUndefined();
  });

  test("fonts declare no converter — used as-is", () => {
    expect(rowFor("font").convert).toBe(null);
  });

  test("accepts the right bytes for each kind", () => {
    expect(classify(PNG, "image").ok).toBe(true);
    expect(classify(SVG, "vector").ok).toBe(true);
    expect(classify(TTF, "font").ok).toBe(true);
  });

  test("rejects the wrong kind AND names where it belongs", () => {
    const r = classify(SVG, "image");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe("image/svg+xml");
    expect(r.suggestKind).toBe("vector");   // drives the "use the Artwork slot" message
  });

  test("rejects a right-kind-wrong-format file by name, not as unknown", () => {
    const r = classify(WOFF2, "font");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe("font/woff2");
    expect(r.suggestKind).toBe(null);       // belongs to no slot — it is just unsupported
  });

  test("unrecognised bytes report no media type", () => {
    const r = classify(u8(1, 2, 3, 4, 5, 6, 7, 8), "image");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe(null);
  });

  test("convertFor resolves a function for a converting kind", async () => {
    expect(typeof await convertFor("vector", "image/svg+xml")).toBe("function");
    expect(typeof await convertFor("image", "image/jpeg")).toBe("function");
  });

  test("convertFor returns null for a used-as-is kind", async () => {
    expect(await convertFor("font", "font/ttf")).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ingest-registry.test.js`
Expected: FAIL — cannot resolve `registry.js`

- [ ] **Step 3: Implement**

```js
// src/framework/ingest/registry.js
// The one table that answers "what does this file become?" — read by the panel's
// drop widget AND by `partforge ingest`. It does NOT route to part fields: the
// declaration-function pattern (`images: (p) => ({ relief: p.relief })`) already
// does that, because a control writes into its own param key and the author's
// declaration puts that key in the right field.
//
// DOM-free, node:-free, and converter-free AT MODULE SCOPE: `convert` is a thunk
// returning a dynamic import, so reading the table costs nothing and the CLI
// never loads paper.js for a font.
import { sniffMediaType } from "./sniff.js";

export const ASSET_KINDS = ["image", "vector", "font"];

const ROWS = [
  {
    kind: "image",
    label: "an image (PNG, JPG or WebP)",
    accepts: ["image/png", "image/jpeg", "image/webp"],
    convert: () => import("./image-ingest.js").then((m) => m.imageToPng),
  },
  {
    kind: "vector",
    label: "artwork (SVG)",
    accepts: ["image/svg+xml"],
    convert: () => import("./svg-ingest.js").then((m) => m.ingestSvg),
  },
  {
    kind: "font",
    label: "a font (TTF or OTF)",
    accepts: ["font/ttf", "font/otf"],
    convert: null,                        // used as-is; validated, never converted
  },
];

export const rowFor = (kind) => ROWS.find((r) => r.kind === kind);

// Which kind, if any, WOULD accept this media type — the "use the Artwork slot"
// hint. null when no slot accepts it (an unsupported format, e.g. WOFF2).
const kindAccepting = (mediaType) => ROWS.find((r) => r.accepts.includes(mediaType))?.kind ?? null;

export function classify(bytes, kind) {
  const mediaType = sniffMediaType(bytes);
  const row = rowFor(kind);
  if (row && mediaType && row.accepts.includes(mediaType)) return { ok: true, mediaType };
  return { ok: false, reason: mediaType ? "wrong-type" : "unrecognised",
           mediaType, suggestKind: mediaType ? kindAccepting(mediaType) : null };
}

export async function convertFor(kind, mediaType) {
  const row = rowFor(kind);
  if (!row || !row.accepts.includes(mediaType)) return null;
  return row.convert ? row.convert() : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/ingest-registry.test.js`
Expected: PASS. `convertFor("image", …)` will fail until Task 4 moves `image-ingest.js` into `ingest/` — if it does, do Task 4 first and return here.

- [ ] **Step 5: Commit**

```bash
git add src/framework/ingest/registry.js test/ingest-registry.test.js
git commit -m "feat: converter registry for asset ingest"
```

---

### Task 4: Move `imageToPng` into `ingest/` and off the main entry

**Files:**
- Move: `src/framework/image-ingest.js` → `src/framework/ingest/image-ingest.js`
- Modify: `src/index.js` (remove the export)
- Modify: `src/ingest.js` (add the export)
- Modify: `types/index.d.ts` (remove), `types/ingest.d.ts` (add)
- Modify: `test/image-ingest.test.js` (import path)

**Why:** `src/ingest.js` states the policy — *"Deliberately NOT re-exported from `partforge` (the main entry) or from `partforge/geometry`: this must stay unreachable from the geometry worker."* `imageToPng` currently violates it. **This removes an export from the published main entry** — pre-1.0 and days old, but a real break.

- [ ] **Step 1: Move the file and update its import path in the test**

```bash
git mv src/framework/image-ingest.js src/framework/ingest/image-ingest.js
```

Update `test/image-ingest.test.js`'s import to `../src/framework/ingest/image-ingest.js`.

- [ ] **Step 2: Move the export**

In `src/index.js`, DELETE the `imageToPng` re-export. In `src/ingest.js`, add it beside `ingestSvg`:

```js
export { ingestSvg } from "./framework/ingest/svg-ingest.js";
export { imageToPng } from "./framework/ingest/image-ingest.js";
```

- [ ] **Step 3: Move the type declaration**

Remove `ImageToPngOptions` and `imageToPng` from `types/index.d.ts`; add both to `types/ingest.d.ts`. `test/types-surface.test.js` enforces parity between each entry's runtime exports and its `.d.ts` — it will fail on both files until both are right.

- [ ] **Step 4: Run the affected tests**

Run: `npx vitest run test/image-ingest.test.js test/types-surface.test.js test/worker-layering.test.js test/ingest-registry.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: imageToPng moves to partforge/ingest, off the main entry"
```

---

### Task 5: The shared drop widget and the `onAssetUpload` seam

**Files:**
- Create: `src/framework/panel/widgets/file-drop.js`
- Modify: `src/framework/mount.js` (accept + forward `onAssetUpload`)
- Modify: `src/framework/panel/render.js` (forward it to widgets)
- Test: `test/file-drop.test.js`

**Interfaces:**
- Consumes: `classify`, `convertFor`, `rowFor` from `../../ingest/registry.js`.
- Produces: `makeFileDrop({ kind, onSource, onError, onAssetUpload }) -> { el, dispose }` where `onSource(source)` receives either a string (a host URL/token) or an `ArrayBuffer` (the fallback).

**Destination ladder:** `onAssetUpload` present → its returned string is the source. Absent → the converted bytes are the source. On upload failure the converted blob is **kept in memory** so a retry needs no reconvert.

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment happy-dom
import { describe, test, expect, vi } from "vitest";
import { makeFileDrop } from "../src/framework/panel/widgets/file-drop.js";

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A File stand-in: happy-dom has File, but arrayBuffer() is what we rely on.
const fileOf = (bytes, name) => Object.assign(new Blob([bytes]), {
  name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

const dropOn = async (el, ...files) => {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));   // let the async handler settle
};

describe("makeFileDrop", () => {
  test("a font needs no converter and yields its bytes unchanged", async () => {
    const onSource = vi.fn();
    const { el } = makeFileDrop({ kind: "font", onSource, onError: vi.fn() });
    const TTF = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);
    await dropOn(el, fileOf(TTF, "x.ttf"));
    expect(onSource).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(onSource.mock.calls[0][0])).toEqual(TTF);
  });

  test("the wrong kind is refused and the message names the right slot", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(ascii("<svg></svg>"), "logo.svg"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/artwork/i);
  });

  test("a right-kind-wrong-format file names the formats that work", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "font", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(ascii("wOF2...."), "x.woff2"));
    expect(onError.mock.calls[0][0]).toMatch(/TTF|OTF/i);
  });

  test("unrecognised bytes are refused without guessing", async () => {
    const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError });
    await dropOn(el, fileOf(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), "x.bin"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("onAssetUpload's returned string becomes the source", async () => {
    const onSource = vi.fn();
    const onAssetUpload = vi.fn(async () => "https://cdn.test/stored.png");
    const { el } = makeFileDrop({ kind: "image", onSource, onError: vi.fn(), onAssetUpload });
    await dropOn(el, fileOf(PNG, "a.png"));
    expect(onAssetUpload).toHaveBeenCalledTimes(1);
    expect(onSource).toHaveBeenCalledWith("https://cdn.test/stored.png");
  });

  test("a failed upload reports an error and does NOT lose the file", async () => {
    const onError = vi.fn();
    const onAssetUpload = vi.fn(async () => { throw new Error("quota"); });
    const { el, lastBlob } = makeFileDrop({ kind: "image", onSource: vi.fn(), onError, onAssetUpload });
    await dropOn(el, fileOf(PNG, "a.png"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(lastBlob()).toBeTruthy();   // retryable without a reconvert
  });

  test("several files: the first is taken and the rest are reported", async () => {
    const onSource = vi.fn(); const onError = vi.fn();
    const { el } = makeFileDrop({ kind: "image", onSource, onError });
    await dropOn(el, fileOf(PNG, "a.png"), fileOf(PNG, "b.png"));
    expect(onSource).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls.flat().join(" ")).toMatch(/first/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/file-drop.test.js`
Expected: FAIL — cannot resolve `file-drop.js`

- [ ] **Step 3: Implement the widget**

Build `makeFileDrop` against the test above. Required behaviour, in order: read the first file's bytes → `classify(bytes, kind)` → on failure call `onError` with a message built from `rowFor(kind).label` and, when `suggestKind` is non-null, the slot that would accept it → on success `await convertFor(kind, mediaType)` and call it if non-null → hand the result to `onAssetUpload` if supplied, else pass the bytes → `onSource`.

It must expose `dispose()` removing every listener (`font-picker.js:49` has a comment about why a stray listener retains the whole closure — read it), and `lastBlob()` returning the retained converted blob.

Follow the `{ el, … }` shape the other widgets return, and match their comment density.

- [ ] **Step 4: Wire `onAssetUpload` through**

`src/framework/mount.js` — add `onAssetUpload` to the destructured options beside `imageCatalog`, and pass it where `fontCatalog`/`imageCatalog` are passed.
`src/framework/panel/render.js` — forward it beside `imageCatalog`.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/file-drop.test.js test/mount-font-catalog.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/framework/panel/widgets/file-drop.js src/framework/mount.js src/framework/panel/render.js test/file-drop.test.js
git commit -m "feat: shared file-drop widget and the onAssetUpload seam"
```

---

### Task 6: The image control adopts the drop widget

Smallest adoption, and it proves the widget against a control that already exists.

**Files:**
- Modify: `src/framework/panel/widgets/image.js`
- Test: `test/image-control.test.js`

**Interfaces:**
- Consumes: `makeFileDrop` (Task 5).

- [ ] **Step 1: Write the failing test**

```js
// append to test/image-control.test.js — keep the existing happy-dom pragma at line 1
test("an image control renders a drop target alongside its field", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    { relief: "" }, () => {});
  expect(root.querySelector("[data-pf-drop]"), "drop target present").toBeTruthy();
});

test("dropping a PNG with no upload hook puts bytes in the param", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { relief: "" };
  buildControls(root, [{ id: "s", controls: [{ key: "relief", type: "image", label: "Depth map" }] }],
    params, () => {});
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const file = Object.assign(new Blob([PNG]), {
    name: "d.png", arrayBuffer: async () => PNG.buffer.slice(0),
  });
  const el = root.querySelector("[data-pf-drop]");
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  expect(params.relief).toBeInstanceOf(ArrayBuffer);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/image-control.test.js`
Expected: FAIL — no `[data-pf-drop]` element

- [ ] **Step 3: Implement**

In `widgets/image.js`, mount a `makeFileDrop({ kind: "image", … })` beside the existing field/button, marking its element `data-pf-drop`. `onSource` writes the param and fires the widget's existing `onChange`/`onCommit`; `onError` renders into the widget's error surface. Call the drop's `dispose()` from the widget's own teardown.

Preserve everything already there: the URL field, the catalog button when `imageCatalog` is supplied, and the byte-valued-param rendering (hidden `<img>`, "Uploaded image" label) — a dropped file produces exactly that state, so it must already be correct.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/image-control.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/widgets/image.js test/image-control.test.js
git commit -m "feat: the image control accepts dropped files"
```

---

### Task 7: `font-source.js` accepts byte sources

**Security-relevant.** Its test must be watched failing before it is accepted.

**Files:**
- Modify: `src/framework/font-source.js`
- Test: `test/fonts-allow.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to test/fonts-allow.test.js
test("BYTES bypass the allow check — they cannot have come from a shared link", () => {
  expect(fontSourceAllowed(new ArrayBuffer(8), ["https"])).toBe(true);
  expect(fontSourceAllowed(new Uint8Array(8), ["https"])).toBe(true);
});

test("string sources still get the full allow treatment", () => {
  expect(fontSourceAllowed("http://cdn.test/f.ttf", ["https"])).toBe(false);
  expect(fontSourceAllowed("https://cdn.test/f.ttf", ["https"])).toBe(true);
  expect(fontSourceAllowed("javascript:alert(1)", ["https"])).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fonts-allow.test.js`
Expected: FAIL on the bytes test — `font-source.js:30` returns `false` for every non-string.

**Record the exact failure text in your report.** A security-rule test that has never been seen failing is not evidence.

- [ ] **Step 3: Implement**

In `src/framework/font-source.js`, add the byte bypass ahead of the string check, and record the reasoning in the file the way `image-source.js` does:

```js
const isBytes = (v) => v instanceof ArrayBuffer || ArrayBuffer.isView(v);

export function fontSourceAllowed(source, allow = FONT_ALLOW_DEFAULT) {
  // Bytes bypass the allow list. This file's older rule refused every
  // non-string on the grounds that "bytes/thunks are never param-supplied";
  // that stopped being true when the panel gained a drop target. The
  // replacement rule is sound and is the same one image-source.js states: an
  // ArrayBuffer in params definitionally did not arrive via a shared link,
  // because a URL cannot carry megabytes — so it can only have been placed
  // there by the host's own panel, which is trusted code.
  if (isBytes(source)) return true;
  if (typeof source !== "string") return false;
  // … existing string handling unchanged …
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/fonts-allow.test.js test/lint-fonts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/font-source.js test/fonts-allow.test.js
git commit -m "feat: font sources may be bytes, matching the image rule"
```

---

### Task 8: The font control adopts the drop widget

**Files:**
- Modify: `src/framework/panel/widgets/font.js`
- Test: `test/framework/panel/font-widget.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to test/framework/panel/font-widget.test.js — keep its existing pragma
test("a font control renders a drop target", () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    { face: "" }, () => {});
  expect(root.querySelector("[data-pf-drop]")).toBeTruthy();
});

test("a dropped TTF lands in the param as bytes", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById("root");
  const params = { face: "" };
  buildControls(root, [{ id: "s", controls: [{ key: "face", type: "font", label: "Typeface" }] }],
    params, () => {});
  const TTF = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4]);
  const file = Object.assign(new Blob([TTF]), {
    name: "f.ttf", arrayBuffer: async () => TTF.buffer.slice(0),
  });
  const el = root.querySelector("[data-pf-drop]");
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { files: [file] } });
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 0));
  expect(params.face).toBeInstanceOf(ArrayBuffer);
});
```

Match the file's existing `buildControls` import and call shape before writing — copy it from a neighbouring test rather than assuming.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/framework/panel/font-widget.test.js`
Expected: FAIL — no `[data-pf-drop]`

- [ ] **Step 3: Implement**

Mount `makeFileDrop({ kind: "font", … })` in `widgets/font.js` exactly as Task 6 did for images, preserving the catalog button and the URL field. A byte-valued font param has no URL to display — render a plain label, the way the image widget does for the same case, and make sure nothing calls a string method on the value.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/framework/panel/font-widget.test.js test/framework/panel/font-picker.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/framework/panel/widgets/font.js test/framework/panel/font-widget.test.js
git commit -m "feat: the font control accepts dropped files"
```

---

### Task 9: The `type: "vector"` control

A NEW control type — which touches four parity registries, not one.

**Files:**
- Create: `src/framework/panel/widgets/vector.js`
- Modify: `src/framework/panel/widget-specs.js` (TWO entries: the spec object and the `AUTHOR_EXTRAS` field list)
- Modify: `src/framework/panel/widgets/index.js` (register the factory)
- Modify: `docs/AUTHORING-PARTS.md` (control-types table row — a test requires it)
- Modify: `test/framework/panel/registry.test.js` (hardcodes `WIDGET_TYPES`)
- Test: `test/vector-control.test.js`

**Interfaces:**
- Consumes: `makeFileDrop` (Task 5), `vectorsFor` (Task 1).

**The four registries that will fail until updated** — each was discovered the hard way on the images branch:
1. `test/framework/panel/registry.test.js` — hardcoded `WIDGET_TYPES` list
2. `test/docs-coherence.test.js` — every widget type must appear in a docs table
3. `src/framework/panel/widget-specs.js` — two separate entries
4. `types/part.d.ts` — `ControlType` (note: it already omits `"font"` and `"image"`, a pre-existing gap; add `"vector"` only if the others are there, otherwise leave the union alone and say so in your report)

**Grep for a fifth before assuming four is the whole set.**

- [ ] **Step 1: Write the failing test**

```js
// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { buildControls } from "../src/framework/panel/render.js";

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
  const SVG = ascii('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
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
  // The converted document is partforge-vector JSON, never the SVG text.
  const text = params.art instanceof ArrayBuffer
    ? new TextDecoder().decode(params.art) : JSON.stringify(params.art);
  expect(text).not.toMatch(/<svg/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/vector-control.test.js`
Expected: FAIL — unknown control type `vector`

- [ ] **Step 3: Implement**

Create `widgets/vector.js` modelled on `widgets/image.js`: a drop target plus a URL field, no catalog (there is no vector catalog provider). Register it in `widgets/index.js` and add BOTH `widget-specs.js` entries. Then run the four registry tests above and fix each failure — do not pre-emptively edit them; let each one fail first so you see what it actually asserts.

- [ ] **Step 4: Run the control and every registry test**

Run: `npx vitest run test/vector-control.test.js test/framework/panel/registry.test.js test/docs-coherence.test.js test/types-surface.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: type: \"vector\" control with a drop target"
```

---

### Task 10: `partforge ingest` CLI

**Files:**
- Create: `src/framework/ingest/node-dom.js` (the happy-dom shim, promoted from the script)
- Modify: `bin/cli.js` (the `ingest` verb)
- Modify: `package.json` (`peerDependencies` + `peerDependenciesMeta`)
- Delete: `scripts/ingest-svg.mjs`
- Modify: docs referencing that script
- Test: `test/cli-ingest.test.js`

**Scope, resolved from the probe in this plan's header:**

| Kind | Behaviour |
| --- | --- |
| SVG | Converts; **requires happy-dom**, with a clear install message when absent |
| Font | Identity + validation, no DOM |
| PNG | **Passes through with validation** — already the target format |
| JPEG/WebP/other raster | **Refused**, pointing at the browser path (happy-dom has no canvas backend) |

- [ ] **Step 1: Write the failing test**

```js
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// execFileSync, not a direct function call: the bug this guards is CLI WIRING,
// and a direct call is blind to it. That distinction already earned its keep —
// the images branch shipped a bootKernel gap no direct-boot test could see.
const cli = (...args) =>
  execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("partforge ingest", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pf-ingest-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("converts an SVG to partforge-vector JSON", () => {
    const src = join(dir, "a.svg");
    writeFileSync(src, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const out = join(dir, "a.vector.json");
    cli("ingest", src, "--out", out);
    const doc = JSON.parse(readFileSync(out, "utf8"));
    expect(doc.units).toBeTruthy();
    expect(Array.isArray(doc.shapes)).toBe(true);
  });

  test("passes a PNG through and validates it", () => {
    const src = join(dir, "a.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const out = join(dir, "copy.png");
    cli("ingest", src, "--out", out);
    expect(readFileSync(out)[0]).toBe(0x89);
  });

  test("refuses a JPEG, pointing at the browser path", () => {
    const src = join(dir, "a.jpg");
    writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    let msg = "";
    try { cli("ingest", src, "--out", join(dir, "x.png")); }
    catch (e) { msg = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    expect(msg).toMatch(/browser|imageToPng/i);
  });

  test("refuses an unrecognised file without guessing", () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    let msg = "";
    try { cli("ingest", src, "--out", join(dir, "x")); }
    catch (e) { msg = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    expect(msg).toMatch(/unrecognis|unsupported/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cli-ingest.test.js`
Expected: FAIL — unknown verb `ingest`

- [ ] **Step 3: Promote the DOM shim**

Move the happy-dom setup out of `scripts/ingest-svg.mjs` into `src/framework/ingest/node-dom.js`, exporting `installNodeDom()`. Import happy-dom with a **dynamic** import inside the function, so the module can be loaded without it present. Absent, throw a message naming the install command. The script's own comment says its canvas stub is kept in sync by hand — this move removes that duplication, so delete the copy rather than leaving both.

- [ ] **Step 4: Implement the verb**

Add `ingest` to `bin/cli.js`'s dispatch and usage string. Read the file bytes, `sniffMediaType` them, look up the row, and follow the table above. Default `--out` next to the input with the right extension (`.vector.json` for SVG, the original extension for pass-through).

- [ ] **Step 5: Declare the optional peer**

```json
"peerDependencies": { "happy-dom": ">=20" },
"peerDependenciesMeta": { "happy-dom": { "optional": true } }
```

An optional PEER (not a regular dependency) keeps 17 MB off every consumer while making the requirement explicit. `happy-dom` stays in `devDependencies` so this repo's own tests keep working.

- [ ] **Step 6: Delete the script and update its references**

```bash
git rm scripts/ingest-svg.mjs
```

Grep for `ingest-svg` across `docs/` and `AGENTS.md` and point each reference at `npx partforge ingest`.

- [ ] **Step 7: Run**

Run: `npx vitest run test/cli-ingest.test.js test/cli-assets.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: partforge ingest CLI, replacing the dev-only SVG script"
```

---

### Task 11: Docs and release

**Files:**
- Modify: `docs/AUTHORING-PARTS.md` (a "Getting files into a part" section; the `onAssetUpload` mount option)
- Modify: `AGENTS.md` (the ingest story)
- Modify: `package.json` (version)

- [ ] **Step 1: Document the drop**

Add a section covering: dropping onto a control, what each kind accepts, that bytes land in the param when no host hook is supplied, and `onAssetUpload`'s contract. Match the voice of the neighbouring sections — read "Importing geometry (STEP/STL/3MF)" first.

- [ ] **Step 2: Document the CLI**

Document `npx partforge ingest`, including the four-row table from Task 10 and the happy-dom requirement for SVG. State plainly that raster conversion is browser-only and why.

- [ ] **Step 3: Update `AGENTS.md`**

It references `scripts/ingest-svg.mjs`. Replace with the CLI command.

- [ ] **Step 4: Bump the version**

```bash
npm view partforge version    # main is shipping fast — use this, not a number from this plan
```

Set `package.json` to the next minor above BOTH that and `main`'s current value, then `npm install` so the lockfile follows. Forgetting this means the merge lands and the work never publishes.

- [ ] **Step 5: Run everything**

```bash
npm test
npm run check
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: unified asset ingest; bump version"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 architecture — registry, sniff, converters, drop widget | 2, 3, 4, 5 |
| §2 routing via declaration functions | 1 (enables it for vectors); no routing code needed |
| §3 drop flow + destination ladder | 5 |
| §4 author/CLI path | 10 |
| §5 errors | 5 (drop-side), 10 (CLI-side) |
| §6 font byte bypass | 7 |
| §7 host contract (`onAssetUpload`) | 5, documented in 11 |
| §8 testing | every task; adversarial sniff pairs in 2 |
| §9 rollout order | task order matches |
| Open item 1 | resolved in this plan's header; shapes Task 10 |

**Open items 2 and 3 remain open** and are deliberately not blocking: the file-size cap (Task 5 may pick a value and say so) and whether `onAssetUpload` should also receive the original file. Neither changes an interface another task depends on.

**Placeholder scan:** no TBD/TODO. Task 9's `ControlType` note is a conditional instruction with a stated fallback, not a placeholder.

**Type consistency:** `sniffMediaType(bytes) -> string | null` is used identically in Tasks 2, 3 and 10. `classify(bytes, kind) -> {ok, reason, mediaType, suggestKind}` matches between Tasks 3 and 5. `convertFor(kind, mediaType) -> Promise<fn|null>` matches between 3 and 5. `makeFileDrop({kind, onSource, onError, onAssetUpload}) -> {el, dispose, lastBlob}` matches between 5, 6, 8 and 9. `vectorsFor(part, p)` matches between 1 and 9.
