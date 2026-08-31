# Unified asset ingest — design

**Date:** 2026-08-30
**Status:** approved design, pre-implementation
**Scope:** partforge framework — a converter registry, a shared drop/upload
widget, a third control type, one new host callback, and a `partforge ingest`
CLI command. Touches all three asset families (fonts, images, vectors) and
changes one shipped security rule. The partforge-cloud half (storing an
uploaded asset and returning a source) is specified here as a **host contract**
in §7.

**Depends on:** PR #184 (the `images` field, `type: "image"`, `imageToPng`, the
byte-bypass rule) and main's vector work (`vectors`, `partforge/ingest`,
`ingestSvg`). Lands **after** #184 merges, on its own branch.

## Goal

One way to get a file into a part. Drop an SVG, a photo, or a font onto the
control panel and it becomes the right internal format on the right part field
— and the same machinery, from the command line, puts it into a part's own
asset tree.

Today each family solves a different slice of this and none of them solves the
drop: artwork is converted by a dev-only script that is not in the published
package, images are typed in as URLs, and fonts are picked from a catalog.

## Decisions (settled with Scott, 2026-08-30)

| Question | Decision |
| --- | --- |
| Audience | **Both** an end user swapping an asset at runtime and a part author (often an agent) filling a part's tree. They differ in exactly one place — where the converted file lands — so it is one pipeline with two destinations, not two pipelines. |
| Control shape | **Two — now three — controls over shared machinery.** `type: "image"`, `type: "vector"`, `type: "font"`, each declaring what it accepts. A single `type: "asset"` that sniffs and routes was rejected: one param key cannot feed two part fields without new machinery, and one slot meaning two things makes previews and errors vaguer. |
| Fonts in scope | **Yes.** They are the third family, they need the same drop, and including them turns "two plus an exception" into one consistent rule. |
| Field routing | **No new machinery.** The existing declaration-function pattern already routes a param to its field; the registry only answers "what does this file become?". See §2. |
| Conversion for fonts | **None.** A TTF/OTF is used as-is. `convert: null` is a first-class registry row, and the honest test that the abstraction fits a converter-less family. |
| WOFF2 | **Rejected with a clear message**, not decompressed. Decompression needs a Brotli/wasm dependency for a format nobody has asked for. A future registry row if that changes. |
| Type detection | **Sniff bytes, never trust the extension.** A file's claimed type is user input, and this is the security-relevant path. |
| Host seam | **One optional `mount({ onAssetUpload })` callback**, not an upload method on each catalog. A catalog is a *browse* affordance; upload is a different job. Absent the hook, bytes go into the param — the path the sandbox already needs. |
| Conversion caching | **Out of scope.** A drop happens once per file and the host stores the result. Caching adds invalidation questions for no measured benefit. |

## Evidence (probed 2026-08-30)

Checked against the merged tree, not assumed:

