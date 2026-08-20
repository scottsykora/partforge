# Font picker control — design

**Date:** 2026-08-20
**Status:** approved design, pre-implementation
**Scope:** partforge framework (control type, dynamic `fonts`, catalog seam) +
lint + CLI. The partforge-cloud half (catalog proxy, vendor-on-save) is
specified here as a **host contract** in §7 and gets its own sibling spec in
that repo before implementation.

## Goal

Let the **end user of a part** — not just the authoring agent — choose a
typeface from the full Google Fonts catalog, in the control panel, and see the
geometry rebuild with it.

Today a font is a static `PartDefinition.fonts` entry: an agent runs
partforge-cloud's `fetch_web_font` tool, the bytes land in `part_assets`, and
the agent hand-writes a `pfc-asset://` token into the part source. That is an
**authoring** affordance. This spec makes the font a **parameter**.

The hybrid the product wants:

- At **save/publish**, whatever face the part's defaults reference is
  **vendored** — bytes stored, default rewritten to a `pfc-asset://` token. A
  published part is deterministic, offline-safe, and does not depend on Google
  being up.
- At **runtime**, a **non-owner** can still open the picker and change the face.
  Their pick resolves live from `fonts.gstatic.com` and is never stored.

## Decisions (settled with Scott, 2026-08-20)

