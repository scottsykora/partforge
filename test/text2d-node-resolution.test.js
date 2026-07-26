import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";

// Regression guard for the opentype.js interop break.
//
// opentype.js 2.x ships no `exports` map, so resolvers disagree: bundlers take its
// `module` field (real ESM, named `parse`) while Node ESM takes `main` (a UMD/CJS
// bundle whose named exports Node cannot statically detect — the namespace holds
// only `default`). A bare `import * as opentype` therefore yields a working
// `.parse` in the browser and `undefined` under Node, so every headless text2d
// build threw "opentype.parse is not a function" while the browser stayed green.
//
// This test MUST spawn a real `node` subprocess: Vitest resolves the `module`
// field, so an in-process test passes either way and cannot see the bug at all.
// That blind spot is why the break shipped.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("text2d builds under Node's own module resolution", () => {
  const script = `
    import { bootManifoldKernel } from "./src/testing.js";
    const k = await bootManifoldKernel();
    const solid = k.extrude({ profile: k.text2d("AB", { size: 8 }), h: 2 });
    const [x, y, z] = solid.boundingBox().size;
    if (!(x > 0 && y > 0 && z > 0)) throw new Error("degenerate text solid");
    console.log("ok");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(out).toContain("ok");
});
