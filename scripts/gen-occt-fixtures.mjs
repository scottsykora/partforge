// Runs in its OWN process (OCCT only) — Manifold + OCCT can't share a process.
// Generates test/fixtures/occt-volumes.json with volume + bbox for "small" and "big" drums.
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dir = path.dirname(__filename);

// Boot OCCT via the shared helper (must NOT import manifold-3d here)
const { bootOcctKernel } = await import("../test/occt-kernel.js");
const { meshVolume, bboxSize } = await import("../test/helpers.js");
const { buildSubPart } = await import("../src/drum.js");

const k = await bootOcctKernel();
const out = {};
for (const name of ["small", "big"]) {
  console.log(`Building ${name}...`);
  const m = buildSubPart(k, name, {}).toMesh({ quality: "preview" });
  out[name] = {
    volume: meshVolume(m.positions, m.indices),
    size: bboxSize(m.positions),
  };
  console.log(`  ${name}: volume=${out[name].volume.toFixed(1)}, size=[${out[name].size.map(x => x.toFixed(2)).join(", ")}]`);
}

const dir = path.join(__dir, "../test/fixtures");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "occt-volumes.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote test/fixtures/occt-volumes.json", out);
