import { expect, test } from "vitest";
import { exportablePartNames, partLabel } from "../src/framework/export-select.js";

const part = {
  parts: {
    base: { label: "Base", views: ["all"] },
    lid:  { label: "Lid", views: ["all"], enabled: (p) => p.with_lid > 0 },
    ghost:{ label: "Ghost", views: ["all"], exportable: false },
  },
  views: { all: { label: "All" } },
};

test("union of exportable, param-enabled parts in definition order", () => {
  expect(exportablePartNames(part, { with_lid: 1 })).toEqual(["base", "lid"]);
});
test("drops disabled parts", () => {
  expect(exportablePartNames(part, { with_lid: 0 })).toEqual(["base"]);
});
test("drops exportable:false parts", () => {
  expect(exportablePartNames(part, { with_lid: 1 })).not.toContain("ghost");
});
test("label falls back to the key", () => {
  expect(partLabel({ parts: { x: {} } }, "x")).toBe("x");
  expect(partLabel(part, "base")).toBe("Base");
});

import { makeHandle } from "../src/framework/mount.js";
test("handle.listExportableParts returns {name,label}", () => {
  const h = makeHandle({
    ready: Promise.resolve(), dispose() {}, viewer: { captureCanonicalViews() {} }, setParams() {},
    listExportableParts: () => [{ name: "base", label: "Base" }],
  });
  expect(h.listExportableParts()).toEqual([{ name: "base", label: "Base" }]);
});
