// test/op-options.test.js
// Pure unit tests for the options-object normalizers — no WASM, no kernel boot.
import { expect, test } from "vitest";
import { isPlainOptions, cylinderArgs, sphereArgs, boxArgs } from "../src/framework/geometry/op-options.js";

test("isPlainOptions accepts plain objects only", () => {
  expect(isPlainOptions({})).toBe(true);
  expect(isPlainOptions(Object.create(null))).toBe(true);
  expect(isPlainOptions([1, 2, 3])).toBe(false);
  expect(isPlainOptions(null)).toBe(false);
  expect(isPlainOptions(7)).toBe(false);
  expect(isPlainOptions("x")).toBe(false);
  expect(isPlainOptions(new Float32Array(3))).toBe(false);
  class Handle {}
  expect(isPlainOptions(new Handle())).toBe(false);
});

test("cylinderArgs resolves r/d and r1+r2/d1+d2 to [rBottom, rTop, h]", () => {
  expect(cylinderArgs({ r: 4, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ d: 8, h: 10 })).toEqual([4, 4, 10]);
  expect(cylinderArgs({ r1: 3, r2: 1, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ d1: 6, d2: 2, h: 5 })).toEqual([3, 1, 5]);
  expect(cylinderArgs({ r: 4, h: 10, center: true })).toEqual([4, 4, 10, { center: true }]);
});

test("cylinderArgs rejects bad radius vocabulary", () => {
  const BAD = "cylinder: pass exactly one of r/d, or r1+r2 / d1+d2";
  expect(() => cylinderArgs({ r: 4, d: 8, h: 1 })).toThrow(BAD);   // both
  expect(() => cylinderArgs({ h: 1 })).toThrow(BAD);               // neither
  expect(() => cylinderArgs({ r: 4, r1: 1, h: 1 })).toThrow(BAD);  // straight + cone
  expect(() => cylinderArgs({ r1: 1, h: 1 })).toThrow(BAD);        // one cone end
  expect(() => cylinderArgs({ r1: 1, d2: 2, h: 1 })).toThrow(BAD); // mixed cone vocab
  expect(() => cylinderArgs({ r: 4 })).toThrow("cylinder: h is required");
});

test("unknown keys error with a did-you-mean hint", () => {
  expect(() => cylinderArgs({ radius: 4, h: 1 }))
    .toThrow('cylinder: unknown option "radius" — did you mean r?');
  expect(() => cylinderArgs({ height: 4, r: 1 }))
    .toThrow('cylinder: unknown option "height" — did you mean h?');
  // no plausible hint → list valid keys
  expect(() => boxArgs({ frobnicate: 1 }))
    .toThrow('box: unknown option "frobnicate" (valid: size, center, min, max)');
});

test("sphereArgs takes exactly one of r/d", () => {
  expect(sphereArgs({ r: 5 })).toEqual([5]);
  expect(sphereArgs({ d: 10 })).toEqual([5]);
  expect(() => sphereArgs({ r: 5, d: 10 })).toThrow("sphere: pass exactly one of r/d");
  expect(() => sphereArgs({})).toThrow("sphere: pass exactly one of r/d");
});

test("boxArgs: size is centered in X/Y with base at z=0; center:true centers Z too", () => {
  expect(boxArgs({ size: [4, 6, 10] })).toEqual([[-2, -3, 0], [2, 3, 10]]);
  expect(boxArgs({ size: [4, 6, 10], center: true })).toEqual([[-2, -3, -5], [2, 3, 5]]);
  expect(boxArgs({ min: [0, 0, 0], max: [1, 2, 3] })).toEqual([[0, 0, 0], [1, 2, 3]]);
  expect(() => boxArgs({ size: [1, 1, 1], min: [0, 0, 0], max: [1, 1, 1] }))
    .toThrow("box: pass size or min+max, not both");
  expect(() => boxArgs({ min: [0, 0, 0] })).toThrow("box: max is required");
  expect(() => boxArgs({})).toThrow("box: size is required");
});
