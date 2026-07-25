import { beforeAll, afterAll, expect, test } from "vitest";
import { rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { bootManifoldKernel } from "../src/testing.js";
import { renderViews, RENDER_VIEWS } from "../src/testing/render.js";
import part from "../src/parts/demo.js";

let k;
const OUT = "test/.render-out";
beforeAll(async () => { k = await bootManifoldKernel(); });
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

// The four angles beyond iso/front/top used to throw "unknown angle" — the reason a
// consumer inspecting an underside headlessly had nothing to look at.
test("renderViews handles every canonical angle, and they are not all the same picture", async () => {
  const files = await renderViews(k, part, "spacer", { views: RENDER_VIEWS, out: OUT, size: [160, 160] });
  expect(files).toHaveLength(7);

  const pixels = files.map((f) => {
    const png = PNG.sync.read(readFileSync(f));
    const bg = [0x15, 0x18, 0x1d];
    let nonBg = 0;
    for (let i = 0; i < png.data.length; i += 4)
      if (Math.abs(png.data[i] - bg[0]) > 8 || Math.abs(png.data[i + 1] - bg[1]) > 8 || Math.abs(png.data[i + 2] - bg[2]) > 8) nonBg++;
    return { file: f, nonBg, data: png.data.toString("base64") };
  });

  // every angle actually drew the part
  for (const p of pixels) expect(p.nonBg, p.file).toBeGreaterThan(100);
  // and the camera really moved: an end-on view cannot look like a side-on one.
  // (top vs bottom, or left vs right, are legitimately pixel-identical here — the demo
  // spacer is a straight bored cylinder, symmetric about both. Asserting those differ
  // would be testing the part, not the renderer.)
  const byView = Object.fromEntries(RENDER_VIEWS.map((v, i) => [v, pixels[i].data]));
  expect(byView.top).not.toBe(byView.front);
  expect(byView.bottom).not.toBe(byView.left);
  expect(byView.iso).not.toBe(byView.front);
});
