# Options-object kernel calling convention — design

Date: 2026-07-17
Status: approved design, pre-implementation
Approach: dual-accept ("Approach A") — options form becomes canonical, legacy
positional stays silently accepted until contract v2.

## Problem

The kernel's most-used factory ops take runs of same-typed positional scalars —
`k.cylinder(rBottom, rTop, h)` being the worst: swapping arguments builds a
*valid wrong* solid (a cone, or a squat disc), the exact transposition error LLM
part authors make. Straight cylinders also repeat the radius, and part specs are
usually diameters, so call sites are littered with `p.od / 2`. Meanwhile the
kernel already half-believes in named options (`boredCylinder({od,h,bore})`,
`helixSweptTube({...})`, `rotateAbout({axis,deg,through})`). This spec finishes
that convention and makes options-objects the one documented way to call
multi-parameter ops — for humans and for LLMs generating parts against
KERNEL-CONTRACT.md.

## Decisions already made (with Scott)

- **Scope: multi-param ops only.** Single-argument chaining ops
  (`translate(v)`, `cut(tool)`, `rotateZ(45)`, `mirror("XY")`, `at(v)`,
  `along(dir)`, `scale(f)`) keep their current forms — wrapping them would make
  the common case worse.
- **Cylinder vocabulary: `r|d`, `r1/r2|d1/d2`** (OpenSCAD-style diameter
  support).
- **Lifecycle: Approach A.** One normalization shim; docs/parts/tests teach only
  the options form; positional removal is deferred to contract v2.
- **`box({size})` semantics: centered in X/Y, base at z=0** — the same
  canonical placement `cylinder` already has, consistent with the contract's
  "build canonical at the origin, then orient/place" idiom. `{min, max}` remains
  for explicit corners.
- **`fillet(3)` / `chamfer(1)` scalar shorthands stay valid and undeprecated**
  (params differ in type; no transposition risk). The options form replaces only
  the two-argument selector call.

## Detection rule (normative, goes in KERNEL-CONTRACT.md)

> A call is **options form** when the op receives **exactly one argument and it
> is a plain object** — not an `Array`, not a `Solid`. Any other arity or first
> argument is legacy positional form.

This one rule disambiguates every op with no key-sniffing. The load-bearing
case: `extrude({outer, holes}, h)` is positional (two arguments);
`extrude({profile, h})` is options (one plain object). "Plain object" =
`Object.getPrototypeOf(x) === Object.prototype || null`, which excludes arrays,
Solids (backend handles carry methods/prototypes), and typed arrays.

## Canonical signatures

### Kernel factory ops (options-canonical; legacy positional accepted)

| Op | Canonical options form | Legacy positional (until v2) |
|---|---|---|
| `cylinder` | `{r\|d, h, center?}` straight · `{r1, r2, h, center?}` or `{d1, d2, h, center?}` cone | `(rBottom, rTop, h, {center?})` |
| `sphere` | `{r\|d}` — `sphere(5)` stays valid, undeprecated | `(r)` |
| `box` | `{size:[x,y,z], center?}` (centered X/Y, base z=0; `center:true` also centers Z) · `{min, max}` | `(min, max)` |
| `prism` | `{points, h, twist?, scaleTop?}` | `(points2D, h, {twist?,scaleTop?})` |
| `extrude` | `{profile, h, twist?, scaleTop?}` — `profile` = points array, `{outer, holes}`, or arc profile | `(profile, h, {twist?,scaleTop?})` |
| `revolve` | `{profile, degrees?}` | `(points2D, {degrees?})` |
| `loft` | `{rings, ruled?, closed?}` | `(rings, {ruled?,closed?})` |
| `sweep` | `{profile, path, closed?, cornerRadius?, ruled?, smooth?}` | `(profile2D, path3D, opts?)` |

`boredCylinder` and `helixSweptTube` are already options-only — unchanged.
`union(solids[])` and `toSTEP(named[])` take a single array — unchanged.

### Solid ops

| Op | Canonical form(s) | Notes |
|---|---|---|
| `fillet` | `fillet(3)` · `fillet({r, edges?})` | options form replaces `fillet(3, selector)` |
| `chamfer` | `chamfer(1)` · `chamfer({d, edges?})` | ditto |
| `shell` | `shell({t, open})` | replaces `(thickness, openFaces)`; openFaces was already required |
| everything else | unchanged | `translate/at/along/rotate*/rotateAbout/mirror/scale/cut/cutAll/intersect/clone/label` + queries |

### Cylinder key rules

- Straight: exactly one of `r` / `d`. Cone: `r1`+`r2` or `d1`+`d2` (no mixing
  radius and diameter across ends; no mixing straight and cone keys).
- `h` required everywhere.
- Diameter keys are sugar: normalized to radii before the backend sees them.

## Architecture

Normalization lives at the two existing backend-agnostic seams, wrapping each
op exactly the way the current validation wrappers do:

