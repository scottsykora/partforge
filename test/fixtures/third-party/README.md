# Third-party STL/3MF corpus

`test/describe-roundtrip.test.js` discovers every `*.stl` and `*.3mf` file in this
directory and runs `describe` against it. Drop a file in (and add its provenance row
below) and the coverage appears with no code change; were the directory ever emptied,
that block of tests resolves to a single explanatory skip — not a silent pass, and
not a failure.

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

Three permissively-licensed (**CC0** or **CC-BY**) files, chosen to span the v1
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
| `sovol-sv06-led-mount.3mf` | https://www.printables.com/model/388560-sovol-sv06-led-mounting-bracket | CC0 (Creative Commons — Public Domain; confirmed via the Printables API, license id 7) | "Sovol SV06 LED Mounting Bracket" by ItsDarts. Foreign tessellation, mm units per its 3MF metadata. Prismatic-bracket-with-holes class. |
| `minecraft-sword-bookmark.stl` | https://www.printables.com/model/1819376-minecraft-sword-bookmark | CC0 (Creative Commons — Public Domain; confirmed via the Printables API, license id 7) | "Minecraft sword bookmark" by grasshopper. Foreign tessellation, 288 tris. A single flat extrusion with an arbitrary polygon footprint: describe recognizes it fully (explainedArea 1.0, zero residual) while the volume score stays 0 — the cleanest live specimen of the v1 box/cylinder-footprint reconstruction limit. |
| `estop-enclosure-top.stl` | https://www.partforge.ai/parts/two-color-emergency-stop-enclosure-9b5c7fcf0d60 | Own work (repo owner's partforge-cloud export) | Shelled-enclosure class by geometry, but partforge's OWN tessellation (Manifold export) — a complexity fixture, not a foreign-mesher specimen. A genuinely foreign-meshed enclosure is still wanted. |

## Adding a file

1. Download the STL, verify its licence page states CC0 or CC-BY, and drop it in this
   directory.
2. Add a row to the table above with the direct source URL and the exact licence.
3. Run `npx vitest run test/describe-roundtrip.test.js` — a `third-party <file> describes
   without an error` test appears automatically, with no change to the test file.

A cautionary tale for step 1: the first candidate corpus included a Printables model
whose page *looked* free but whose licence — per the Printables API — was their
"Standard Digital File License", which does not permit redistribution. It was dropped
before commit. When in doubt, query the API directly:
`curl -s https://api.printables.com/graphql/ -H 'content-type: application/json' --data '{"query":"query($id: ID!){ print(id:$id){ name license{ name } } }","variables":{"id":"<model-id>"}}'`
