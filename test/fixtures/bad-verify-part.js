// A deliberately-failing part: it has one bore (genus 1) but asserts two.
export default {
  meta: { title: "Bad", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (k) => k.cylinder({ r: 10, h: 10 }).cut(k.cylinder({ r: 3, h: 14 }).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { expect: { block: { holes: 2 } } },
};
