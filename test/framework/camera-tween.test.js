// Pure orbit-tween math: eased spherical interpolation, shortest-path azimuth,
// pole clamping, retargeting, cancel.
import { expect, test, vi } from "vitest";
import { createCameraTween } from "../../src/framework/camera-tween.js";

const FROM = { position: [10, 0, 0], target: [0, 0, 0] };

test("update interpolates from → to and reports done at the end", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.done).toBe(false);
  // radius preserved through the arc (both poses are 10 from the target)
  expect(Math.hypot(...mid.position)).toBeCloseTo(10, 5);
  const end = tw.update(0.5);
  expect(end.done).toBe(true);
  expect(end.position[0]).toBeCloseTo(0, 5);
  expect(end.position[2]).toBeCloseTo(10, 5);
  expect(tw.isActive()).toBe(false);
});

test("azimuth takes the short way around", () => {
  const tw = createCameraTween();
  // +x → -z is -90° the short way; the long way would pass through -x
  tw.start(FROM, { position: [0, 0, -10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  expect(mid.position[0]).toBeGreaterThan(0); // stays on the +x side of the arc
});

test("a straight-overhead destination is clamped off the pole", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 10, 0], target: [0, 0, 0] }, { duration: 1 });
  const end = tw.update(1);
  const horizontal = Math.hypot(end.position[0], end.position[2]);
  expect(horizontal).toBeGreaterThan(0.01); // never exactly on the Y axis
});

test("onComplete fires exactly once, at the end", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.update(0.5);
  expect(done).not.toHaveBeenCalled();
  tw.update(0.6);
  expect(done).toHaveBeenCalledTimes(1);
});

test("restart while active retargets from the caller-supplied current pose", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1 });
  const mid = tw.update(0.5);
  tw.start({ position: mid.position, target: mid.target },
    { position: [-10, 0, 0], target: [0, 0, 0] }, { duration: 1 });
  expect(tw.update(0).position[0]).toBeCloseTo(mid.position[0], 5); // no jump at retarget
});

test("cancel drops the tween and suppresses onComplete", () => {
  const done = vi.fn();
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 1, onComplete: done });
  tw.cancel();
  expect(tw.update(1)).toBeNull();
  expect(done).not.toHaveBeenCalled();
});

test("duration 0 completes on the first update (reduced-motion jump cut)", () => {
  const tw = createCameraTween();
  tw.start(FROM, { position: [0, 0, 10], target: [0, 0, 0] }, { duration: 0 });
  expect(tw.update(0.016).done).toBe(true);
});