1. **There is no drop affordance anywhere in the panel.** `widgets/image.js`,
   `widgets/font.js` and `font-picker.js` contain no drag/drop handler, no
   `<input type="file">`, and no `FileReader`. (`font-picker.js`'s three `drop`
   hits are unrelated prose — "dropping the element off the DOM", "Drop
   variants the allowlist refuses".) The drop target is **new code for all
   three families**, not an extraction of an existing one.
2. **`font-source.js:30` refuses every non-string param source** —
   `if (typeof source !== "string") return false; // bytes/thunks are never
   param-supplied`. A dropped font is bytes, so it would be refused today.
3. **`image-source.js` already carries the reasoning that unblocks it**, and it
   is asset-agnostic: an `ArrayBuffer` in params cannot have arrived via a
   shared link, because a URL cannot carry megabytes.
4. **opentype.js cannot read WOFF2** — stated three times in the font-picker
   spec, which already refuses it at the allowlist.
5. **`vectors` has no function-of-params form.** `fonts` has `fontsFor(part, p)`
   and `images` has `imagesFor(part, p)`; `vectors` is passed raw as
   `part.vectors` (`jobs.js`, `bin/cli.js`). A vector control has nothing to
   drive until that exists.
6. **`partforge/ingest` exists and exports only `ingestSvg`**, with an explicit
   policy in `src/ingest.js`: *"Deliberately NOT re-exported from `partforge`
   (the main entry) or from `partforge/geometry`: this must stay unreachable
   from the geometry worker."*
7. **PR #184 violates that policy.** `imageToPng` is exported from
   `src/index.js` — the main entry. Moving it is a correction, not tidiness,
   and it removes a main-entry export (pre-1.0, shipped hours earlier).
8. **`scripts/ingest-svg.mjs` is dev-only and outside the published package**,
   carrying a happy-dom shim and a canvas stub its own comment says is kept in
   sync "by hand". This is the sharp edge an agent hits today.
9. **`worker-layering.test.js` walks the worker's static import graph** and
   fails on any module naming a DOM global — so it covers the moved file for
   free.

## 1. Architecture

Five units, each with one responsibility:

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `src/framework/ingest/registry.js` | The table: accepted media types per kind, and the converter. Pure data + lookup. **DOM-free**, so the CLI can read it without loading paper.js. | nothing |
| `src/framework/ingest/sniff.js` | Bytes → media type. Magic numbers for PNG/JPEG/TTF/OTF, an `<svg` scan for SVG. **DOM-free.** | nothing |
| `src/framework/ingest/svg-ingest.js` | SVG → partforge-vector JSON. **Exists, unchanged.** | paper.js, DOM |
| `src/framework/ingest/image-ingest.js` | Raster → PNG. **Moves** from `src/framework/image-ingest.js`. | DOM |
| `src/framework/panel/widgets/file-drop.js` | The drop target: drag/drop, file picker, paste, hover and error states. Asset-kind agnostic. | registry, sniff |

`type: "image"`, `type: "vector"` and `type: "font"` become thin shells: each
names its kind, renders its own preview, and delegates the rest.
`image-picker.js` and `font-picker.js` stay as they are — a catalog browser and
a drop target are different affordances that compose rather than merge.

**Converters load lazily, per row, on use**, so a part with no vector control
never loads paper.js and the CLI never loads a converter it does not need.

**Layering.** Everything under `ingest/` is main-thread; none of it may enter
the worker closure. `registry.js` and `sniff.js` are DOM-free so the CLI and the
registry's own tests need no DOM.

## 2. The routing already exists

The obvious design mistake here is building machinery to map a dropped file to
the right part field. It is not needed — the declaration-function pattern all
three families already use does it:

```js
{ key: "face",   type: "font"   }   →  fonts:   (p) => ({ face:   p.face   })
{ key: "relief", type: "image"  }   →  images:  (p) => ({ relief: p.relief })
{ key: "art",    type: "vector" }   →  vectors: (p) => ({ art:    p.art    })
```

The control writes a source into **its own param key**; the author's declaration
puts that key in the right field. So a registry row is three things:

```js
{ kind: "image",  accepts: ["image/png", "image/jpeg", "image/webp"], convert: imageToPng }
{ kind: "vector", accepts: ["image/svg+xml"],                         convert: ingestSvg  }
{ kind: "font",   accepts: ["font/ttf", "font/otf"],                  convert: null       }
```

`convert: null` means "used as-is, validated only" — the font case.

## 3. Drop flow

```
file dropped on a control declaring kind: K
        │
        ▼  size check (BEFORE conversion)
        ▼  sniff bytes → media type
   row for K accepts it? ──no──▶ typed error naming the right slot
        │                          or the formats that work (§5)
        ▼  yes
   convert (or pass through)
        │
        ▼  destination ladder
   onAssetUpload supplied? ──yes──▶ returns a source string → param
        │                            (blob kept in memory until it resolves)
        └── no ──────────────────▶ converted bytes → param
        │
        ▼
   ordinary rebuild
```

**After the param is written this is indistinguishable from typing a URL into
the field.** No new resolve path, no new cache path, no new worker message —
which is the property that keeps this feature from touching the build pipeline
at all.

## 4. The author / CLI path

`npx partforge ingest <file> [--out <path>] [--strokes ignore]` performs the
same three steps and **writes to disk** instead of writing a param. Same table,
same converters.

This promotes `scripts/ingest-svg.mjs` from a dev-only hack to a supported
command. The DOM the SVG converter needs comes from the same happy-dom
devDependency that script already proves works; the difference is that the shim
lives in one supported place instead of a hand-synced copy.

`scripts/ingest-svg.mjs` is **deleted**, and its documentation references
updated to the new command.

## 5. Errors

| Situation | Response |
| --- | --- |
| Wrong kind for the slot | Names the right slot — "Depth map needs an image (PNG/JPG); logo.svg is artwork — use the Artwork slot" |
| Right kind, unsupported format | Names what works (WOFF2 on a font slot; AVIF/HEIC on an image slot) |
| Conversion fails | Names the file **and the stage** — parse / convert / validate — so a malformed SVG does not read as a partforge bug |
| SVG yields no geometry | Reuses main's existing `svg-no-geometry` pattern rather than inventing a second voice |
| Upload hook rejects | Converted blob is **kept in memory**; a network or quota failure must not force a reconvert-and-redrop |
| File too large | Checked **before** conversion |
| Several files dropped | Take the first and say so — silently ignoring the rest is worse than a one-line note |

## 6. The security rule change

`font-source.js` currently refuses every non-string param source. This spec
adopts the image rule for fonts:

- **String sources** keep the full `allow` treatment — parsed-protocol
  comparison, never a substring test.
- **Byte sources bypass the allow check**, because an `ArrayBuffer` in params
  cannot have arrived via a shared link.

The reasoning must be recorded in `font-source.js` itself, as it is in
`image-source.js`, so a later reader does not "fix" it back.

This is shipped, security-relevant code. Its test must be **watched failing**
against the current refusal before it is accepted — a test that has never failed
is not evidence.

## 7. Host contract (partforge-cloud)

1. **Implement `onAssetUpload(blob, { kind, filename })`** returning a source
   string — an `https:` URL or a `pfc-asset://` token. Absent it, partforge
   falls back to bytes-in-params and still works.
2. **The converted artifact is what gets stored** — a PNG, a partforge-vector
   JSON, or the original TTF/OTF. Never the user's original SVG or JPEG.
3. **CLI parity.** Whatever the panel stores must be resolvable by server-side
   `partforge measure` / `render`, or the verify gate stops covering the part.

## 8. Testing

Pure leaves carry most of the weight, with no DOM:

- **`ingest-registry.test.js`** — media type → row; unknown → null; every kind's
  accept list.
- **`ingest-sniff.test.js`** — magic numbers for each supported type, and the
  **adversarial pairs**: a PNG named `.svg` must sniff as an image, an SVG named
  `.png` must not reach `imageToPng`. These are the cases a naive extension
  check passes.
- **`file-drop.test.js`** — happy-dom with synthetic `DragEvent`/`DataTransfer`:
  the accepted path, each rejection with its exact message, the multi-file note,
  and that a failed upload hook preserves the blob.
- **`font-source.js` byte bypass** — its own test, watched failing first (§6).
- **CLI `ingest`** — end-to-end via `execFileSync`, never a direct function
  call. This distinction already earned its keep: PR #184's CLI gap was
  invisible to a direct-boot test and only a subprocess test caught it.
- **`worker-layering.test.js`** — must keep everything under `ingest/` out of
  the worker closure, and covers the moved `image-ingest.js` for free.

## 9. Rollout

1. `vectors` gains `vectorsFor(part, p)` and the function form, mirroring
   `fontsFor`/`imagesFor`, with `jobs.js` and `bin/cli.js` call sites updated.
   **Blocking** — a vector control has nothing to drive without it.
2. `sniff.js` and `registry.js` with their tests (pure, no DOM).
3. `imageToPng` moves into `ingest/`, is exported from `partforge/ingest`, and
   is **removed from the main entry** (§ Evidence 7), with `types/index.d.ts`
   and `types/ingest.d.ts` following.
4. `file-drop.js`, then the three control types adopting it.
5. `onAssetUpload` through `mount.js` and `panel/render.js`.
6. The `font-source.js` byte-bypass rule, with its watched-failing test.
7. `partforge ingest` CLI; delete `scripts/ingest-svg.mjs`.
8. Docs, `AGENTS.md`, version bump.

## Accepted risks and non-goals

- **Removing `imageToPng` from the main entry is a breaking change** to an
  export that shipped hours earlier. Pre-1.0, near-zero blast radius, and it
  corrects a documented policy violation — but it is a break, not a no-op.
- **`font-source.js` is security-relevant** and this widens what it accepts.
  Mitigated by the recorded reasoning and the watched-failing test.
- **The SVG converter needs a DOM in the CLI.** happy-dom is a devDependency
  today; making `partforge ingest` a supported command means that shim becomes
  supported surface. If it should not ship in the published package, the CLI
  command is browser-only and `scripts/ingest-svg.mjs` stays — **open item 1**.
- **Non-goals:** WOFF2 decompression; conversion caching; a single
  `type: "asset"` control; unifying asset *storage* (images need a content
  digest because `heightfield` registers by name; vectors deliberately have none
  because the Shape2D hash covers them — `vectors.js` records that reasoning).

## Open items carried into planning

1. Whether `partforge ingest`'s SVG path ships in the published package (needs
   happy-dom as a real dependency) or stays dev-only. Resolve before §9 step 7.
2. The file-size cap, and whether it differs by kind.
3. Whether `onAssetUpload` should receive the ORIGINAL file alongside the
   converted one, so a host can archive what the user actually dropped.
