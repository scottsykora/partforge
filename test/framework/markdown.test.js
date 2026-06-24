// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { renderMarkdown } from "../../src/framework/markdown.js";

test("renders basic formatting", () => {
  const html = renderMarkdown("**bold** *italic* `code`");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<em>italic</em>");
  expect(html).toContain("<code>code</code>");
});

test("renders a list", () => {
  const html = renderMarkdown("- one\n- two");
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>one</li>");
});

test("links open in a new tab with rel=noopener", () => {
  const html = renderMarkdown("[docs](https://example.com/x)");
  expect(html).toMatch(/href="https:\/\/example\.com\/x"/);
  expect(html).toMatch(/target="_blank"/);
  expect(html).toMatch(/rel="noopener noreferrer"/);
});

test("renders an image", () => {
  const html = renderMarkdown("![a diagram](https://example.com/d.png)");
  expect(html).toMatch(/<img [^>]*src="https:\/\/example\.com\/d\.png"/);
  expect(html).toMatch(/alt="a diagram"/);
});

test("strips script, event-handler, and javascript: payloads", () => {
  expect(renderMarkdown("<script>alert(1)</script>")).not.toContain("<script");
  expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("onerror");
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("javascript:");
});

test("blank input renders empty string", () => {
  expect(renderMarkdown("")).toBe("");
  expect(renderMarkdown("   ")).toBe("");
  expect(renderMarkdown(undefined)).toBe("");
});