| Question | Decision |
| --- | --- |
| Param value grammar | **A plain font source URL** — `https://fonts.gstatic.com/s/…​.ttf` for a live pick, `pfc-asset://<uuid>/<file>.ttf` for a vendored one. **No new grammar in the resolver**: both are already valid `fonts` sources today. |
| Version pinning | Falls out of the decision above. gstatic URLs carry the family version (`/v48/`) and are served `immutable, max-age=31536000`, so the URL *is* the pin. No family-name-plus-version ref to re-resolve, and no drift. |
| Where the catalog lives | Host-supplied via `mount(part, { fontCatalog })`. partforge never learns the word "Google". |
| What the worker needs | **Nothing new.** The worker only ever sees a URL, which `resolveFonts` already fetches. The catalog is a main-thread, panel-only concern. |
| `fonts` shape | Gains a function form: `fonts: (p) => ({ name: source })`, resolved *after* `resolveParams`. Static object form unchanged. |
| Registration key | `kernel._fonts` moves from name-keyed first-write-wins to **keyed on the resolved source**, or the first pick sticks forever (see §5). |
| No provider | A `type: "font"` control with no `fontCatalog` degrades to a URL text field. Demo apps keep working. |
| Runtime size cap | 4 MB for a live pick (the catalog's p90 is 990 KB; 192 families exceed 1 MB, Noto CJK reaches 51 MB). Vendored assets keep cloud's existing 20 MB cap. |
| Variable fonts | Out of scope. The catalog's default (static TTF) capability only — opentype.js cannot read WOFF2, and VF axis selection is a separate feature. |

## Evidence (probed 2026-08-20)

The design leans on four facts, all verified live rather than assumed:

| Endpoint | Key? | CORS | Consequence |
| --- | --- | --- | --- |
| `fonts.gstatic.com/s/…​.ttf` | no | `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`, `max-age=31536000` | The **worker fetches font bytes directly**. No proxy, no postMessage channel, no new byte budget. |
| `www.googleapis.com/webfonts/v1/webfonts` | **yes** (403 without) | echoes `Origin` | Catalog needs the host's key. Cloud already holds one and caches the answer 24 h. |
| `fonts.google.com/metadata/fonts` | no | **no ACAO**, `same-site` | Richer (1942 families, popularity/trending/designers) but server-only and undocumented. Fallback, not the primary. |
| `fonts.googleapis.com/css2?…&text=` | no | `*` | Previews only — serves WOFF2, which opentype.js cannot parse. Never the geometry path. |

Also: all 1942 catalog families report `isOpenSource: true`, so vendoring needs
no per-family license triage — the existing `LICENSE_NOTE` stance in cloud's
`webFonts.js` covers the whole catalog. Neither OFL nor Apache 2.0 requires
visible attribution in a product; license text is required only when
redistributing font *files*, which is the vendoring path, not the STL.

## 1. The `"font"` control type

One new entry in each half of the widget registry — the extension point
`panel/widget-specs.js` was built for:

```js
// panel/widget-specs.js
{ type: "font", kind: "control", fields: [...AUTHOR_COMMON, "allow", "preview"] },
// AUTHOR_EXTRAS
font: ["allow", "preview"],
```

```js
// panel/widgets/index.js
import { makeFont } from "./font.js";
export const WIDGET_FACTORIES = { …, font: makeFont };
```

`test/framework/panel/registry.test.js` already proves the two registries agree,
and lint derives its accepted-field list from `fields`, so neither needs a
parallel edit.

Authored shape:

```js
{ key: "face", type: "font", label: "Typeface",
  description: "The typeface the engraved text is cut in.",
  allow: ["gstatic", "asset"],   // optional source allowlist; default both
  preview: "Hamburgefons" }      // optional preview string in the picker list
```

`defaults.face` holds a source URL like any other control's default holds a
number. Everything downstream — presets, undo/redo, the params hash, `when`
conditions, syncValues — works unchanged, because the value is a scalar string.

### Opting out is the default

The picker appears **only** where an author writes a `type: "font"` control.
Nothing about this feature reaches a part that doesn't ask for it. Three
postures, all first-class:

1. **Fixed typeface — unchanged, and still the common case.** Declare the
   static `fonts` object exactly as today (a bundled file, an HTTPS URL, or a
   `pfc-asset://` token an agent or a drag-drop attached) and call
   `k.text2d(str, { font: "label" })`. No font control, no catalog, no network
   at build time beyond the source itself. Every existing part is already this,
   and keeps working with no edit.

2. **Curated choice.** A plain `select` whose option values are font sources —
   the author vendors two or three faces and the user picks among them. This
   needs the function-form `fonts` from §2 (the value is still a param) but no
   `fontCatalog` and no picker UI. This is the right shape for a part with a
   house style, and it is what a published part degrades to if the host chooses
   not to expose a catalog.

3. **Full picker.** `type: "font"` plus a host-supplied `fontCatalog`.

The `allow` field narrows even posture 3 — `allow: ["asset"]` gives a picker
over the part's own attached fonts with no Google catalog behind it.

The framework requirement is only that a font can be a *parameter*. Whether
that parameter is user-editable at all, and by what UI, stays the author's call.

### Rendered form

The closed widget is a button showing the current face, rendered **in that
face**. Clicking opens the picker (§6). With no `fontCatalog`, the widget is a
`text` input carrying the same value.

Deriving the label from the value:

- `pfc-asset://<uuid>/roboto-700.ttf` → `Roboto 700`, from the filename.
  Cloud's `fetchWebFont` already slugs stored files as
  `<family>[-<variant>].ttf`, so the label round-trips for free.
- A gstatic URL → looked up in the catalog the picker already holds.
- Anything else → the filename.

## 2. Dynamic `fonts`

`PartDefinition.fonts` gains a function form:

```js
defaults: { face: "https://fonts.gstatic.com/s/roboto/v48/….ttf", text: "PARTFORGE" },

fonts: (p) => ({ face: p.face }),          // NEW — a function of resolved params

build: (k, p) => k.text2d(p.text, { font: "face", size: 8 }),
```

The static object form is untouched and remains the right thing for a part with
a fixed typeface.

### Resolution order

`jobs.js` currently preloads fonts **before** `resolveParams`. That inverts:

```js
// jobs.js — today
if (part.fonts && kernel._fonts) { … resolveFonts(part.fonts) … }
if (part.imports) await ensureImports(…);
const { p, d } = resolveParams(part, msg.params);

// jobs.js — after
const { p, d } = resolveParams(part, msg.params);
if (part.fonts && kernel._fonts) {
  const decl = typeof part.fonts === "function" ? part.fonts(p) : part.fonts;
  … resolveFonts(decl) …
}
if (part.imports) await ensureImports(…);
```

`resolveParams` is pure and cheap, and already runs inside the same `try` so a
throwing `derive` posts an error rather than killing the worker turn. Moving it
two lines earlier changes nothing else — but it does mean a throwing `derive`
now precedes font resolution, which is the correct order anyway (a part whose
derive is broken should not spend a network round trip first).

The same reorder lands in `src/testing/manifold.js`, `src/testing/occt.js` and
`bin/cli.js`. `nodeAssetSources()` keeps working: it takes the *resolved* decl
object, so it simply moves downstream of the function call.

### Progress

A live pick puts a 50–990 KB download on the critical path of the first build
after a change. `jobs.js` posts a free-form progress phase before resolving:

```js
onProgress("fetching font");
```

which `status-ui.js` renders as `fetching font…` in the existing busy chip. No
new protocol.

## 3. The catalog seam

```js
mount(part, {
  createWorker,
  fontCatalog: {
    // Free-text search over the catalog. Returns at most `limit` entries.
    async search(query, { limit = 200 } = {}) {
      return [{
        id: "Roboto",              // opaque to partforge
        family: "Roboto",
        category: "sans-serif",
        variants: [{ variant: "regular", label: "Regular", url: "https://fonts.gstatic.com/s/roboto/v48/….ttf", bytes: 168_412 },
                   { variant: "700",     label: "Bold",    url: "…", bytes: 168_930 }],
        menuUrl: "https://fonts.gstatic.com/s/roboto/v48/….ttf",  // name-only subset, for the list row
      }];
    },
  },
});
```

The provider returns **URLs the panel writes straight into `params`**. There is
no `resolve(ref)` round trip, because there is no ref — the URL is the value.
A pick is instant once the catalog is in hand.

A second, optional method earns its place for one reason found during planning:

```js
    // source URL → what to call it. Optional; the widget falls back to the
    // filename when absent.
    describe(source) { return { family: "Playfair Display", variant: "700" }; },
```

A gstatic file URL is `…/s/playfairdisplay/v37/**abcdef**.ttf` — the filename is
a **content hash, not the family name**. So the closed control cannot label a
live-picked face from its value alone; only the catalog knows. `describe` is
that lookup, and the host already holds the catalog it needs.

The vendored path needs no such help: cloud's `fetchWebFont` stores files as
`<family-slug>[-<variant>].ttf`, so `pfc-asset://…/playfair-display-700.ttf`
labels itself. A provider that omits `describe` degrades to the filename, which
is correct for vendored values and merely ugly for live ones.

`menuUrl` is the v1 API's `menu` field: a TTF subset containing only the glyphs
of the family's own name, a few KB, hosted on gstatic with the same permissive
CORS. It is exactly what a picker list row needs, and it means the list renders
without the CSS API and without a key.

partforge ships **no** provider. `src/parts/nameplate.js` gains a `type: "font"`
control to exercise the degraded text-field path in the dev apps; the real
provider is cloud's.

## 4. Where each layer may fetch

**Correction (2026-08-20, during planning).** An earlier draft of this section
put a host allowlist on `resolveFonts` itself. That is wrong and would have
shipped a breaking change inside a feature: `AUTHORING-PARTS.md` documents
`fonts: { label: "https://cdn.example.com/fonts/Courier-Prime.ttf" }` as a
supported source, and a global allowlist refuses it. The guard belongs
somewhere else, for a reason worth stating plainly:

> **An author-declared `fonts` source is code. A picker-committed param value
> is user input.** They do not deserve the same trust, and only the second one
> needs a guard.

So:

| Layer | Fetches | Constraint |
| --- | --- | --- |
| Panel (main thread) | catalog search, `menuUrl` previews | whatever the host's provider does |
| Geometry worker, **author-declared** source | any `fonts` source, as today | **none — unchanged.** No existing part changes behavior. |
| Geometry worker, **param-supplied** source | the picked font URL | the bound control's `allow` list |

`allow` is a field on the `type: "font"` control (§1) and takes any of:

- `"https"` — any `https:` URL. **The default.** Permissive, but it does close
  `file:`, `http:`, `data:` and `blob:`, which is the whole cheap win.
- `"gstatic"` — `fonts.gstatic.com` only.
- `"asset"` — the host's own asset origin (cloud's `pfc-asset://` tokens and the
  URLs they resolve to).

