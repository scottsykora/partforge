import { test, expect } from "vitest";
import { vectorSourceAllowed, vectorControlAllows, isNoVectorSource } from "../src/framework/vector-source.js";

test("https is allowed by default", () => {
  expect(vectorSourceAllowed("https://cdn.test/d.svg")).toBe(true);
  expect(vectorSourceAllowed("http://cdn.test/d.svg")).toBe(false);
});

test("a pfc-asset token needs the asset kind", () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/art.svg";
  expect(vectorSourceAllowed(tok, ["asset"])).toBe(true);
  expect(vectorSourceAllowed(tok, ["https"])).toBe(false);
});

test("an https URL with userinfo still passes an https-only allow list", () => {
  expect(vectorSourceAllowed("https://cdn.test@evil.test/d.svg", ["https"])).toBe(true);
  expect(vectorSourceAllowed("javascript:alert(1)", ["https"])).toBe(false);
  expect(vectorSourceAllowed("not a url", ["https"])).toBe(false);
});

test("the asset kind matches on scheme, and a lookalike cannot forge it", () => {
  const tok = "pfc-asset://11111111-2222-3333-4444-555555555555/art.svg";
  expect(vectorSourceAllowed(tok, ["asset"])).toBe(true);
  expect(vectorSourceAllowed("https://evil.test/pfc-asset://x/art.svg", ["asset"])).toBe(false);
  expect(vectorSourceAllowed("https://pfc-asset.evil.test/art.svg", ["asset"])).toBe(false);
});

// The rule that genuinely diverges from font-source.js/image-source.js — see
// vector-source.js's header. Those two exempt bytes from the allow check on
// the "can't survive a link" plausibility argument; that argument is FALSE
// for a parsed vector document (plain JSON round-trips a link perfectly), so
// this file exempts it on a different, still-sufficient basis: the resolver
// only ever calls `fetch` for a string/URL source (asset-resolve.js, Task 7).
test("an already-parsed document object bypasses the allow check — it structurally never reaches fetch", () => {
  const doc = { format: "partforge-vector", version: 1, units: "mm", shapes: {} };
  expect(vectorSourceAllowed(doc, ["https"])).toBe(true);
  expect(vectorSourceAllowed(doc, [])).toBe(true); // even the empty allow list
});

// Bytes get the same pass for the same structural reason (never handed to
// `fetch`) — NOT the plausibility argument the two siblings use. Spelled out
// as its own test so a reader who copies the sibling reasoning here finds it
// contradicted immediately.
test("bytes bypass the allow check too, for the structural (not plausibility) reason", () => {
  expect(vectorSourceAllowed(new ArrayBuffer(8), ["https"])).toBe(true);
  expect(vectorSourceAllowed(new Uint8Array(8), [])).toBe(true);
});

test("an empty value is 'unset', never 'disallowed'", () => {
  expect(isNoVectorSource("")).toBe(true);
  expect(isNoVectorSource(undefined)).toBe(true);
  expect(vectorSourceAllowed("", ["https"])).toBe(false);
});

test("isNoVectorSource is exactly the empty triple — not a general falsiness test", () => {
  for (const v of [undefined, null, ""]) expect(isNoVectorSource(v), String(v)).toBe(true);
  for (const v of ["https://x.test/a.svg", 0, false, new ArrayBuffer(4), {}, " "]) {
    expect(isNoVectorSource(v), String(v)).toBe(false);
  }
});

test("vectorControlAllows walks nested groups and legacy arrays", () => {
  const part = { parameters: [
    { controls: [{ key: "a", type: "vector" },
                 { type: "group", controls: [{ key: "b", type: "vector", allow: ["asset"] }] }] },
    { advanced: [{ key: "c", control: "vector" }] },
  ] };
  const m = vectorControlAllows(part);
  expect(m.get("a")).toEqual(["https"]);
  expect(m.get("b")).toEqual(["asset"]);
  expect(m.get("c")).toEqual(["https"]);
});

test("vectorControlAllows finds a vector control nested inside a legacy `features` array, and ignores non-vector controls", () => {
  const part = { parameters: [
    { id: "t", features: [
      { key: "shown", on: 1 },
      { key: "art", control: "vector", allow: ["gstatic"] },
    ] },
    { controls: [{ key: "size", type: "slider" }] },
  ] };
  const m = vectorControlAllows(part);
  expect(m.get("art")).toEqual(["gstatic"]);
  expect(m.has("shown")).toBe(false);
  expect(m.has("size")).toBe(false);
});

// The module-wrapper hole: asset-resolve.js runs `unwrapModule` BEFORE it
// dispatches on the source's shape, so `{ default: "http://…" }` is unwrapped
// to a string and fetched. It is ~40 bytes of plain JSON, so it round-trips a
// share link perfectly — exactly the value class this file exists to gate.
test("a { default: … } wrapper is judged by what it unwraps to, not by being an object", () => {
  expect(vectorSourceAllowed({ default: "http://169.254.169.254/latest/meta-data/" }, ["https"])).toBe(false);
  expect(vectorSourceAllowed({ default: "https://cdn.test/d.vector.json" }, ["https"])).toBe(true);
  expect(vectorSourceAllowed({ default: "https://cdn.test/d.vector.json" }, ["asset"])).toBe(false);
});

test("a thunk is refused — its return value cannot be known at check time", () => {
  expect(vectorSourceAllowed(() => "https://cdn.test/d.vector.json", ["https"])).toBe(false);
  expect(vectorSourceAllowed({ default: () => "https://cdn.test/d.vector.json" }, ["https"])).toBe(false);
});

test("a URL instance is fetched by the resolver, so it is gated like the string it is", () => {
  expect(vectorSourceAllowed(new URL("https://cdn.test/d.vector.json"), ["https"])).toBe(true);
  expect(vectorSourceAllowed(new URL("http://169.254.169.254/latest/meta-data/"), ["https"])).toBe(false);
  expect(vectorSourceAllowed({ default: new URL("http://169.254.169.254/") }, ["https"])).toBe(false);
});
