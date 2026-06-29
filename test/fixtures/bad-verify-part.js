// A deliberately-failing part: it has one bore (genus 1) but asserts two.
export default {
  meta: { title: "Bad", units: "mm" },
  defaults: {},
  parts: { block: { views: ["v"], build: (k) => k.cylinder(10, 10, 10).cut(k.cylinder(3, 3, 14).translate([0, 0, -2])) } },
  views: { v: { label: "V" } },
  verify: { expect: { block: { holes: 2 } } },
};