Enforced in two places, because they close different holes: the **widget**
won't commit an out-of-`allow` value (the UI path), and **param resolution**
re-checks values bound to a font control before they reach `resolveFonts` (the
share-link path — a param arriving in a URL never passed through the widget).
A rejected value falls back to `defaults[key]` and posts a named warning; it
never becomes a fetch.

The threat this closes is modest — a crafted share link causing a cross-origin
GET whose response is only ever handed to opentype.js — but it costs one
predicate, and leaving a user-controlled string to become a fetch URL
unchecked is the kind of thing that is embarrassing to explain later.

Direct worker fetches to `fonts.gstatic.com` remain a posture change for
partforge-cloud, where source bytes currently reach the worker only by
postMessage; §7 records it as such.

## 5. Registration and cache correctness

The load-bearing bug. Today:

```js
for (const [name, buf] of bufs)
  if (!kernel._fonts.has(name)) kernel._fonts.set(name, parseFont(opentype, buf, name));
```

Name-keyed, first-write-wins. With a static `fonts` that is correct and cheap.
With a picker it is fatal: the name stays `"face"` across every pick, so the
**first** font a worker ever parses is the only one it will ever use, silently,
for the life of that worker.

The fix keys registration on the resolved source:

```js
kernel._fontsBySource ??= new Map();   // source string → parsed font
…
for (const [name, { source, buf }] of bufs) {
  let f = kernel._fontsBySource.get(source);
  if (!f) { f = parseFont(opentype, buf, name); kernel._fontsBySource.set(source, f); }
  kernel._fonts.set(name, f);          // name → parsed, rewritten every job
}
```

