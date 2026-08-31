// test/ingest-registry.test.js
import { describe, test, expect } from "vitest";
import { ASSET_KINDS, rowFor, classify, convertFor } from "../src/framework/ingest/registry.js";

const u8 = (...b) => Uint8Array.from(b);
const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const PNG = u8(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const SVG = ascii("<svg></svg>");
const TTF = u8(0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0);
const WOFF2 = ascii("wOF2");

describe("registry", () => {
  test("declares exactly the three asset kinds", () => {
    expect(ASSET_KINDS).toEqual(["image", "vector", "font"]);
  });

  test("every kind has a row with a non-empty accepts list and a label", () => {
    for (const k of ASSET_KINDS) {
      const row = rowFor(k);
      expect(row, k).toBeTruthy();
      expect(row.accepts.length, k).toBeGreaterThan(0);
      expect(typeof row.label, k).toBe("string");
    }
  });

  test("an unknown kind has no row", () => {
    expect(rowFor("nope")).toBeUndefined();
  });

  test("fonts declare no converter — used as-is", () => {
    expect(rowFor("font").convert).toBe(null);
  });

  test("accepts the right bytes for each kind", () => {
    expect(classify(PNG, "image").ok).toBe(true);
    expect(classify(SVG, "vector").ok).toBe(true);
    expect(classify(TTF, "font").ok).toBe(true);
  });

  test("rejects the wrong kind AND names where it belongs", () => {
    const r = classify(SVG, "image");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe("image/svg+xml");
    expect(r.suggestKind).toBe("vector");   // drives the "use the Artwork slot" message
  });

  test("rejects a right-kind-wrong-format file by name, not as unknown", () => {
    const r = classify(WOFF2, "font");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe("font/woff2");
    expect(r.suggestKind).toBe(null);       // belongs to no slot — it is just unsupported
  });

  test("unrecognised bytes report no media type", () => {
    const r = classify(u8(1, 2, 3, 4, 5, 6, 7, 8), "image");
    expect(r.ok).toBe(false);
    expect(r.mediaType).toBe(null);
  });

  test("convertFor resolves a function for a converting kind", async () => {
    expect(typeof await convertFor("vector", "image/svg+xml")).toBe("function");
    expect(typeof await convertFor("image", "image/jpeg")).toBe("function");
  });

  test("convertFor returns null for a used-as-is kind", async () => {
    expect(await convertFor("font", "font/ttf")).toBe(null);
  });
});
