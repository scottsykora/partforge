import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// execFileSync, not a direct function call: the bug this guards is CLI WIRING,
// and a direct call is blind to it. That distinction already earned its keep —
// the images branch shipped a bootKernel gap no direct-boot test could see.
const cli = (...args) =>
  execFileSync("node", ["bin/cli.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("partforge ingest", () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pf-ingest-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("converts an SVG to partforge-vector JSON", () => {
    const src = join(dir, "a.svg");
    // fill is explicit, not left to the SVG default: paper.js's default-fill
    // resolution does not work under happy-dom (confirmed even under vitest's
    // OWN happy-dom test environment, not just this CLI's manually-built DOM)
    // — every fixture in test/svg-ingest.test.js sets fill explicitly for the
    // same reason. The brief's literal fixture (`<rect width="10" height="10"/>`,
    // no fill) relied on the implicit default and cannot pass anywhere.
    writeFileSync(src, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#111"/></svg>');
    const out = join(dir, "a.vector.json");
    cli("ingest", src, "--out", out);
    const doc = JSON.parse(readFileSync(out, "utf8"));
    expect(doc.units).toBeTruthy();
    // doc.shapes is a MAP of name -> region list (svg-ingest.js's own doc
    // comment: "`shapes` maps a name to a list of filled regions"), not an
    // array itself — the brief's literal `Array.isArray(doc.shapes)` assertion
    // does not match the real partforge-vector format (see VECTOR-FORMAT.md).
    expect(doc.shapes && typeof doc.shapes).toBe("object");
    expect(Array.isArray(doc.shapes.artwork)).toBe(true);
    expect(doc.shapes.artwork.length).toBeGreaterThan(0);
  });

  test("passes a PNG through and validates it", () => {
    const src = join(dir, "a.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const out = join(dir, "copy.png");
    cli("ingest", src, "--out", out);
    expect(readFileSync(out)[0]).toBe(0x89);
  });

  test("refuses a JPEG, pointing at the browser path", () => {
    const src = join(dir, "a.jpg");
    writeFileSync(src, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    let msg = "";
    try { cli("ingest", src, "--out", join(dir, "x.png")); }
    catch (e) { msg = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    expect(msg).toMatch(/browser|imageToPng/i);
  });

  test("refuses an unrecognised file without guessing", () => {
    const src = join(dir, "a.bin");
    writeFileSync(src, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    let msg = "";
    try { cli("ingest", src, "--out", join(dir, "x")); }
    catch (e) { msg = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    expect(msg).toMatch(/unrecognis|unsupported/i);
  });

  test("requires --out — a surprising default would be worse than an explicit one", () => {
    const src = join(dir, "a.png");
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    let failed = false, msg = "";
    try { cli("ingest", src); }
    catch (e) { failed = true; msg = `${e.stdout ?? ""}${e.stderr ?? ""}`; }
    expect(failed).toBe(true);
    expect(msg).toMatch(/--out/);
  });
});