`_fonts` stays the name→font map `kernel-front.js` reads, so `text2d`'s lookup
and its unknown-font error are untouched. `_fontsBySource` is the parse memo,
and it is the one that must not be name-keyed.

`resolveFonts`'s own memo (`asset-resolve.js`, keyed by source identity) is
already correct for this: a URL string is its own key, so two picks are two
entries and a re-pick of a previous face is a cache hit.

**Downstream caching needs no work.** `kernel-front.js:89` records why: `text2d`
builds `k.shape2d(glyphContours)` and the Shape2D hash keys on actual glyph
coordinates, so a different font is a different cache entry automatically. And
the font URL is a `param`, so the params hash changes too.

**Mixed-backend parts fetch the font twice**, once per worker — the same
double-residency `AUTHORING-PARTS.md` already documents for `imports`. At
≤ 4 MB this is accepted, not mitigated.

## 6. The picker UI

The largest single chunk, and the one being spiked before this section is
final. Constraints it must satisfy:

- Lives in the 300 px rail, and below `RAIL_NARROW_BREAKPOINT` (720 px) inside
  the single visible pane. It cannot be a floating panel that assumes a desktop
  viewport.
- ~1942 families. Virtualized list, search-as-you-type over family name, filter
  by the five categories (Sans Serif 717, Display 467, Handwriting 358, Serif
  349, Monospace 51), sort by popularity.
- Each row renders the family name in its own face, via a `FontFace` built from
  `menuUrl`. Rows load their face lazily on scroll into view; a row that has not
  loaded shows the name in the panel font. No layout shift — reserve the row
  height.
- Variant (weight/style) is a second, smaller choice once a family is picked,
  because it changes the value's URL.
- Committing writes the variant URL to `params[key]` through the normal
  `onCommit` path, so undo/redo and preset-divergence behave like any control.

### Settled by the spike (`spike/font-picker.html`, 2026-08-20)

The spike runs the real catalog (1,942 families) with real faces loading from
the CSS API, with live A/B toggles for each open question. Decisions, made with
Scott against the running spike:

- **Takeover, on every width.** The picker fills the rail on desktop and the
  pane below the breakpoint — not an inline expansion. Choosing a typeface is a
  browse task, not a slider nudge; it earns the whole surface, and one layout
  for both widths removes a mode from the widget.
- **Row content: family name in its own face, plus a mono caption**
  (`18 styles · sans`). The name in its own face is what makes the list
  scannable; the caption carries the two facts that decide a click. The
  sample-string-per-row variant is rejected — every row reads identically and
  the family name gets demoted to a caption.
- **Density: comfortable (44 px + caption).** Compact fits three more rows and
  reads as a settings list rather than a type specimen.
