// The verify metric vocabulary must live in a module the linter can import without
// pulling in a geometry kernel — src/testing/verify.js imports measure.js and jobs.js,
// which reach manifold-3d/replicad. This test pins both the move and the re-export.
import { expect, test } from "vitest";
import { SUBPART_METRICS, VIEW_METRICS } from "../src/framework/verify-metrics.js";
import { SUBPART_METRICS as reSub, VIEW_METRICS as reView } from "../src/testing/verify.js";
import { suggest } from "../src/framework/geometry/op-options.js";

test("verify-metrics exposes the subpart metric vocabulary", () => {
  for (const name of ["holes", "watertight", "volume", "surfaceArea", "triangleCount",
    "bbox", "centerOfMass", "boundsMin", "boundsMax", "minWall"]) {
    expect(Object.keys(SUBPART_METRICS), `missing ${name}`).toContain(name);
  }
  expect(SUBPART_METRICS.minWall.kind).toBe("warn");
  expect(SUBPART_METRICS.holes.kind).toBe("gate");
});

test("verify-metrics exposes the view metric vocabulary", () => {
  for (const name of ["bbox", "volume", "overlaps", "centerOfMass", "boundsMin", "boundsMax"]) {
    expect(Object.keys(VIEW_METRICS), `missing ${name}`).toContain(name);
  }
});

test("every metric carries a hint, as the diagnostics contract promises", () => {
  for (const [name, m] of [...Object.entries(SUBPART_METRICS), ...Object.entries(VIEW_METRICS)]) {
    expect(typeof m.hint, `${name} has no hint`).toBe("string");
    expect(m.hint.length, `${name} hint is empty`).toBeGreaterThan(0);
  }
});

test("verify.js re-exports the same registry objects", () => {
  expect(reSub).toBe(SUBPART_METRICS);
  expect(reView).toBe(VIEW_METRICS);
});

test("suggest is exported for reuse by the linter", () => {
  expect(suggest("radius", ["r", "d", "h"])).toBe("r");
  // No "h" in `valid` here: suggest's prefix rule (by design, see op-options.js)
  // maps any h-prefixed key straight to a same-prefixed short key before edit
  // distance ever runs, so a valid set containing both "h" and "height" always
  // resolves to "h" — this case exercises the edit-distance fallback instead.
  expect(suggest("heigth", ["r", "d", "height"])).toBe("height");
  expect(suggest("zzzz", ["r", "d", "h"])).toBe(null);
});
