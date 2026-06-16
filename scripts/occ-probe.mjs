import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
const require = createRequire(import.meta.url);
globalThis.require = globalThis.require ?? require;
globalThis.__dirname = globalThis.__dirname ?? path.dirname(fileURLToPath(import.meta.url));
const { default: initOC } = await import("replicad-opencascadejs/src/replicad_single.js");
const oc = await initOC({ wasmBinary: fs.readFileSync(require.resolve("replicad-opencascadejs/src/replicad_single.wasm")) });
const names = ["BRepAlgoAPI_Cut_1","BRepAlgoAPI_Cut_3","TopTools_ListOfShape_1","Message_ProgressRange_1"];
for (const n of names) console.log(`${n}: ${typeof oc[n]}`);
try {
  const c = new oc.BRepAlgoAPI_Cut_1();
  for (const m of ["SetArguments","SetTools","SetFuzzyValue","Build","Shape","SetRunParallel"])
    console.log(`  Cut_1.${m}: ${typeof c[m]}`);
  const L = new oc.TopTools_ListOfShape_1();
  for (const m of ["Append_1","Append_2","Size"]) console.log(`  List.${m}: ${typeof L[m]}`);
} catch (e) { console.log("probe err:", e.message || e); }
