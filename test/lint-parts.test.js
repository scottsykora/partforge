// Every shipped part must lint clean. This is the regression net that would have
// caught the nameplate/bracket `features`-without-`sliders` bug before a browser boot.
// A failure here is a real defect in the part — fix the part, never the linter.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { lintPart } from "../src/lint.js";

const files = readdirSync(fileURLToPath(new URL("../src/parts", import.meta.url))).filter((f) => f.endsWith(".js"));

test("src/parts is not empty (the sweep would pass vacuously otherwise)", () => {
  expect(files.length).toBeGreaterThan(0);
});

test.each(files)("%s lints without errors", async (file) => {
  const mod = await import(`../src/parts/${file}`);
  const report = lintPart(mod.default);
  const detail = report.errors.map((f) => `${f.rule} @ ${f.path}: ${f.message}`).join("\n");
  expect(report.errors, `\n${detail}`).toEqual([]);
});
