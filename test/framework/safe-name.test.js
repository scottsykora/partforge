// The shared hardened slug. Part-derived strings (meta.title, view labels,
// export names) are untrusted data, and every filesystem / zip-entry site
// funnels through this one function.
import { expect, test } from "vitest";
import { safeName } from "../../src/framework/safe-name.js";

test("ordinary titles slug the way they always did", () => {
  expect(safeName("Demo Spacer")).toBe("demo-spacer");
  expect(safeName("Spacer")).toBe("spacer");
  expect(safeName("v2.1_plate")).toBe("v2.1_plate");
});

test("traversal sequences are neutralized", () => {
  expect(safeName("../../.ssh/authorized")).toBe("ssh-authorized");
  expect(safeName("..")).toBe("part");
  expect(safeName("../")).toBe("part");
  expect(safeName("a/b\\c")).toBe("a-b-c");
  expect(safeName("/etc/passwd")).toBe("etc-passwd");
  expect(safeName("C:\\Windows\\System32")).toBe("c-windows-system32");
  for (const s of ["../../x", "..\\..\\x", "%2e%2e/x", "a\0/../b"])
    expect(safeName(s)).not.toMatch(/[/\\]|^\.|\0/);
});

test("dotfiles and trailing separators cannot be produced", () => {
  expect(safeName(".bashrc")).toBe("bashrc");
  expect(safeName(".")).toBe("part");
  expect(safeName("plate.")).toBe("plate");
  expect(safeName("-plate-")).toBe("plate");
});

test("input that sanitizes to nothing gets a usable fallback", () => {
  expect(safeName("")).toBe("part");
  expect(safeName(undefined)).toBe("part");
  expect(safeName(null)).toBe("part");
  expect(safeName("   ")).toBe("part");
  expect(safeName("日本語")).toBe("part");
  expect(safeName("🙂🙂")).toBe("part");
  expect(safeName("", "parts")).toBe("parts"); // caller-chosen fallback
});

test("runs of replaced characters collapse to a single dash", () => {
  expect(safeName("a   b")).toBe("a-b");
  expect(safeName("a<>&#b")).toBe("a-b");
});
