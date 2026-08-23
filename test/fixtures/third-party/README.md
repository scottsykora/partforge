# Third-party STL corpus (wanted, not yet collected)

`test/describe-roundtrip.test.js` discovers every `*.stl` file in this directory and
runs `describe` against it. Right now the directory is empty, so that block of tests
resolves to a single explanatory skip — not a silent pass, and not a failure. Drop the
files below in and the coverage appears with no code change.

## Why this exists

Every other round-trip test in that file feeds `describe` a mesh partforge itself just
built: our own tessellation, our own chord tolerance, no re-meshing, never
non-manifold. That is the easiest input class in existence for a mesh oracle. It proves
the describer agrees with its own kernel's output — it proves nothing about whether it
survives a file that actually arrived from somewhere else.

Real downloaded STLs are typically decimated, re-meshed by whatever tool exported them,
and occasionally slightly non-manifold at a seam. Until this corpus exists, the suite is
green against a describer that has only ever seen its own kind of mesh.

## What to add

Three permissively-licensed (**CC0** or **CC-BY**) STL files, chosen to span the v1
feature vocabulary (see `docs/AUTHORING-PARTS.md` and `src/framework/oracle/describe.js`):

1. **A prismatic machined bracket with holes** — flat faces, right-angle bends or ribs,
   a handful of round through-holes. Exercises `detectPrismatic` and `detectHoles`.
2. **A turned (lathed) axisymmetric part** — a shaft, standoff, or knob with a single
   rotational axis. Exercises the sweep/revolve detection path.
3. **A printed enclosure with a shelled wall** — a box-like case with a constant-thickness
   cavity (a real FDM/SLA design, not a CAD-perfect shell). Exercises the shell/thin-wall
   reasoning and gives the describer a mesh that is plausibly non-ideal (printed and
   possibly re-scanned or re-exported rather than exported straight from the CAD kernel
   that made it).

Good sources: Thingiverse (filter by CC0/CC-BY), Printables (filter by licence),
GrabCAD (check the individual model's licence — many are not CC-BY/CC0), or any other
model repository whose licence page you can point to directly. Avoid anything under a
non-commercial or share-alike variant, and avoid anything without an explicit licence
statement.

Keep each file small (a few hundred KB to a few MB) — this is a test fixture, not a
showcase model. Binary STL is fine; the parser (`src/framework/geometry/stl-parse.js`)
reads both binary and ASCII STL.

## Recording provenance

Fill in one row per file below. This table is the licence audit trail — a file added
without a row here should be treated as not actually added.

| File | Source URL | License | Notes |
|------|------------|---------|-------|
| _(none yet)_ | | | |

## Adding a file

1. Download the STL, verify its licence page states CC0 or CC-BY, and drop it in this
   directory.
2. Add a row to the table above with the direct source URL and the exact licence.
3. Run `npx vitest run test/describe-roundtrip.test.js` — a `third-party <file> describes
   without an error` test appears automatically, with no change to the test file.
