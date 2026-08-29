// Reference part for the `images` field / `type: "image"` control / `k.heightfield`
// (docs/AUTHORING-PARTS.md "Image controls"): a depth map becomes a printable relief
// plate. `relief` is a `type: "image"` control — pick a replacement PNG from the
// panel, or leave it empty and the bundled `assets/relief-demo.png` (a synthetic
// concentric-ripple depth map) is used, so the part builds with no network access
// and `partforge measure`/CI never need to fetch anything. `pitch` trades sampling
// detail against triangle count — and therefore STEP size, since a fine pitch on a
// high-frequency image produces many non-coplanar faces (see heightfieldMesh's own
// STEP-size warning in the OCCT backend).
//
// DEMO_RELIEF_RANGE: the bundled asset's luminance only spans ~39–75% of the
// 16-bit sample range (measured: 25443–48830 of 65535) — the ripple formula that
// generated it decays toward its 50%-gray baseline away from the first ring, so
// most pixels sit close to mid-gray. `k.heightfield`'s default `range: [0, 1]` is
// an IDENTITY map (raw sample value straight to 0..1), not an auto-normalize, so
// left alone the demo would use well under half of `maxZ`. This stretches the
// default asset's own measured extent to the full 0..1 span so the shipped demo
// shows the full relief amplitude. Applied only when the bundled default is in
// use (`p.relief` empty) — a picked custom image's tonal range is unknown ahead
// of build time, so it gets the identity range instead.
export const DEMO_RELIEF_RANGE = [25443 / 65535, 48830 / 65535];

export default {
  meta: { title: "Relief plate", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "image",
      title: "Image",
      description: "The depth map the relief is sampled from. Bright = high, dark = low, unless inverted.",
      controls: [
        { key: "relief", type: "image", label: "Depth map",
          description: "Pick a PNG from the catalog or paste a URL. Empty falls back to the bundled sample ripple." },
        { key: "invert", type: "checkbox", label: "Invert",
          description: "Swap which end of the image is raised — bright becomes low, dark becomes high." },
      ],
    },
    {
      id: "plate",
      title: "Plate",
      description: "Footprint and relief depth of the printed plate.",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 20, max: 200, step: 1,
          description: "Plate footprint along X." },
        { key: "d", label: "Depth", unit: "mm", min: 20, max: 200, step: 1,
          description: "Plate footprint along Y." },
        { key: "base", label: "Base", unit: "mm", min: 0.5, max: 10, step: 0.1,
          description: "Solid slab thickness under the relief — keep it thick enough to print flat and stay rigid." },
        { key: "maxZ", label: "Relief height", unit: "mm", min: 0.2, max: 10, step: 0.1,
          description: "How far the tallest sample rises above the base." },
        { key: "pitch", label: "Detail", unit: "mm", min: 0.2, max: 2, step: 0.1,
          description: "Grid spacing of the height sampling. Smaller is crisper but costs more triangles — see the file header." },
      ],
    },
  ],
  defaults: { relief: "", invert: 0, w: 60, d: 60, base: 1.5, maxZ: 3, pitch: 0.5 },
  // The default is the bundled asset, so the part builds offline; a picked value
  // (a URL or catalog source from the `type: "image"` control) replaces it.
  images: (p) => ({
    relief: p.relief || new URL("./assets/relief-demo.png", import.meta.url),
  }),
  parts: {
    plate: {
      label: "Relief plate",
      views: ["relief"],
      export: { name: "relief" },
      build: (k, p) => k.heightfield("relief", {
        w: p.w, d: p.d, base: p.base, maxZ: p.maxZ, pitch: p.pitch, invert: p.invert,
        ...(p.relief ? {} : { range: DEMO_RELIEF_RANGE }),
      }),
    },
  },
  views: { relief: { label: "Relief" } },
  // Self-verification: a heightfield solid is watertight and hole-free by
  // construction (grid + skirt + cap, no cuts) — this pins that invariant rather
  // than asserting anything image-specific. bbox bounds catch a runaway parameter;
  // fdm-pla opts into the bed-fit gate for a plate meant to actually be printed.
  verify: {
    process: "fdm-pla",
    expect: {
      plate: { watertight: true, holes: 0, bbox: "<=[200,200,20]" },
      _view: { overlaps: 0 },
    },
  },
};
