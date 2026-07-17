// Example PartDefinition — a parametric spacer. Doubles as the worked example for
// docs/AUTHORING-PARTS.md "Designing the control panel": a description on every
// control, a hidden internal constant, and a derive() that turns raw inputs into the
// dependent dimensions the build consumes. The framework (viewer, controls, workers,
// STL/STEP export) is reused unchanged.
export default {
  meta: { title: "Spacer", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      description: "The spacer barrel and its through-bore. Pick a preset for a common screw size, or open **Advanced** to set exact dimensions.",
      presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
      advanced: [
        { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5,
          description: "Barrel outer diameter. Keep it comfortably larger than the bore so a wall remains. See the [authoring guide](https://github.com/scottsykora/partforge/blob/main/docs/AUTHORING-PARTS.md)." },
        { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1, control: "number",
          description: "Nominal screw clearance hole. A fixed print clearance is added automatically (see `derive`), so enter the *nominal* size." },
        { key: "h", label: "Height", unit: "mm", min: 2, max: 60, step: 1,
          description: "Spacer length along the axis." },
        { key: "flange_h", label: "Flange thickness", unit: "mm", min: 1, max: 5, step: 0.5, hidden: true,
          description: "Internal: flange plate thickness, fixed by the design. Hidden from the end user, but still drives the geometry." },
      ],
    },
    {
      id: "flange",
      title: "Flange",
      description: "Optional base flange — a wider seating plate at one end.",
      features: [
        { label: "Base flange", key: "flange_d", on: 16,
          description: "Adds a `flange_h`-thick plate of this diameter at the base.",
          sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1,
            description: "Outer diameter of the base flange." }] },
      ],
    },
  ],
  defaults: { od: 8, bore: 3.4, h: 10, flange_d: 0, flange_h: 2 },
  // derive(): turn raw inputs into the dependent dimensions the build needs, so one
  // input drives the geometry consistently — here the bore gains a fixed print
  // clearance and the cut tool is sized to pierce the whole part.
  derive: (p) => ({
    boreR: (p.bore + 0.2) / 2, // nominal bore + 0.2 mm print clearance, as a radius
    cutH: p.h + 4,             // through-cut tool, taller than the part
  }),
  parts: {
    spacer: {
      label: "Spacer",
      views: ["spacer"],
      export: { name: "spacer" },
      build: (k, p, d) => {
        let s = k.cylinder({ d: p.od, h: p.h });
        if (p.flange_d > 0) s = k.union([s, k.cylinder({ d: p.flange_d, h: p.flange_h })]);
        return s.cut(k.cylinder({ r: d.boreR, h: d.cutH }).at([0, 0, -2]));
      },
    },
  },
  views: { spacer: { label: "Spacer" } },
  // Self-verification (see docs/AUTHORING-PARTS.md "Self-verification"): opt into the
  // FDM-PLA process profile (bed-fit gate + min-wall warning) and pin the design intent
  // — one through-bore, fits comfortably on the bed, no interpenetration.
  verify: {
    process: "fdm-pla",
    expect: {
      spacer: { holes: 1, bbox: "<=[60,60,60]" },
      _view: { overlaps: 0 },
    },
  },
};
