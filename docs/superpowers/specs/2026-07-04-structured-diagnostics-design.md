# Structured failure diagnostics for measure/verify (issue #27)

**Goal:** every failure an agent sees from `partforge measure`/`verify` carries
*cause + location + corrective hint*, machine-readable, so a repair loop converges
in fewer retries. Grounded in the LLM-CAD research survey
(`docs/research/llm-cad-generation-strategies.md`): structured
`(cause, location, fix)` error output cut agent repair retries 2.62 → 1.86 and
lifted success 81.5% → 100% in ablation.

**Scope decisions (user-approved):**

- Hints are **self-contained text AND carry a stable pattern ID** when an
  ERROR-PATTERNS.md entry applies (`pattern: "<id>"` citing
  `ERROR-PATTERNS.md#<id>`). Repo agents follow the ID; partforge-cloud (JSON
  only, no repo) still gets an actionable sentence.
- **Part-authored hints ship in v1**: `verify.expect.<subpart>.<metric>` accepts
  `{ expr, hint }` as well as a bare expression.
- **Crash path included**: thrown build/measure errors become structured JSON
  under `--json` and are matched against ERROR-PATTERNS.md symptom strings.
- Architecture **A**: hints/pattern IDs live in `verify.js`'s existing metric
  registries; the ERROR-PATTERNS.md parser is extracted from the #28 lint test
  into a shared module. No separate enrichment layer.

## 1. Report contract

Check objects (in `verify(...)` results, `report.verify`, and the `failures[]` /
`warnings[]` arrays) gain up to three optional fields:

```json
{
  "case": "defaults", "scope": "subpart", "subpart": "body",
  "metric": "minWall", "expr": ">=1.2", "actual": 0.82,
  "kind": "warn", "status": "warn", "pass": false,
  "message": "0.82 not >= 1.2",
  "location": [14.2, -3.1, 22.0],
  "hint": "thinnest wall at this point — increase the governing wall/thickness parameter or reduce the intersecting feature's depth",
  "pattern": "minwall-sliver-triangles"
}
```

- `location` — `[x,y,z]` in mm, only where the metric has one:
  - `minWall`: the thinnest-wall sample point (already computed by
    `src/testing/min-wall.js`, currently discarded at `measure.js:31`).
  - `overlaps` (view metric): center of each offending intersection region —
    but note the view-level `overlaps` check asserts on the *count*; the
    per-pair locations live on the overlap entries themselves (§ below).
  - Absent for whole-solid facts (bbox, volume, surfaceArea, triangleCount,
    watertight, holes) — a location would be noise.
- `hint` — present on every `fail`/`warn` status, one self-contained sentence.
  Resolution precedence: **part-authored > registry generic**.
- `pattern` — optional stable ERROR-PATTERNS.md entry ID.

Subpart facts in `measure()` reports keep `minWall` as a **number** (the
assertion DSL compares plain numbers; nothing existing breaks) and gain a
sibling `minWallAt: [x,y,z] | null`.

Overlap entries (from `assemblyOverlaps`, surfaced in `measure().overlaps`)
gain a location: `{ a, b, volume, location: [x,y,z] }` — the center of the
intersection solid's bounding box.

### Crash path

With `--json`, a thrown error in `measure`/`verify`/part-loading emits to
stdout and exits 1:

```json
{ "ok": false, "error": { "message": "<thrown message>", "pattern": "<id>", "hint": "<pattern Fix text>" } }
```

`pattern`/`hint` present only when the message matches a pattern (see § 3).
Without `--json`, the human path keeps the current stderr message and appends
one line when matched: `pattern: <id> — <Fix text>` .
Exit-code semantics are unchanged everywhere.

## 2. Hint sources

**Registry hints (generic).** `SUBPART_METRICS` / `VIEW_METRICS` in
`src/testing/verify.js` gain optional fields per metric:

- `hint: string` — generic corrective sentence (e.g. `watertight` → "a boolean
  produced an open shell — check for coplanar faces or a cut that exactly
  grazes a surface"). **Required on every registry metric** — this is what
  guarantees § 1's "hint present on every fail/warn" (the lint test asserts
  it).
