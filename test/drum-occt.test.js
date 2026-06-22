import { beforeAll, expect, test } from "vitest";
import { bootOcctKernel } from "./occt-kernel.js";

let k, buildSubPart;
beforeAll(async () => {
  k = await bootOcctKernel();
  ({ buildSubPart } = await import("../src/parts/drum/bodies.js"));
}, 120_000);

test("small drum builds via the OCCT kernel and meshes", () => {
  expect(buildSubPart(k, "small", {}).toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
}, 120_000);

test("big drum builds via the OCCT kernel and meshes", () => {
  expect(buildSubPart(k, "big", {}).toMesh({ quality: "preview" }).triangles).toBeGreaterThan(0);
}, 120_000);
