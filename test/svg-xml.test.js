import { expect, test } from "vitest";
import { parseSvgXml } from "../src/framework/geometry/svg-xml.js";

test("parses a root element with attributes", () => {
  const n = parseSvgXml('<svg viewBox="0 0 24 24" width="24"></svg>');
  expect(n.tag).toBe("svg");
  expect(n.attrs.viewBox).toBe("0 0 24 24");
  expect(n.attrs.width).toBe("24");
  expect(n.children).toEqual([]);
});

test("parses nested children and self-closing tags", () => {
  const n = parseSvgXml('<svg><g><path d="M0,0 L1,1"/><circle r="2"/></g></svg>');
  expect(n.children).toHaveLength(1);
  const g = n.children[0];
  expect(g.tag).toBe("g");
  expect(g.children.map((c) => c.tag)).toEqual(["path", "circle"]);
  expect(g.children[0].attrs.d).toBe("M0,0 L1,1");
});

test("strips namespace prefixes from tags and lowercases them", () => {
  const n = parseSvgXml('<svg:SVG xmlns:svg="http://www.w3.org/2000/svg"><svg:Path d="M0,0"/></svg:SVG>');
  expect(n.tag).toBe("svg");
  expect(n.children[0].tag).toBe("path");
});

test("accepts single-quoted attributes and decodes the five predefined entities", () => {
  const n = parseSvgXml("<svg title='a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'></svg>");
  expect(n.attrs.title).toBe(`a & b <c> "d" 'e'`);
});

test("skips comments, the XML declaration, and a DOCTYPE", () => {
  const n = parseSvgXml('<?xml version="1.0"?><!DOCTYPE svg><!-- hi --><svg><path d="M0,0"/></svg>');
  expect(n.tag).toBe("svg");
  expect(n.children).toHaveLength(1);
});

test("accepts a Uint8Array and an ArrayBuffer", () => {
  const bytes = new TextEncoder().encode("<svg></svg>");
  expect(parseSvgXml(bytes).tag).toBe("svg");
  expect(parseSvgXml(bytes.buffer.slice(0)).tag).toBe("svg");
});

test("throws on a mismatched closing tag", () => {
  expect(() => parseSvgXml("<svg><g></path></svg>")).toThrow(/svg: /);
});

test("throws on an unterminated tag rather than hanging", () => {
  expect(() => parseSvgXml('<svg><path d="M0,0"')).toThrow(/svg: /);
});

test("throws when there is no root element", () => {
  expect(() => parseSvgXml("   <!-- nothing -->  ")).toThrow(/svg: /);
});