- `pattern: string` — ERROR-PATTERNS.md ID when a stable pattern exists
  (e.g. `watertight` → `boolean-not-watertight`, `minWall` →
  `minwall-sliver-triangles`). Only where genuinely applicable; no forced
  mappings.
- `locate: (factsObj) => [x,y,z] | null` — how to pull a location out of the
  facts (e.g. `minWall` → `s.minWallAt`).

**Part-authored hints (specific).** In `verify.expect`, any metric expectation
may be `{ expr, hint }` instead of a bare string/number:

```js
verify: {
  expect: {
    body: {
      minWall: { expr: ">=1.2", hint: "increase `wallThickness` or reduce `twist`" },
      volume: "10cm3..80cm3",          // bare form unchanged
    },
  },
}
```

A part-authored `hint` replaces the registry hint; the registry `pattern` and
`locate` still apply. Merged profile rules (e.g. `minWall` from a DFM profile)
get the registry hint unless the part overrides that metric.

## 3. Pattern matching module

New `src/testing/error-patterns.js`:

- `parsePatterns(md) → [{ id, section, symptom, cause, fix, symptomStrings }]`
  — the fence-aware parser currently inlined in
  `test/error-patterns.test.js`, extracted verbatim; `symptomStrings` are the
  backtick-quoted literals from the Symptom line.
- `loadPatterns() → patterns | null` — reads `docs/ERROR-PATTERNS.md` resolved
  relative to the module (works from a consuming app's `node_modules`);
  returns `null` on any read error. Cached after first load.
- `matchPattern(message, patterns) → { id, fix } | null` — first entry whose
  `symptomStrings` include a substring of `message` (the #28 contract: code
  that throws must throw strings appearing verbatim in a Symptom line).
  Longest-match wins on ties.

**Never throws.** A diagnostics-layer failure must not degrade `measure`;
any internal error → `null` → the report simply lacks `pattern`/`hint`.

`test/error-patterns.test.js` imports `parsePatterns` from the new module
instead of its inline copy, and gains one assertion: every `pattern:` ID cited
in `verify.js`'s registries resolves to a parsed entry (keeps code↔doc honest,
same spirit as the existing cited-anchor check).

## 4. File-by-file changes

| File | Change |
|---|---|
| `src/testing/verify.js` | registry `hint`/`pattern`/`locate` fields; `check()` emits `location`/`hint`/`pattern`; `evaluateCase` accepts `{ expr, hint }` (normalize before the metric loop) |
| `src/testing/measure.js` | `minWall: v.value`, `minWallAt: v.location` from the min-wall result |
| `src/framework/assembly.js` | overlap entries gain `location` (intersection bbox center; the intersection solid is already in hand) |
| `src/testing/error-patterns.js` | new module (§ 3) |
| `test/error-patterns.test.js` | use shared parser; lint registry-cited IDs |
| `bin/cli.js` | `--json` crash contract; human printers append `hint`/`location`/`pattern` lines on fail/warn checks and matched crashes |
| `docs/AUTHORING-PARTS.md` | report shape documented as **the agent contract** (fields, when `location` appears, crash JSON); `{ expr, hint }` documented in the verify section |
| `docs/ERROR-PATTERNS.md` | no structural changes; consumers now actually cite IDs |

## 5. Testing

- **Unit — verify:** part-authored hint wins over registry; bare-string
  expectations unchanged; registry hint/pattern emitted on fail; `location`
  populated for minWall via `locate`; pass-status checks carry no
  hint/location noise.
- **Unit — measure:** `minWallAt` propagates on a thin-wall fixture; overlap
  `location` correct for two overlapping boxes at a known offset.
- **Unit — error-patterns:** parser round-trips the real doc; `matchPattern`
  hits for a real thrown string (e.g. the assertion-DSL `unrecognized form`
  message if patterned, else a fixture pattern), misses cleanly for garbage;
  unreadable doc → `null`, no throw.
- **Integration — CLI:** broken fixture part + `--json` → parseable JSON,
  `ok: false`, exit 1; failing verify fixture → failures carry
  `hint`, exit 1; passing part → exit 0, no diagnostics noise.

## 6. Out of scope

- Near-miss gap detection (issue #29 — separate spec; its failures will adopt
  this contract).
- partforge-cloud server-side matching (consumes this module later).
- New ERROR-PATTERNS.md entries (added organically per the #28 contract).