- **Variants: a second step, animated — but only when there is a choice.** The
  weight list slides in from the right (`transform` + opacity, 260 ms, with the
  browse pane parallaxing back); `prefers-reduced-motion` drops the transition.
  Rendering all 18 weights of Montserrat as full sample lines is genuinely
  useful and cannot fit in a row. **A single-variant family never steps in** —
  the row click is the selection, and the list stays put. This is not an edge
  case: **1,036 of the 1,942 families ship exactly one face**, so the majority
  of picks would otherwise land on a one-row pane the user immediately backs
  out of. A `type: "font"` implementation that forgets this will feel broken
  more often than it feels right.
- **Picking a weight does not leave the step.** You audition weights against
  the live geometry — the plate rebuilds on each click while the list stays
  put. Committing and navigating are separate actions, and conflating them
  makes comparing two weights a four-click round trip.
- **A `Done` button closes the picker**, in a footer shared by both panes
  alongside the live selection summary (`Montserrat · ExtraBold · 736K`). The
  footer sits below the sliding pane box, not inside it, so Done is reachable
  from either step. `Esc` steps back from variants, then closes.
- **Size belongs in the row** (`498K`, `VF 9365K`). Noto Sans JP announcing
  9.4 MB in the list is better than a refusal after the click.

Two implementation notes the spike paid for, both of which will recur:

- The virtualized list must reconcile on **(index, family)**, not index alone —
  after a search the same index holds a different family, and an index-keyed
  row keeps rendering the old one.
- The sliding panes need a **positioned** `.picker`; without it the variants
  pane escapes its container and fills the rail.

**Still open:** whether the category filter row earns its space (search alone
covers most intent), and whether the closed control shows the face at a fixed
15 px or at the part's actual cap height.

## 7. Host contract (partforge-cloud)

Specified here so the framework seam is designed against something real. The
cloud-side spec is a follow-up in that repo.

### Catalog endpoint

`GET /api/web-fonts?q=<query>&limit=<n>` over the catalog object
`createWebFontCatalog` already holds — same instance cache, same 24 h TTL, same
hardcoded hosts. It projects the v1 response into the provider shape of §3 and
drops variants whose file exceeds the runtime cap. The API key never leaves the
server. Roughly 60 lines on top of what exists.

Rejected: shipping a referrer-restricted key to the client. The v1 API is
CORS-enabled so it would work, but it publishes the key and gives up the
server-side cap and host pinning for nothing.

### The hybrid

**At save / publish (owner path).** The server walks the part's `defaults` (and
every `preset` target) for values that are gstatic URLs, and for each one:

1. downloads it through the existing `fetchWebFont` write path — sfnt magic
   check, size cap, content-addressed `source/` key, dedupe to an existing row;
2. rewrites the stored default to the resulting `pfc-asset://` token.

So a published part's default face is always vendored. The part builds with
Google unreachable, in CI, in the CLI, and a year from now. This reuses the
write path unchanged — a picked font is stored exactly like a dropped one or an
agent-fetched one.

**At runtime (any viewer).** The picker is live for everyone. A non-owner's pick
writes a gstatic URL into their session's params; the worker fetches it
directly (CORS confirmed above) and nothing is stored. The pick is theirs, not
the part's.

**On fork.** A fork's first save runs the same vendoring pass, so a non-owner
who forks keeps their chosen face permanently, in their own copy, at their own
storage cost.

This is the whole hybrid: **vendored is the part's font; live is the viewer's
font.** No per-visitor storage, no anonymous write path, no quota surprise.

### Sandbox

Cloud's CSP is `frame-ancestors 'self'` only — no `connect-src` — so the worker
reaching gstatic works today with no header change. The framework-side host
allowlist (§4) is what keeps that from being a blanket grant.

### Prompts

The essentials line telling the agent it "cannot upload a `.ttf`/`.otf`" is
already stale as of the file-import work. This adds one more correction: when a
part's text should be user-changeable, the agent declares a `type: "font"`
control and a function-form `fonts`, rather than hardcoding one face.

## 8. Lint, CLI, oracle

**Lint** gains two rules:

- `font-control-not-in-fonts` (error) — a `type: "font"` control whose `key` is
  not read by a function-form `fonts` is dead: the picker writes a param nothing
  resolves. This is the font analogue of `control-key-not-in-defaults`.
- `font-source-host` (warning) — a `fonts` default that is neither a
  `pfc-asset://` token, a relative/bundled source, nor an allowlisted host. It
  will fail at fetch time; saying so statically is cheaper.

