import { expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "./markdown";

test("parseMarkdown: fenced code, headings, lists and paragraphs", () => {
  const md = "# Title\n\nSome *text*\nmore\n\n```ts\nconst a = 1;\n\n```\n- one\n- two\n\n1. first\n2. second";
  expect(parseMarkdown(md)).toEqual([
    { type: "heading", level: 1, text: "Title" },
    { type: "paragraph", text: "Some *text*\nmore" },
    { type: "code", lang: "ts", text: "const a = 1;\n" },
    { type: "list", ordered: false, items: ["one", "two"] },
    { type: "list", ordered: true, items: ["first", "second"] },
  ]);
});

test("parseMarkdown: an unclosed fence keeps the rest as code (streaming text)", () => {
  expect(parseMarkdown("a\n```\nx")).toEqual([
    { type: "paragraph", text: "a" },
    { type: "code", lang: "", text: "x" },
  ]);
});

test("parseInline: code, bold, italic, http(s) links only", () => {
  expect(parseInline("a `b*c` **d** _e_ [f](https://x.y) [g](javascript:alert(1))")).toEqual([
    { type: "text", text: "a " },
    { type: "code", text: "b*c" },
    { type: "text", text: " " },
    { type: "bold", text: "d" },
    { type: "text", text: " " },
    { type: "italic", text: "e" },
    { type: "text", text: " " },
    { type: "link", text: "f", href: "https://x.y" },
    { type: "text", text: " [g](javascript:alert(1))" },
  ]);
});
