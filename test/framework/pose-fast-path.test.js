// The pose fast path's decision layer: stamps at delivery, repairs on edit.
// Probe and delta math run for real; viewer and mesh-cache are minimal stubs.
import { expect, test } from "vitest";
import { createPoseFastPath } from "../../src/framework/pose-fast-path.js";

const posedPart = {
  defaults: { w: 10, angle: 0 },
  views: { v: { label: "V" } },
  parts: {
    a: {
      views: ["v"],
      build: (k, p) =>
        k.box({ min: [0, 0, 0], max: [p.w, 10, 5] })
          .rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, 5] }),
    },
  },
};

function harness(part) {
  const params = { ...part.defaults };
  let version = 0;
  const poses = {};   // name -> last mat16 or null
  const current = new Set();
  const viewer = {
    hasSubMesh: (n) => n in poses,
    setSubPose: (n, m) => { poses[n] = m; },
  };
  const cache = {
    isCurrent: (n) => current.has(n),
    record: (n) => current.add(n),
  };
  const fp = createPoseFastPath(part, viewer, cache, {
    params, getView: () => "v", getParamsVersion: () => version,
  });
  return {
    params, poses, current, fp,
    edit(partial) { Object.assign(params, partial); version++; current.clear(); },
    deliver(name) { poses[name] = null; current.add(name); fp.recordDelivered(name); },
  };
}

test("a pose-only edit repairs the subpart: pose set, re-stamped current, count 1", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toBe(1);
  expect(hx.current.has("a")).toBe(true);
  expect(Array.isArray(hx.poses.a)).toBe(true);
  expect(hx.poses.a).toHaveLength(16);
});

test("a geometry edit does not repair (base hash changed)", () => {
  const hx = harness(posedPart);
  hx.deliver("a");
  hx.edit({ w: 12 });
  expect(hx.fp.repair()).toBe(0);
  expect(hx.current.has("a")).toBe(false);
});

test("an already-current subpart is left alone", () => {
  const hx = harness(posedPart);
  hx.deliver("a"); // current, delivered
  expect(hx.fp.repair()).toBe(0);
  expect(hx.poses.a).toBe(null); // untouched since delivery reset
});

test("no repair before any delivery (nothing stamped, no mesh)", () => {
  const hx = harness(posedPart);
  hx.edit({ angle: 30 });
  expect(hx.fp.repair()).toBe(0);
});

test("an untrusted subpart (geometry query in build) never repairs", () => {
  const queryPart = {
    defaults: { angle: 0 },
    views: { v: { label: "V" } },
    parts: { a: { views: ["v"], build: (k, p) => {
      const s = k.box({ min: [0, 0, 0], max: [4, 4, 4] });
      return s.rotateAbout({ axis: "X", deg: p.angle, through: [0, 0, s.volume()] });
    } } },
  };
  const hx = harness(queryPart);
  hx.deliver("a");
  hx.edit({ angle: 45 });
  expect(hx.fp.repair()).toBe(0);
});

test("repair applies the delta against the DELIVERED pose, not the previous frame", () => {
  const hx = harness(posedPart);
  hx.deliver("a");           // delivered at angle 0
  hx.edit({ angle: 30 });
  hx.fp.repair();
  const at30 = hx.poses.a;
  hx.edit({ angle: 60 });
  hx.fp.repair();
  const at60 = hx.poses.a;
  // both deltas are absolute w.r.t. delivery: 60° is NOT 30° applied twice —
  // recompute 30° and check it matches the first repair exactly
  hx.edit({ angle: 30 });
  hx.fp.repair();
  expect(hx.poses.a).toEqual(at30);
  expect(at60).not.toEqual(at30);
});
