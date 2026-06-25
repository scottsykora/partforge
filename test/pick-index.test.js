import { expect, test } from "vitest";
import * as pr from "../src/framework/pick-request/index.js";
test("re-exports the browser client", () => {
  expect(typeof pr.createPickRequestClient).toBe("function");
});
