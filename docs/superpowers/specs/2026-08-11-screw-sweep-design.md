# `k.screwSweep` — threads as a kernel op, and the docs that make it findable

Date: 2026-08-11
Status: approved

## Problem

An agent asked to build a screw reference part could not produce a clean thread.
It ground on `helixSweptTube` — the op whose name matches the goal and whose
semantics do not (circular profile only, frenet frame that rolls the tooth). The
technique that works, `k.extrude({ profile, h, twist })` with a polar-mapped
cross-section, succeeded immediately once handed to it.

This is not a retrieval failure. Three things compounded:

1. **The insight is absent from the docs.** "A twisted extrude of a polar-mapped
   axial profile is exactly a screw" is a mathematical identity, not a documented
   fact. `AUTHORING-PARTS.md:306` describes `twist` as "degrees over the height",
   exemplified by a twisting vase — it reads as decorative.
2. **`helixSweptTube` is an active decoy.** It sounds correct, is wrong, and
   carries no warning. Absence makes an agent search; a plausible wrong attractor
   makes it commit.
3. **The doc is indexed by API surface, not by goal.** 1,990 lines with no
   "how do I make a helical feature" entry.

An undiscoverable technique is equivalent to an absent one in an agent-authored
workflow. The fix is therefore both a kernel op (the retrieval affordance) and
documentation (the decoy removal and the recipe).

## What testing established

The design was validated against both real kernels before being written. Four
findings changed it; they are recorded here because they are not obvious and
re-deriving them is expensive.

**1. The polar map is exact.** For an axial profile `[[r, z], …]` and pitch `p`,
mapping each point to `ψ = −360·z/p` and extruding to `h = p·turns` with
`twist = 360·turns` reproduces screw motion exactly. Measured: bbox `10×10×9`
against an expected `10×10×9`; the crest advanced `−70.0° → +19.8°` over a
quarter pitch (`+89.8°`, i.e. exactly `360°/pitch`); `lefthand` mirrors it to
`+70.0° → −19.8°`.

**2. Densification is mandatory.** The map sends profile *points* to polar, but
the *edges* between them become straight chords where the true surface needs
spiral arcs. Undensified, a 6-point ISO tooth loses 42% of its volume:

| profile pts | polar step | thread volume | error |
|---|---|---|---|
| 5 | — | 223.55 | −42% |
| 21 | 20° | 378.08 | −1.3% |
| 39 | 10° | 381.90 | −0.25% |
| 74 | 5° | 382.73 | −0.03% |
| 183 | 2° | 382.85 | converged |

A 5° step is the chosen density: it converges to 0.03% and matches Manifold's
existing twist resolution (`nDiv = ceil(|twist|/5)` in `manifold-backend.js:265`)
exactly, so axial and angular sampling agree.

**3. The tooth-plus-union formulation breaks OCCT, silently.** Building the
thread as a thin helical sliver and unioning it onto a core cylinder produces
correct geometry on Manifold and destroyed geometry on OCCT:

| turns | OCCT extrude | OCCT union | result |
|---|---|---|---|
| 2 | OK 191ms, vol 191.36 | OK 3826ms, vol **165.31** | = bare core; thread dropped |
| 6 | OK 268ms, vol 574.09 | OK 8967ms, vol **0.00** | empty solid |

The empty solid still exported to STEP without error (2 KB, 20 entities). An
undensified variant hung OCCT for over 15 minutes. The extrude itself is never
the problem — the boolean against a near-self-touching helical sliver is.

**4. The periodic formulation avoids the boolean entirely and works everywhere.**
A profile that spans exactly one pitch and starts and ends at the same radius
maps to a filled "cam" cross-section that already encircles the axis. Twist-
extruding it yields the whole threaded body in one op:

| turns | Manifold vol | OCCT vol | genus | STEP |
|---|---|---|---|---|
| 2 | 195.18 | 195.18 | 0 | 621 KB / 0.5s |
| 6 | 585.54 | 585.55 | 0 | 1.4 MB / 0.8s |
| 12 | 1171.07 | 1171.08 | 0 | 2.6 MB / 1.0s |

Volume parity to five significant figures across backends, with no boolean.
This is the primary form the op and the docs teach.

**Caveat found in passing:** OCCT reports a loose bounding box on twist-extruded
solids (`14.42 × 14.42` where Manifold reports the true `10.00 × 10.00`),
because it derives the box from the B-spline control hull rather than the
surface. Volume is exact; bbox is not. A `verify` block asserting bbox on a
screw part will disagree between backends.

## The op

Options-only, like `boredCylinder` and `helixSweptTube` (no positional legacy
form to preserve):

```js
k.screwSweep({ profile, pitch, turns, lefthand })
```

- **`profile`** (required) — a closed `[[r, z], …]` contour in the axial
  half-plane, the same lathe convention `revolve` uses. There is one
  lathe-profile idea in the kernel, not two.
- **`pitch`** (required) — axial rise per turn, mm.
- **`turns`** (required) — number of turns; `h = pitch · turns`.
- **`lefthand`** (default `false`) — mirrors the handedness.

Dropped from the original proposal, each against an existing convention:

