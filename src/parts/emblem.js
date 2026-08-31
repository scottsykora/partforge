// The k.vector2d reference part — for BOTH paths the format supports: ingested
// artwork (`emblem`, `units: "artwork"`, sized per call site) and an authored
// millimetre drawing (`plate`, `units: "mm"`, placed exactly as drawn). The two
// vectors share one build, composed together with an ordinary boolean.
//
// The two entries also demonstrate the two SOURCE forms, deliberately:
//
//   `emblem` is `new URL(..., import.meta.url)` — the form import-demo.js uses
//   for its STL. Vite turns it into a bundled asset URL; in Node it is a file:
//   URL src/testing/assets.js reads off disk. Right for ingested output, which is
//   generated, large, and not meant to be read by hand.
//
//   `plate` is the file's parsed CONTENTS, imported directly. Right for artwork
//   that is hand-authored and meant to STAY hand-editable: the numbers live in a
//   .json a reader can open, and nothing has to fetch anything to see them —
//   which is also what lets lint read the file before the first build has run.
//   The `with { type: "json" }` attribute is required: Node refuses a JSON import
//   without it, and a bare `() => import("./assets/plate.vector.json")` would
//   work under Vite and fail in the CLI.
//
// The source artwork lives beside it as emblem.svg, and the .json is regenerated
// with `npx partforge ingest src/parts/assets/emblem.svg --out
// src/parts/assets/emblem.vector.json`. plate.vector.json
// is hand-authored — no ingest step, no source SVG — and is kept legible enough
// to serve as documentation's worked example of a multi-shape, role-composed file.
import plate from "./assets/plate.vector.json" with { type: "json" };

export default {
  meta: { title: "Emblem", units: "mm", background: 0x15181d },
  vectors: {
    emblem: new URL("./assets/emblem.vector.json", import.meta.url),
    plate,
  },
  parameters: [
    {
      id: "plate",
      title: "Plate",
      description: "The backing plate the artwork is embossed on. Its outline — including the bolt "
        + "holes and keyway — is drawn in plate.vector.json, not parameterized.",
      advanced: [
        { key: "plate_t", label: "Thickness", unit: "mm", min: 1, max: 10, step: 0.5, description: "Plate thickness." },
      ],
    },
    {
      id: "art",
      title: "Artwork",
      description: "The embossed vector art. `emblem.svg` carries a filled circle and a stroked bar, so both of ingest's geometry paths are exercised.",
      advanced: [
        { key: "emblem_w", label: "Emblem width", unit: "mm", min: 8, max: 70, step: 1,
          description: "Width of the artwork's **tight bounding box** in mm — not its `viewBox`. Stroke thickness scales with it." },
        { key: "emboss", label: "Emboss height", unit: "mm", min: 0.4, max: 4, step: 0.2,
          description: "How far the artwork stands proud of the plate." },
      ],
    },
  ],
  defaults: { plate_t: 3, emblem_w: 30, emboss: 1 },
  parts: {
    plate: {
      label: "Plate",
      views: ["plate"],
      export: { name: "emblem-plate" },
      // No shape named and no size: the file's own roles compose it (body minus
      // holes minus keyway), and units "mm" places it exactly as drawn. A size
      // HERE would be safe — the composed call measures the whole document at
      // once — but it would also be pointless. What is not safe is fetching
      // body/holes/keyway separately and sizing each call: each would scale
      // against ITS OWN bounds, and the drawing's shared frame would be gone
      // (ERROR-PATTERNS.md#vector-mm-shapes-misscaled). Millimetres place as
      // authored; that is the whole point of the units mode.
      // The keyway sits clear of the artwork at the default `emblem_w` (30) —
      // confirmed by measurement, not eyeballed: their 2-D footprints have zero
      // intersection. That clearance is deliberate, not incidental: a much
      // larger `emblem_w` would grow the emboss until it overlaps the keyway's
      // footprint again, and the union below would then cap it from above —
      // a through-slot the drawing marks `role: "subtract"` quietly becoming a
      // blind pocket. This is exactly the failure mode the `holes` gate below
      // exists to catch, which is why that gate is only asserted at defaults.
      build: (k, p) => k
        .vector2d("plate")
        .extrude({ h: p.plate_t })
        .union(k.vector2d("emblem", { width: p.emblem_w }).extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
    },
  },
  views: { plate: { label: "Plate" } },
  verify: {
    expect: {
      plate: {
        // Tight in all three axes, by the same +1 mm convention as
        // import-demo.js's gates: verify evaluates the `defaults` case only
        // (this part declares no presets), so bbox is checked against one
        // deterministic value (40 x 24 x 4) forever, not a swept range —
        // z = plate_t + emboss = 3 + 1 = 4 at these defaults specifically,
        // not the schema's wider plate_t/emboss envelope. Revisit this bound
        // if a preset is ever added that sweeps plate_t or emboss.
        bbox: "<=[41,25,5]",
        // Measured at defaults: 3013 mm^3 (`npx partforge measure`). The bare
        // plate (no emboss union) is 2748 mm^3 — comfortably under this bound —
        // so a silently-vanished emboss union fails here. Complemented by the
        // `holes` gate below for the opposite failure (a cut that stops working
        // raises volume, not lowers it, so this bound alone can't catch that).
        volume: ">=2900",
        watertight: true,
        // Three through-holes: the two bolt circles, plus the keyway triangle —
        // all cut clean through the extruded plate and, at this part's default
        // `emblem_w`, none of them sit under the artwork's emboss (see the
        // build comment above for why that placement matters). Confirmed with
        // `npx partforge measure`, and falsified by temporarily flipping
        // "holes"/"keyway" to role "add" in plate.vector.json (which drops
        // this to 0, proving the gate can fail).
        holes: 3,
      },
      _view: { overlaps: 0 },
    },
  },
};
