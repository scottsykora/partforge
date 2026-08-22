// CLI-facing twin of the inline fixture in describe-job.test.js — same washer STL, but
// a real file default-exporting a PartDefinition, since `bin/cli.js`'s `loadPart` needs
// a module on disk with `parts`/`views`, not the bare `{name, imports, parts, views}`
// object `handle()` accepts directly. Used by test/cli-describe.test.js to exercise the
// `budget-exceeded` warning path through the actual CLI process, with a low `--budget`
// forcing the acceptance loop to run out of attempts before the residual converges.
export default {
  meta: { title: "describe-washer fixture", units: "mm" },
  imports: { scan: new URL("./describe-washer.stl", import.meta.url) },
  parameters: [],
  defaults: {},
  parts: { body: { build: (k) => k.import("scan") } },
  views: { default: { label: "Default" } },
};