- **`kernel-front.js` `finishKernel(k)`** — kernel factory ops. Each wrapper:
  detect options form → validate keys → destructure → call the raw positional
  implementation. The existing `scaleTop`/`revolve` validations merge into these
  wrappers (one wrapper per op, not two layers).
- **`solid-sugar.js` `addSugar()`** — `fillet`/`chamfer`/`shell` (both the OCCT
  native paths and the Manifold `KernelCapabilityError` stubs generated from
  `OCCT_ONLY_OPS`, so a core-class kernel still throws the right routing error
  when called options-style).

What falls out for free from this placement:

- **Both backends** (and any future host kernel built from this repo's helpers)
  get the convention identically; backend internals stay positional and
  untouched.
- **Manifold's solid cache** hashes the normalized positional args, so
  `cylinder({d:8,h:10})` and `cylinder(4,4,10)` share one cache entry.
- **The probe kernel** (catch-all Proxy) needs zero changes; op names are
  recorded regardless of calling convention.
- **A host implementing the contract from scratch** must implement the
  normalization itself — the contract documents the canonical forms as the
  interface; this repo's `finishKernel`/`addSugar` provide it for free, and the
  parity tests assert it.

## Validation errors

Same style as existing kernel-front errors; every distinct message gets an
ERROR-PATTERNS.md entry:

- `cylinder: pass exactly one of r/d, or r1+r2 / d1+d2` (both, neither, mixed
  straight/cone, mixed r1+d2)
- `cylinder: h is required` (and per-op equivalents: `extrude: h is required`,
  `sweep: path is required`, `loft: rings is required`, `shell: open is
  required`, …)
- **Unknown keys are an error**, with a nearest-key suggestion:
  `cylinder: unknown option "radius" — did you mean r?` Silent key-dropping is
  the worst failure mode for LLM authors; the loud near-miss message is the
  point of this feature. (Suggestion = case-insensitive match or edit-distance
  ≤ 2 against the op's key set; otherwise list the valid keys.)

## Contract & versioning

- `CONTRACT_VERSION` stays **1** — the change is additive. Removing positional
  acceptance later is the v2 event.
- KERNEL-CONTRACT.md gains a **"Calling convention"** section: the detection
  rule, the canonical-forms table, cylinder key rules, `box({size})` placement
  semantics, and one line stating positional forms are legacy-accepted until
  v2 (no runtime deprecation warning — the deprecation is enforced by docs,
  parts, and tests all showing one style).
- `kernel.js` `@typedef`s flip to options-first signatures with a one-line
  legacy note per op.

## Migration

- **Parts** (4 files, ~13 call sites): migrate to options form — these are the
  exemplars LLMs copy.
- **Tests** (~280 call sites): codemod to options form, EXCEPT a deliberate
  legacy suite (below). Mechanical, per-op regex + hand-check; vitest green is
  the gate.
- **Docs**: AUTHORING-PARTS.md op tables and every snippet rewritten
  options-only; REFERENCE-PARTS.md snippets likewise; ERROR-PATTERNS.md gains
  the new validation patterns.
- **External parts** (e.g. Drum-Machine repo): unaffected — positional keeps
  working. Migrate opportunistically.

## Testing

New `test/calling-convention.test.js` (Manifold; plus a small OCCT twin file,
since OCCT must boot in its own file) pinning:

1. **Equivalence:** for each factory op, options form and positional form
   produce identical geometry (volume/bbox) — and on Manifold, identical cache
   hashes (hit the cache with one spelling, read stats after the other).
2. **Detection rule:** the `extrude` two-argument object-profile case stays
   positional; single-plain-object calls parse as options; arrays and Solids as
   first argument never trigger options parsing.
3. **Every validation error fires** with its exact message (these messages are
   contract surface once they're in ERROR-PATTERNS.md).
4. **`box({size})` placement:** bbox = centered X/Y, min-z 0; `center:true`
   centers all three axes.
5. **Routing preserved:** options-form `fillet({r})` on the Manifold backend
   still throws `KernelCapabilityError`, and the probe still routes an
   options-form `fillet` build to OCCT.
6. **Legacy suite:** a compact set of positional calls per op, clearly marked
   as pinning the v1 compat shim (deleted at v2).

Existing `kernel-contract.test.js` / `occt-backend.test.js` parity tests extend
to assert the wrappers exist on both backends. CI smoke check
(`scripts/check-app.mjs`) covers the migrated parts end-to-end.

## Out of scope (explicitly)

- The other JSCAD-inspired ideas from this research thread (2-D
  `offsetPolygon`, `hull`/`hullChain`, `roundedCuboid`-style mesh primitives,
  `vectorText`, bbox alignment helpers) — separate specs if pursued.
- Runtime deprecation warnings for positional calls.
- Contract v2 (positional removal) — future work; this spec only reserves it.
