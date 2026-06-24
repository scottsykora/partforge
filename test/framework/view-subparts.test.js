import { expect, test } from "vitest";
import { viewSubParts, exportSubParts } from "../../src/framework/jobs.js";
import demo from "../fixtures/demo-part.js";

test("viewSubParts returns sub-parts in the view whose enabled() passes", () => {
  expect(viewSubParts(demo, "all", { with_lid: 0 })).toEqual(["base"]);
  expect(viewSubParts(demo, "all", { with_lid: 1 })).toEqual(["base", "lid"]);
  expect(viewSubParts(demo, "base", { with_lid: 1 })).toEqual(["base"]);
});

test("exportSubParts drops parts flagged exportable:false; views still keep them", () => {
  const part = {
    parts: {
      body: { views: ["all"], build() {} },
      motor: { views: ["all"], exportable: false, build() {} }, // reference/preview only
    },
    views: { all: {} },
  };
  expect(viewSubParts(part, "all", {})).toEqual(["body", "motor"]);  // both visible in the viewer
  expect(exportSubParts(part, "all", {})).toEqual(["body"]);         // motor never exported
});
