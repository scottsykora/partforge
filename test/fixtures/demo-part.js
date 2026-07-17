// Minimal PartDefinition used to test the framework generically (no drum knowledge).
export default {
  meta: { title: "Demo", units: "mm" },
  parameters: [
    { id: "size", title: "Size", presets: { Default: { r: 10, h: 5 } },
      advanced: [{ key: "r", label: "Radius", unit: "mm", min: 2, max: 40, step: 1 }] },
  ],
  defaults: { r: 10, h: 5, with_lid: 0 },
  derive: (p) => ({ rr: p.r * 2 }),
  parts: {
    base: { label: "Base", views: ["all", "base"], export: { name: "base" },
            build: (k, p, d) => k.cylinder({ r: p.r, h: p.h }) },
    lid:  { label: "Lid", views: ["all"], enabled: (p) => p.with_lid > 0,
            export: { name: "lid" },
            build: (k, p, d) => k.cylinder({ r: p.r, h: 1 }).translate([0, 0, p.h]) },
  },
  views: { all: { label: "All" }, base: { label: "Base" } },
};
