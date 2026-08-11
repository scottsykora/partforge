// Two views declaring the SAME animation name, so `--animation shared` cannot
// be resolved without the positional view argument. Deliberately minimal — the
// only thing under test is the ambiguity report.
export default {
  meta: { title: "Ambiguous Anim", units: "mm" },
  parameters: [
    { id: "size", title: "Size", advanced: [{ key: "h", label: "Height", unit: "mm", min: 1, max: 50, step: 1 }] },
  ],
  defaults: { h: 10, lift: 0 },
  parts: {
    body: {
      label: "Body",
      views: ["assembly", "detail"],
      export: { name: "body" },
      build: (k, p) => k.box({ size: [p.h, p.h, p.h] }),
      place: (s, { p }) => s.translate([0, 0, p.lift]),
    },
  },
  views: {
    assembly: {
      label: "Assembly",
      animations: { shared: { label: "Shared", duration: 1, tracks: { lift: [[0, 0], [1, 10]] } } },
    },
    detail: {
      label: "Detail",
      animations: { shared: { label: "Shared", duration: 1, tracks: { lift: [[0, 10], [1, 0]] } } },
    },
  },
};
