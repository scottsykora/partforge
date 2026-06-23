import { beforeAll, afterAll, expect, test } from "vitest";
import { rmSync, existsSync, statSync, readFileSync } from "node:fs";
import Module from "manifold-3d";
import { PNG } from "pngjs";
import { createManifoldKernel } from "../src/framework/geometry/manifold-backend.js";
import { renderViews } from "../src/testing/render.js";
import part from "../src/parts/demo.js";

let k;
const OUT = "test/.render-out";
beforeAll(async () => { const wasm = await Module(); wasm.setup(); k = createManifoldKernel(wasm, { quality: "preview" }); });
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

test("renderViews writes a valid, non-blank PNG per requested angle", async () => {
  const files = await renderViews(k, part, "spacer", { views: ["iso", "front"], out: OUT, size: [320, 240] });
  expect(files).toHaveLength(2);
  for (const f of files) {
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
    const png = PNG.sync.read(readFileSync(f));
    expect(png.width).toBe(320);
    expect(png.height).toBe(240);
    // the part actually rendered — pixels differ from the scene background
    const bg = [0x15, 0x18, 0x1d];
    let nonBg = 0;
    for (let i = 0; i < png.data.length; i += 4)
      if (Math.abs(png.data[i] - bg[0]) > 8 || Math.abs(png.data[i + 1] - bg[1]) > 8 || Math.abs(png.data[i + 2] - bg[2]) > 8) nonBg++;
    expect(nonBg).toBeGreaterThan(100);
  }
});
