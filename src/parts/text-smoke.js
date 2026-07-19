// Dev/CI worker-safety fixture (Task 3): a real text-bearing part, wired through
// the actual app/worker path so scripts/check-app.mjs can boot it in real Chromium.
// This is the definitive proof that paper.js (via resolveCurveFill) actually
// executes inside the Vite geometry Web Worker, not just under Node/vitest.
export default {
  meta: { title: "Text worker smoke", units: "mm", background: 0x15181d },
  parameters: [],
  defaults: {},
  parts: {
    text: {
      label: "Text",
      views: ["text"],
      export: { name: "text-smoke" },
      build: (k) => k.extrude({
        profile: k.text2d("B8&", { size: 10, align: "center", valign: "middle" }),
        h: 2,
      }).label("Resolved text"),
    },
  },
  views: { text: { label: "Text" } },
};
