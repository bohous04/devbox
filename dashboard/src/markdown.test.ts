import { expect, test } from "bun:test";
import { codeOnly, isPathLike, parseInline, parseMarkdown } from "./markdown";

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

test("parseInline: intra-word _ and * stay literal; delimited emphasis still works", () => {
  expect(parseInline("set CLAUDE_CONFIG_DIR and my_var_name")).toEqual([{ type: "text", text: "set CLAUDE_CONFIG_DIR and my_var_name" }]);
  expect(parseInline("my_file_name.ts")).toEqual([{ type: "text", text: "my_file_name.ts" }]);
  expect(parseInline("2*3*4")).toEqual([{ type: "text", text: "2*3*4" }]);
  expect(parseInline("a__b__c")).toEqual([{ type: "text", text: "a__b__c" }]);
  expect(parseInline("_italic_ and *italic*")).toEqual([
    { type: "italic", text: "italic" }, { type: "text", text: " and " }, { type: "italic", text: "italic" },
  ]);
  expect(parseInline("(__bold__)")).toEqual([{ type: "text", text: "(" }, { type: "bold", text: "bold" }, { type: "text", text: ")" }]);
});

test("parseMarkdown: GFM tables with alignment, inline code holding a pipe, and ragged rows", () => {
  const md = "Intro\n| Check | Result |\n|:---|---:|\n| `a | b` | ✅ ok |\n| only one |\n\nafter";
  expect(parseMarkdown(md)).toEqual([
    { type: "paragraph", text: "Intro" },
    { type: "table", align: ["left", "right"], header: ["Check", "Result"], rows: [["`a | b`", "✅ ok"], ["only one", ""]] },
    { type: "paragraph", text: "after" },
  ]);
  expect(parseMarkdown("a | b\n--|--\nc | d")).toEqual([{ type: "table", align: [null, null], header: ["a", "b"], rows: [["c", "d"]] }]);
});

test("parseMarkdown: a pipe line without a matching delimiter row stays a paragraph", () => {
  expect(parseMarkdown("a | b\n---")).toEqual([{ type: "paragraph", text: "a | b\n---" }]);
  expect(parseMarkdown("x | y\nz")).toEqual([{ type: "paragraph", text: "x | y\nz" }]);
});

test("parseInline: bare http(s) URLs link, without trailing punctuation; other schemes stay text", () => {
  expect(parseInline("See https://github.com/x/y. Or (https://a.b/c?d=1), ftp://n")).toEqual([
    { type: "text", text: "See " },
    { type: "link", text: "https://github.com/x/y", href: "https://github.com/x/y" },
    { type: "text", text: ". Or (" },
    { type: "link", text: "https://a.b/c?d=1", href: "https://a.b/c?d=1" },
    { type: "text", text: "), ftp://n" },
  ]);
  expect(parseInline("`https://in.code`")).toEqual([{ type: "code", text: "https://in.code" }]);
});

test("parseInline: ✅ ❌ ⚠️ (with or without U+FE0F) become status parts; other emoji stay text", () => {
  expect(parseInline("✅ 6 pass, ❌ TS5112, ⚠️ slow ⚠ 🎉")).toEqual([
    { type: "status", kind: "ok", text: "✅" },
    { type: "text", text: " 6 pass, " },
    { type: "status", kind: "fail", text: "❌" },
    { type: "text", text: " TS5112, " },
    { type: "status", kind: "warn", text: "⚠️" },
    { type: "text", text: " slow " },
    { type: "status", kind: "warn", text: "⚠" },
    { type: "text", text: " 🎉" },
  ]);
  expect(parseInline("`✅` **❌**")).toEqual([{ type: "code", text: "✅" }, { type: "text", text: " " }, { type: "bold", text: "❌" }]);
});

test("isPathLike: files and folders yes; flags, versions, commands and words no", () => {
  for (const p of ["src/sync/queue.ts", "queue.ts", "tsconfig.json", "notes/", ".env.local", "./run.sh", "README.md"]) expect(isPathLike(p)).toBe(true);
  for (const p of ["--strict", "2.0", "a -- b", "bun test", "kebab-case-word", "a-b-c", "https://x.y/z", "e.g", "1/2"]) expect(isPathLike(p)).toBe(false);
});

test("codeOnly: a table cell that is one code span (a command, a path) gives its text; anything else null", () => {
  expect(codeOnly(" `bun test src/a.ts` ")).toBe("bun test src/a.ts");
  expect(codeOnly("`a` and `b`")).toBeNull();
  expect(codeOnly("run `a`")).toBeNull();
  expect(codeOnly("``")).toBeNull();
  expect(codeOnly("plain")).toBeNull();
  expect(codeOnly("`a`[x](u)")).toBeNull();
  expect(codeOnly("[`a`](u)")).toBeNull();
});
