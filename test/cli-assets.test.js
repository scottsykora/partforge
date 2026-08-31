// Node-side asset wiring: file: URL sources (fonts + imports) must reach the
// booted kernel — this is what src/testing/assets.js (nodeAssetSources) and the
// updated boots exist for. Manifold-booting only; never boot OCCT in this file
// (see AGENTS.md — the two WASM kernels must not share a process).
import { describe, it, expect } from "vitest";
import opentype from "opentype.js";
import { PNG } from "pngjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootManifoldKernel } from "../src/testing/manifold.js";
import { meshToStl } from "../src/framework/geometry/mesh-stl.js";
import { cubeSoup } from "./helpers/cube-soup.js";

// A tiny flat-gray PNG, valid enough for decodePng/k.heightfield. Buffer's
// pooled-allocation gotcha (see test/images-jobs.test.js's own comment on this
// exact trap) means slicing by byteOffset/byteLength, not `.buffer.slice(0)`,
// is required to get exactly the encoded bytes.
function pngBytes(v = 180) {
  const p = new PNG({ width: 4, height: 4 });
  p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
  const buf = PNG.sync.write(p);
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
}

// Minimal real font, built the same way test/fonts-preload.test.js does, so we
// can assert the boot actually forwards font bytes through to a parsed
// opentype.Font in kernel._fonts (the shipped gap: bin/cli.js never passed
// `fonts` to the kernel boots).
function synthFont() {
  const g = (name, unicode, adv, draw) => {
    const p = new opentype.Path(); draw(p);
    return new opentype.Glyph({ name, unicode, advanceWidth: adv, path: p });
  };
  const notdef = g(".notdef", 0, 650, () => {});
  const H = g("H", 72, 700, (p) => { p.moveTo(50,0);p.lineTo(50,700);p.lineTo(150,700);p.lineTo(150,400);
    p.lineTo(550,400);p.lineTo(550,700);p.lineTo(650,700);p.lineTo(650,0);p.lineTo(550,0);p.lineTo(550,300);
    p.lineTo(150,300);p.lineTo(150,0);p.close(); });
  const font = new opentype.Font({ familyName: "Test", styleName: "Regular", unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs: [notdef, H] });
  font.kerningPairs = {};
  return font;
}

describe("node asset wiring", () => {
  it("boots resolve file: URL imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-import-"));
    const c = cubeSoup(10);
    writeFileSync(join(dir, "cube.stl"), Buffer.from(meshToStl(c.positions, c.indices)));
    const k = await bootManifoldKernel({ imports: { cube: new URL(`file://${join(dir, "cube.stl")}`) } });
    expect(k.import("cube").volume()).toBeCloseTo(1000, 0);
  });

  it("partforge measure works end-to-end on an importing part", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-cli-"));
    const c = cubeSoup(10);
    writeFileSync(join(dir, "cube.stl"), Buffer.from(meshToStl(c.positions, c.indices)));
    writeFileSync(join(dir, "part.js"), `
      export default {
        meta: { title: "imported" },
        imports: { cube: new URL("./cube.stl", import.meta.url) },
        defaults: {}, views: { main: {} },
        parts: { body: { views: ["main"], build: (k) => k.import("cube") } },
      };`);
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", join(dir, "part.js"), "--json"], { encoding: "utf8" });
    const report = JSON.parse(out);
    expect(report.subparts[0].volume).toBeCloseTo(1000, 0);
  }, 120000);

  // Positive regression for the shipped gap: bin/cli.js's bootKernel never
  // passed `part.fonts` down to bootManifoldKernel/bootOcctKernel, so a part's
  // declared fonts silently never reached the kernel. Assert the boot forwards
  // real font bytes through nodeAssetSources -> resolveFonts -> opentype.parse
  // and lands a parsed font in kernel._fonts, rather than relying on how
  // opentype fails on garbage bytes (brittle, and not the actual gap).
  it("boots resolve fonts too (the shipped gap)", async () => {
    const bytes = synthFont().toArrayBuffer();
    const k = await bootManifoldKernel({ fonts: { f: bytes } });
    expect(k._fonts.has("f")).toBe(true);
    const parsed = k._fonts.get("f");
    expect(parsed.unitsPerEm).toBe(1000);
    expect(parsed.glyphs.get(1).name).toBe("H");
  });

  // Third asset sibling, same shape as the two `imports` tests above: images
  // are the shipped gap Task 11 found and fixed (bin/cli.js's bootKernel never
  // passed `images` down to bootManifoldKernel/bootOcctKernel, so `partforge
  // measure|render` crashed with `heightfield: unknown image "…"` on any part
  // declaring `images`, even though the browser worker path — jobs.js — always
  // handled it correctly). Assert the boot forwards real PNG bytes through
  // nodeAssetSources -> ensureImages -> kernel._registerImage, all the way to a
  // k.heightfield() build actually producing a solid.
  it("boots resolve file: URL images (the shipped gap)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-image-"));
    writeFileSync(join(dir, "relief.png"), pngBytes());
    const k = await bootManifoldKernel({ images: { relief: new URL(`file://${join(dir, "relief.png")}`) } });
    expect(k._imageDigest("relief")).toBeTruthy();
    const solid = k.heightfield("relief", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 2 });
    expect(solid.volume()).toBeGreaterThan(0);
  });

  it("partforge measure works end-to-end on a part using images/k.heightfield", () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-cli-image-"));
    writeFileSync(join(dir, "relief.png"), pngBytes());
    writeFileSync(join(dir, "part.js"), `
      export default {
        meta: { title: "relief" },
        images: { relief: new URL("./relief.png", import.meta.url) },
        defaults: {}, views: { main: {} },
        parts: { plate: { views: ["main"],
          build: (k) => k.heightfield("relief", { w: 10, d: 10, base: 1, maxZ: 1, pitch: 2 }) } },
      };`);
    const out = execFileSync(process.execPath, ["bin/cli.js", "measure", join(dir, "part.js"), "--json"], { encoding: "utf8" });
    const report = JSON.parse(out);
    expect(report.subparts[0].volume).toBeGreaterThan(0);
  }, 120000);
});