Lint stays kernel-free and dependency-free, so both rules read the authored tree
only.

**CLI.** `partforge measure|render|lint` work unchanged: a function-form `fonts`
is called with the resolved defaults, and a gstatic URL is fetched over the
network in Node exactly as an `https://` font source is today. A vendored
`pfc-asset://` default is the offline-safe case and the one CI should see.

**Oracle.** No change, with one authoring note for `AUTHORING-PARTS.md`: a
`verify` block on a text part is font-sensitive, because glyph advance widths
differ by family. Assertions on text bbox should be bands, not points — and
`verify` runs against `defaults`, which post-publish is the vendored face, so
the gate is stable even though the control is not.

## 9. Testing

- `resolveFonts` with a function-form decl: called with `p`, resolved after
  `derive`, and a throwing `derive` surfaces as a job error not a hang.
- **The stale-name regression**: build with font A, rebuild the same part with
  font B in the same kernel, assert the geometry differs. This is the §5 bug and
  it needs a test that would have caught it.
- Re-picking a previously used face is a resolver cache hit (no second fetch).
- Host allowlist: a disallowed source throws before fetching, naming the host.
- Widget registry parity (existing `registry.test.js` covers the new type once
  both halves are added) and the no-provider text-field degradation.
- Lint: both new rules, positive and negative.
- `test/worker-layering.test.js` must still pass — the picker is main-thread
  only, and nothing in the worker graph gains a DOM or `node:` import.
- A smoke app: `nameplate.html` with a `type: "font"` control, driven through
  `scripts/check-app.mjs`.

## 10. Rollout

1. Framework changes land behind nothing — a part without a `type: "font"`
   control is unaffected, and the static `fonts` form is untouched.
2. **Bump `package.json` on the feature branch** (AGENTS.md § Releasing — the
   quiet failure mode is forgetting, and the version cannot be reused).
   `fonts`-as-a-function and a new control type are additive: a minor.
3. `docs/AUTHORING-PARTS.md`: the function form in the `PartDefinition` table,
   `"font"` in the control-types table, the font-sensitivity note under
   `verify`.
4. Cloud follows: pin the new partforge, regenerate the prompt corpus, then the
   catalog endpoint + vendor-on-save.

Reverse skew is safe — old cloud with new partforge simply has no provider, and
new cloud pins the version it needs.

## Accepted risks and non-goals (recorded)

- **A live pick depends on Google.** Mitigated for published parts by
  vendor-on-save; unmitigated, by design, for a viewer's own runtime pick. A
  failed fetch surfaces as the resolver's existing "fetch failed (404) for …"
  error, which already names the source.
- **The param value is a long URL.** Visible in saved params and share links. If
  that proves unpleasant, a `gfont:` sugar can be added later without touching
  the resolver, because the resolver never has to understand it.
- **A viewer's pick is not reproducible from a share link** unless the link
  carries the param, in which case it is — the URL is the version pin.
- **Double fetch on mixed-backend parts** (§5), inherited from the imports path.
- **No variable-font axis control.** Static instances only.
- **No WOFF/WOFF2.** opentype.js cannot read them; refused at the allowlist with
  a named error, matching cloud's existing intake stance.
- **No per-family license text surfaced in the UI.** All 1942 families are
  open-licensed and neither OFL nor Apache requires visible attribution; the
  vendoring path is where license text would matter and cloud's `LICENSE_NOTE`
  follow-up already tracks it.
- **Non-goals:** a font-management UI, uploading a font *through* the picker
  (drag-drop already covers that), non-Google catalogs, text shaping beyond
  what `text2d` does today.

## Open items carried into planning

1. Whether the category filter row earns its space (see §6).
2. Whether `allow` (source allowlist per control) earns its place in v1 or
   should wait for a second caller.
3. Whether the runtime cap belongs in the framework (a hard refuse) or only in
   the host's catalog projection (drop oversized variants from search). Leaning
   both — the projection for kindness, the framework for safety.
4. Whether `nameplate.js` or a new `font-picker.js` part is the in-repo
   reference. Leaning `nameplate.js`, since it is already the `text2d` reference
   and a picker is what it always wanted.
