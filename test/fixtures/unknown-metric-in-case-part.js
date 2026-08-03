// Like unknown-metric-part.js, but the bad metric name only appears for a non-default
// preset: `verify.expect` is a function of (p, d), and it only asks for `bogusMetric`
// when `mode === "bad"`. The lint gate's `verify-unknown-metric` rule only resolves
// `expect` once, with the part's *defaults* (mode: "ok") — so it sees `{ holes: 1 }`,
// which is valid, and passes clean. verify() itself expands every case (defaults +
// each preset, see src/framework/oracle/cases.js) and re-resolves `expect(p, d)` per case, so
// the "Bad" preset's case still throws `unknown subpart metric "bogusMetric"` — but
// only after measure() has already printed and `--out` has already been written once.
// This keeps test/cli.test.js's "--out writes the measure half even when a later
// verify throw crashes the run" exercising a real production path with lint enabled,
// instead of requiring --no-lint to reach it.
export default {
  meta: { title: "UnknownMetricInCase", units: "mm" },
  parameters: [{ id: "mode", title: "Mode", presets: { Bad: { mode: "bad" } } }],
  defaults: { mode: "ok" },
  parts: { ring: { views: ["v"], build: (k) => k.cylinder({ r: 4, h: 10 }).cut(k.cylinder({ r: 3.4, h: 14 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { expect: (p) => (p.mode === "bad" ? { ring: { bogusMetric: 1 } } : { ring: { holes: 1 } }) },
};
