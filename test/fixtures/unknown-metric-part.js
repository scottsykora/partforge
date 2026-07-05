// Shape copied from thin-wall-part.js, but its verify block asks for an unknown
// metric (`bogusMetric`). measure() succeeds and prints; then verify()'s check()
// throws on the unrecognized metric — exercising the --out contract that the
// measure half is written to disk before the later verify throw crashes the run.
export default {
  meta: { title: "UnknownMetric", units: "mm" },
  defaults: {},
  parts: { ring: { views: ["v"], build: (k) => k.cylinder(4, 4, 10).cut(k.cylinder(3.4, 3.4, 14).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { expect: { ring: { bogusMetric: 1 } } },
};
