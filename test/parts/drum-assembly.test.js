// Collision guard for the drum's full assembly: no two parts may interpenetrate
// in the "both" view. Edit a part so pieces overlap (e.g. move the small drum into
// the big one) and this fails with the offending pair + overlap volume.
import { beforeAll, expect, test } from "vitest";
import Module from "manifold-3d";
import { createManifoldKernel } from "../../src/framework/geometry/manifold-backend.js";
import { assemblyOverlaps } from "../../src/framework/assembly.js";
import drum from "../../src/parts/drum.js";

let k;
beforeAll(async () => { const w = await Module(); w.setup(); k = createManifoldKernel(w, { quality: "preview" }); });

test("'both' assembly has no interpenetrating parts", () => {
  const overlaps = assemblyOverlaps(k, drum, "both", {});
  expect(overlaps, `interpenetrating pairs: ${JSON.stringify(overlaps)}`).toEqual([]);
});
