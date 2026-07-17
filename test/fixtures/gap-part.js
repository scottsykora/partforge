// Two 10 mm cubes `gap` apart along x — the near-miss test rig. gap 0.2 (default)
// = near miss; 0 = touching; negative = interpenetration; ≥0.5 = clear.
export default {
  meta: { title: "GapRig", units: "mm" },
  defaults: { gap: 0.2 },
  parts: {
    left:  { views: ["v"], build: (k) => k.box({ min: [0, 0, 0], max: [10, 10, 10] }) },
    right: { views: ["v"], build: (k, p) => k.box({ min: [10 + p.gap, 0, 0], max: [20 + p.gap, 10, 10] }) },
  },
  views: { v: { label: "V" } },
};
