// Cross-backend identity (OCCT half) + STEP CIRCLE fidelity. Own file: OCCT
// and Manifold must never boot in the same process (vitest isolates per
// file). See test/shape2d-parity-manifold.test.js for the Manifold half of
// the identity assertion and the shared rationale — Shape2D's boolean chain
// runs through the SAME paper.js-backed contour IR on both backends, so
// toContours() is backend-identical BY CONSTRUCTION.
import { readFileSync } from "node:fs";
import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "../src/testing/occt.js";
import { A, B, C } from "./helpers/shape2d-golden-input.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/shape2d-boolean-golden.json", import.meta.url), "utf8"),
);

let k;
beforeAll(async () => { k = await bootOcctKernel(); }, 120_000);

test("boolean chain matches the shared-engine golden result exactly (OCCT)", () => {
  const out = k.shape2d(A).union(k.shape2d(B)).cut(k.shape2d(C)).toContours();
  expect(out).toEqual(golden);
});

// fillet() emits arcs as symbolic {to,via} segments; OCCT's contourDrawing maps
// those through threePointsArcTo, so a rounded corner survives to STEP as a
// true CIRCLE entity rather than a tessellated polyline of LINE segments.
test("fillet arcs reach STEP as CIRCLE entities", async () => {
  const plate = k.shape2d([[0, 0], [30, 0], [30, 20], [0, 20]]).fillet(4);
  const solid = k.extrude({ profile: plate, h: 3 });
  const step = new TextDecoder().decode(await k.toSTEP([{ name: "plate", solid }]));
  expect(step).toMatch(/\bCIRCLE\b/);
});
