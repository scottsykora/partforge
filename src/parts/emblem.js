// The k.vector2d reference part — for BOTH paths the format supports: ingested
// artwork (`emblem`, `units: "artwork"`, sized per call site) and an authored
// millimetre drawing (`plate`, `units: "mm"`, placed exactly as drawn). The two
// vectors share one build, composed together with an ordinary boolean.
//
// `vectors` is declared with `new URL(..., import.meta.url)`, the same form
// import-demo.js uses for its STL: Vite turns it into a bundled asset URL, and
// in Node it is a file: URL that src/testing/assets.js reads off disk. A bare
// `() => import("./assets/emblem.vector.json")` would work in Vite and fail in the CLI.
//
// The source artwork lives beside it as emblem.svg, and the .json is regenerated
// with `node scripts/ingest-svg.mjs src/parts/assets/emblem.svg`. plate.vector.json
// is hand-authored — no ingest step, no source SVG — and is kept legible enough
// to serve as documentation's worked example of a multi-shape, role-composed file.
export default {
  meta: { title: "Emblem", units: "mm", background: 0x15181d },
  vectors: {
    emblem: new URL("./assets/emblem.vector.json", import.meta.url),
    plate: new URL("./assets/plate.vector.json", import.meta.url),
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
      // holes minus keyway), and units "mm" places it exactly as drawn. Passing
      // a size here would scale each shape against ITS OWN bounds — the trap
      // this format exists to prevent.
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
        // The plate outline is fixed by plate.vector.json (40 x 24), so this
        // envelope is tight in x/y and schema-bounded in z (plate_t + emboss <= 14).
        bbox: "<=[41,25,15]",
        // Measured at defaults: 3013 mm^3 (`npx partforge measure`). The bare
        // plate (no emboss union) is 2748 mm^3 — comfortably under this bound —
        // so a silently-vanished emboss union fails here. Complemented by the
        // `holes` gate below for the opposite failure (a cut that stops working
        // raises volume, not lowers it, so this bound alone can't catch that).
        volume: ">=2900",
        watertight: true,
        // Measured 2, not 3: the two bolt circles cut clean through, but the
        // emblem artwork's default footprint (`emblem_w`=30, centred) sits
        // directly over the keyway and fully covers it from above, capping what
        // would otherwise be a through-slot into a blind pocket — one fewer
        // tunnel, so genus is 2. Confirmed with `npx partforge measure`, and by
        // temporarily flipping "holes"/"keyway" to role "add" in
        // plate.vector.json (which drops this to 0, proving the gate can fail).
        holes: 2,
      },
      _view: { overlaps: 0 },
    },
  },
};
