// scripts/make-step-fixture.mjs — regenerate the checked-in STEP fixture (10mm cube).
import { writeFileSync } from "node:fs";
import { bootOcctKernel } from "../src/testing/occt.js";
const k = await bootOcctKernel();
const bytes = await k.toSTEP([{ name: "box", solid: k.box({ size: [10, 10, 10] }) }]);
writeFileSync("test/fixtures/box-10mm.step", Buffer.from(bytes));
console.log("wrote test/fixtures/box-10mm.step");
process.exit(0);
