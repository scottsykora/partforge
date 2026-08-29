// The k.svg2d reference part — ingested vector art embossed on a plate.
//
// `svgs` is declared with `new URL(..., import.meta.url)`, the same form
// import-demo.js uses for its STL: Vite turns it into a bundled asset URL, and
// in Node it is a file: URL that src/testing/assets.js reads off disk. A bare
// `() => import("./assets/emblem.svg.json")` would work in Vite and fail in the CLI.
//
// The source artwork lives beside it as emblem.svg, and the .json is regenerated
// with `node scripts/ingest-svg.mjs src/parts/assets/emblem.svg`.
export default {
  meta: { title: "Emblem", units: "mm", background: 0x15181d },
  svgs: {
    emblem: new URL("./assets/emblem.svg.json", import.meta.url),
  },
  parameters: [
    {
      id: "plate",
      title: "Plate",
      description: "The backing plate the artwork is embossed on.",
      advanced: [
        { key: "plate_w", label: "Width", unit: "mm", min: 20, max: 80, step: 1, description: "Plate width." },
        { key: "plate_h", label: "Depth", unit: "mm", min: 16, max: 60, step: 1, description: "Plate depth." },
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
  defaults: { plate_w: 40, plate_h: 32, plate_t: 3, emblem_w: 30, emboss: 1 },
  parts: {
    plate: {
      label: "Plate",
      views: ["plate"],
      export: { name: "emblem-plate" },
      build: (k, p) => k
        .box({ min: [-p.plate_w / 2, -p.plate_h / 2, 0], max: [p.plate_w / 2, p.plate_h / 2, p.plate_t] })
        .union(k.svg2d("emblem", { width: p.emblem_w }).extrude({ h: p.emboss }).translate([0, 0, p.plate_t])),
    },
  },
  views: { plate: { label: "Plate" } },
  verify: {
    expect: {
      plate: { bbox: "<=[81,61,15]" },
      _view: { overlaps: 0 },
    },
  },
};
