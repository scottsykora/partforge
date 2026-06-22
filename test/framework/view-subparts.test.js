import { expect, test } from "vitest";
import { viewSubParts } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

test("viewSubParts returns sub-parts in the view whose enabled() passes", () => {
  expect(viewSubParts(demo, "all", { with_lid: 0 })).toEqual(["base"]);
  expect(viewSubParts(demo, "all", { with_lid: 1 })).toEqual(["base", "lid"]);
  expect(viewSubParts(demo, "base", { with_lid: 1 })).toEqual(["base"]);
});
