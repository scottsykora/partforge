import { expect, test } from "vitest";
import * as selection from "../src/framework/selection/index.js";

test("the module re-exports its public surface", () => {
  expect(typeof selection.resolveSelection).toBe("function");
  expect(typeof selection.formatSelection).toBe("function");
  expect(typeof selection.attachPicker).toBe("function");
  expect(typeof selection.worldToSubPartLocal).toBe("function");
});
