import { test, expect } from "vitest";
import { imageSourceAllowed, imageControlAllows, isNoImageSource } from "../src/framework/image-source.js";

test("https is allowed by default", () => {
  expect(imageSourceAllowed("https://cdn.test/d.png")).toBe(true);
  expect(imageSourceAllowed("http://cdn.test/d.png")).toBe(false);
});

test("a pfc-asset token needs the asset kind", () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/depth.png";
  expect(imageSourceAllowed(tok, ["asset"])).toBe(true);
  expect(imageSourceAllowed(tok, ["https"])).toBe(false);
});

// Replaces the brief's "hostname spoofing is refused" test — see the ADDENDUM
// FROM THE CONTROLLER in task-4-brief.md, Ruling E. That test's name and its
// first assertion contradicted each other: `allow:["https"]` deliberately
// means "any https URL", userinfo tricks included, so asserting `true` there
// is correct behaviour, not a hole — but naming the test "spoofing is
// refused" invites a future reader to "fix" the code to match the name
// instead of the code's actual (correct) contract. Split into two tests that
// each say what they actually check.
test("an https URL with userinfo still passes an https-only allow list", () => {
  // Not a hole: `allow:["https"]` means "any https URL". The userinfo case is
  // only interesting for host-specific kinds — see the asset test below.
  expect(imageSourceAllowed("https://cdn.test@evil.test/d.png", ["https"])).toBe(true);
  expect(imageSourceAllowed("javascript:alert(1)", ["https"])).toBe(false);
  expect(imageSourceAllowed("not a url", ["https"])).toBe(false);
});

test("the asset kind matches on scheme, and a lookalike cannot forge it", () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/depth.png";
  expect(imageSourceAllowed(tok, ["asset"])).toBe(true);
  // A URL that merely CONTAINS the scheme text must not pass.
  expect(imageSourceAllowed("https://evil.test/pfc-asset://x/depth.png", ["asset"])).toBe(false);
  expect(imageSourceAllowed("https://pfc-asset.evil.test/depth.png", ["asset"])).toBe(false);
});

// The security rule that is genuinely new here (and deliberately inverts
// font-source.js): a byte source cannot have arrived via a shared link — a
// URL cannot carry megabytes — so it can only have been placed in `params` by
// the host's own trusted panel code. Bytes therefore bypass the allow check
// entirely, for every allow list, including an empty one.
test("BYTES bypass the allow check — they cannot have come from a shared link", () => {
  expect(imageSourceAllowed(new ArrayBuffer(8), ["https"])).toBe(true);
  expect(imageSourceAllowed(new Uint8Array(8), ["https"])).toBe(true);
  expect(imageSourceAllowed(new ArrayBuffer(8), [])).toBe(true);
});

test("an empty value is 'unset', never 'disallowed'", () => {
  expect(isNoImageSource("")).toBe(true);
  expect(isNoImageSource(undefined)).toBe(true);
  expect(imageSourceAllowed("", ["https"])).toBe(false);
});

test("isNoImageSource is exactly the empty triple — not a general falsiness test", () => {
  for (const v of [undefined, null, ""]) expect(isNoImageSource(v), String(v)).toBe(true);
  for (const v of ["https://x.test/a.png", 0, false, new ArrayBuffer(4), " "]) {
    expect(isNoImageSource(v), String(v)).toBe(false);
  }
});

test("imageControlAllows walks nested groups and legacy arrays", () => {
  const part = { parameters: [
    { controls: [{ key: "a", type: "image" },
                 { type: "group", controls: [{ key: "b", type: "image", allow: ["asset"] }] }] },
    { advanced: [{ key: "c", control: "image" }] },
  ] };
  const m = imageControlAllows(part);
  expect(m.get("a")).toEqual(["https"]);
  expect(m.get("b")).toEqual(["asset"]);
  expect(m.get("c")).toEqual(["https"]);
});

test("imageControlAllows finds an image control nested inside a legacy `features` array, and ignores non-image controls", () => {
  const part = { parameters: [
    { id: "t", features: [
      { key: "shown", on: 1 },
      { key: "relief", control: "image", allow: ["gstatic"] },
    ] },
    { controls: [{ key: "size", type: "slider" }] },
  ] };
  const m = imageControlAllows(part);
  expect(m.get("relief")).toEqual(["gstatic"]);
  expect(m.has("shown")).toBe(false);
  expect(m.has("size")).toBe(false);
});