| dropped | reason |
|---|---|
| `axis: "+Z"` | primitives build along +Z from z=0, then `.along(dir).at(v)` |
| `z0` | same; `.at()` covers it (`helixSweptTube` carries `z0` only for legacy) |
| `chordTolerance` | faceting follows the global `quality` LOD; a per-call tolerance would break cross-backend parity and fragment the solid cache. Subdivision itself is *not* dropped — see finding 2 — only its per-call knob. |
| `shading` | an imported/extruded surface with no registered policy already shades `SMOOTH` (35° crease, lines on same-surface creases), so tooth corners crease and 5° tessellation seams do not |

### Semantics

Two profile forms, distinguished by axial extent:

- **Periodic (extent == pitch)** — the recommended form. First and last radius
  must be equal; the duplicate wrap point is dropped before mapping. Produces a
  complete threaded body needing no boolean.
- **Sub-pitch (extent < pitch)** — a bare helical ridge, to be unioned by the
  caller. Supported, but the OCCT boolean hazard of finding 3 is documented
  against it.

Validation, in `sweep.js`'s house style (name the problem, name the fix):

- axial extent > pitch → throws, "turns would interpenetrate"
- extent == pitch with unequal first/last radius → throws, "a full-pitch profile
  must be periodic"
- `pitch > 0`, `turns > 0`, radii ≥ 0 (matching `revolve`'s rule)

### Implementation

A compound in `kernel-front.js`, beside `boredCylinder` / `torus` /
`roundedCylinder`. Densify each profile segment to a 5° polar step, map to the
transverse section, call `k.extrude`. **No backend code**: both backends
implement twist natively (`manifold-backend.js:265`, `occt-backend.js:445`), and
STEP gets a real twisted B-rep rather than a faceted loft.

Parity class: **within tolerance, not by construction.** The densified polygon is
shared bit-for-bit, but Manifold then facets the twist at 5°/division while OCCT
builds an exact B-spline. Measured agreement is five significant figures of
volume (finding 4); the contract prose must state this the way the `hull` and
`ruled:false` notes already do, rather than claiming construction parity.

### Documented limits

Ends are flat z-planes — correct for a threaded rod; cut a cone for a lead-in
chamfer. Not suitable for springs or augers, which need end faces perpendicular
to the profile plane. Those remain available later via a mesh-based
implementation under the same name (additive, no rename — the contract forbids
renames, which is also why the op is named for the *motion* rather than
`thread`).

## Documentation changes

These are the fix for the original failure, not an afterthought.

1. **Kill the decoy.** `helixSweptTube`'s row in `AUTHORING-PARTS.md:315` and
   `KERNEL-CONTRACT.md:189` gains: circular profile, frenet frame, *not for
   threads — see `screwSweep`*.
2. **New "Helical & threaded features" recipe** in Profiles & patterns
   (`AUTHORING-PARTS.md:1015`), modeled on the torus entry already there: the op,
   a worked ISO-ish thread, and the hand-rolled twist-extrude equivalent so the
   identity is on the record. Carries *screw / thread / helix / helical* for grep.
3. **Contract op-table row.** `kernel-contract.test.js:52` enforces this — adding
   to `KERNEL_OPS` fails the suite until the doc names the op.
4. **`ERROR-PATTERNS.md` entry** for the OCCT boolean hazard (finding 3): a
   thread that vanishes or exports an empty STEP, mapped to cause and fix
   (use the periodic form).
5. **Reference part** `src/parts/screw.js` — the doc exemplar and CI coverage.

## Wiring

`kernel.js` (`KERNEL_OPS` + typedef) · `op-options.js`
(`passThrough("screwSweep", ["profile","pitch","turns","lefthand"],
["profile","pitch","turns"])` + semantic check) · `op-options.test.js:92` name
list · `calling-convention.test.js` required-key throw · new
`test/screw-sweep.test.js` · `package.json` 0.51.0 → 0.52.0.

Additive per the contract's versioning rules: no `CONTRACT_VERSION` bump, minor
npm release.

## Testing

- Geometry (Manifold): bbox, volume against the converged reference, `genus === 0`,
  crest advance `+90°` per quarter pitch, `lefthand` mirrors.
- Densification: volume within 0.1% of the 2°-step reference.
- Validation: over-pitch profile throws; non-periodic full-pitch profile throws.
- Backend parity (own file — OCCT and Manifold must not boot in one process):
  volume agreement within tolerance at 2 / 6 / 12 turns.
- Calling convention: required keys, unknown-key rejection.

## Risks carried into the plan

- **Union of a periodic screw rod with a hex head on OCCT** is untested. Finding
  3 was a sliver-shaped operand, so a filled rod may be fine — but a bolt is the
  obvious next part and this must be verified early.
- **OCCT loose bbox** on twisted solids: decide whether it is documented, or
  worked around in the oracle.
- **Left/right volume asymmetry** measured at 0.5% on Manifold (515.44 vs
  518.03) — but measured *before* densification, on a profile now known to be
  42% wrong, so the number carries no information. Re-measure under the periodic
  densified form; treat as unknown until then.

## Out of scope

Springs, augers, multi-start threads, thread run-out/lead-in tapers, and the
OCCT `BRepOffsetAPI_MakePipeShell` route (reachable without forking replicad via
`getOC()`, but unnecessary now that the composition achieves cross-backend
parity with an exact B-rep).
