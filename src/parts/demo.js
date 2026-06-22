// Example PartDefinition — a parametric spacer. Proof that a new part is just a new
// script: the framework (viewer, controls, workers, STL/STEP export) is reused
// unchanged. Mount it with its own app/worker entry exactly as the drum does.
export default {
  meta: { title: "Spacer", units: "mm", background: 0x15181d },
  parameters: [
    {
      id: "body",
      title: "Body",
      presets: { M3: { od: 8, bore: 3.4, h: 10 }, M5: { od: 12, bore: 5.4, h: 16 } },
      advanced: [
        { key: "od", label: "Outer diameter", unit: "mm", min: 4, max: 40, step: 0.5 },
        { key: "bore", label: "Bore", unit: "mm", min: 1, max: 30, step: 0.1 },
        { key: "h", label: "Height", unit: "mm", min: 2, max: 60, step: 1 },
      ],
    },
    {
      id: "flange",
      title: "Flange",
      features: [
        { label: "Base flange", key: "flange_d", on: 16,
          sliders: [{ key: "flange_d", label: "Flange diameter", unit: "mm", min: 8, max: 50, step: 1 }] },
      ],
    },
  ],
  defaults: { od: 8, bore: 3.4, h: 10, flange_d: 0 },
  parts: {
    spacer: {
      label: "Spacer",
      views: ["spacer"],
      export: { name: "spacer" },
      build: (k, p) => {
        let s = k.cylinder(p.od / 2, p.od / 2, p.h);
        if (p.flange_d > 0) s = k.union([s, k.cylinder(p.flange_d / 2, p.flange_d / 2, 2)]);
        return s.cut(k.cylinder(p.bore / 2, p.bore / 2, p.h + 4).translate([0, 0, -2]));
      },
    },
  },
  views: { spacer: { label: "Spacer" } },
};
