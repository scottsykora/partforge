// Regression pin: rim-bevel.js builds its bevel band from the profile's own
// point ring via k.loft(...) (see rim-bevel.js). A plain rectangle profile has
// only 4 points — well under loft's 32-side smooth-inference threshold — so
// left to infer, the internal bevel-band lofts register FACETED. That (a)
// drops the bevel band's own corner crease lines and (b), via label()'s
// triangle-count majority vote, can strip ALL edge lines from a labeled
// beveled solid (the bevel band outweighs the box body's flat-cap-only faces).
// rim-bevel.js now passes smooth: true on its three internal loft() calls —
// a bevel band inherits the profile's shading intent, not loft's own facet
// inference — so a beveled solid keeps its edge lines both unlabeled and
// labeled.
import { beforeAll, expect, test } from "vitest";
import { bootManifoldKernel } from "../src/testing.js";

let k;
beforeAll(async () => { k = await bootManifoldKernel(); });

const SQUARE = [[0, 0], [20, 0], [20, 20], [0, 20]];

test("a beveled extrude keeps edge lines (bevel band inherits smooth shading)", () => {
  const s = k.extrude({ profile: SQUARE, h: 10, bevel: 2 });
  expect(s.toMesh().edges.length).toBeGreaterThan(0);
});

test("a beveled extrude keeps edge lines after label() too", () => {
  const s = k.extrude({ profile: SQUARE, h: 10, bevel: 2 }).label("body");
  expect(s.toMesh().edges.length).toBeGreaterThan(0);
});
