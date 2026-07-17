// A printable-but-too-thin part: a tube with a 0.6 mm wall. Fits the bed and has one
// bore, but its wall is under the FDM-PLA minimum (1.2 mm) — so min-wall WARNS while
// the hard gates pass and the exit code stays 0.
export default {
  meta: { title: "Thin", units: "mm" },
  defaults: {},
  parts: { ring: { views: ["v"], build: (k) => k.cylinder({ r: 4, h: 10 }).cut(k.cylinder({ r: 3.4, h: 14 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { process: "fdm-pla", expect: { ring: { holes: 1 }, _view: { overlaps: 0 } } },
};
