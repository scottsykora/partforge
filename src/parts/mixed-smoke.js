// CI fixture for per-sub-part backend routing (the mixed-backend twin of
// text-smoke.js): one filleted sub-part that routes to OCCT next to a plain one
// that stays on Manifold, so the smoke check exercises a split generate — two
// workers answering one regen cycle — in a real browser. Dial "Edge fillet" to 0
// and the whole part drops back to Manifold (zero magnitude is the identity).
export default {
  meta: { title: "Mixed smoke", units: "mm" },
  parameters: [
    {
      id: "body",
      title: "Body",
      advanced: [
        { key: "w", label: "Width", unit: "mm", min: 10, max: 60, step: 1 },
        { key: "r", label: "Edge fillet", unit: "mm", min: 0, max: 5, step: 0.5 },
      ],
    },
  ],
  defaults: { w: 30, r: 2 },
  parts: {
    body: {
      label: "Body",
      views: ["assembly"],
      export: { name: "body" },
      // Unguarded on purpose: fillet(0) is the identity, so r drives the routing.
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, 10] }).fillet({ r: p.r, edges: { dir: "Z" } }),
    },
    lid: {
      label: "Lid",
      views: ["assembly"],
      export: { name: "lid" },
      build: (k, p) => k.box({ min: [0, 0, 0], max: [p.w, p.w, 2] }),
      place: (s) => s.at([0, 0, 12]),
    },
  },
  views: { assembly: { label: "Assembly" } },
};
