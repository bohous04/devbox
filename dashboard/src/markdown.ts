// A small markdown subset for assistant messages: fenced code, headings, lists, GFM tables, paragraphs and inline
// code, bold, italic, http(s) links and bare http(s) URLs. Parsed into plain data and rendered as React elements (never as HTML), so
// agent text cannot inject markup. Anything outside the subset shows as its literal text.

export type MdBlock =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; align: ("left" | "center" | "right" | null)[]; header: string[]; rows: string[][] }
  | { type: "paragraph"; text: string };

export type StatusKind = "ok" | "fail" | "warn";

export type MdInline =
  | { type: "text" | "code" | "bold" | "italic"; text: string }
  /** A status emoji the agent used (✅ ❌ ⚠️): drawn as an icon, the emoji kept as its accessible text. */
  | { type: "status"; kind: StatusKind; text: string }
  | { type: "link"; text: string; href: string };

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells: split on `|` outside inline code (`\|` is a literal pipe), outer pipes optional. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cur = "", code = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  if (/^\s*\|/.test(line)) cells.shift();
  if (/\|\s*$/.test(line) && !/\\\|\s*$/.test(line)) cells.pop();
  return cells;
}

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ type: "paragraph", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      // An unclosed fence (text still streaming) keeps the rest as code.
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push({ type: "code", lang: fence[1], text: code.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { flush(); out.push({ type: "heading", level: h[1].length, text: h[2] }); continue; }
    // A table: a header row with a pipe, then a delimiter row with as many columns.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = tableCells(line);
      const delim = tableCells(lines[i + 1]);
      if (delim.length === header.length) {
        flush();
        const align = delim.map((d) => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
        const rows: string[][] = [];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++) {
          const cells = tableCells(lines[i]);
          rows.push(header.map((_, j) => cells[j] ?? ""));
        }
        i--;
        out.push({ type: "table", align, header, rows });
        continue;
      }
    }
    const listRe = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listRe) {
      flush();
      const items: string[] = [];
      for (; i < lines.length && listRe.test(lines[i]); i++) items.push(listRe.exec(lines[i])![1]);
      i--;
      out.push({ type: "list", ordered: listRe === NUMBERED, items });
      continue;
    }
    if (line.trim() === "") { flush(); continue; }
    para.push(line);
  }
  flush();
  return out;
}

// `_`, `__` and single `*` only count outside words: `CLAUDE_CONFIG_DIR`, `my_file.ts` and `2*3*4` stay literal.
// A bare URL ends before trailing punctuation, so "see https://x.y." links https://x.y.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])|(?<!\w)_([^_\s][^_]*)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w/])(https?:\/\/[^\s<>()"'`]*[^\s<>()"'`.,;:!?])/g;

// Only these status emoji become icons; every other emoji stays text. The optional U+FE0F is part of the match.
const STATUS = /(✅|✔️?|☑️?|❌|✖️?|⚠️?)/u;
const STATUS_KIND: Record<string, StatusKind> = { "✅": "ok", "✔": "ok", "☑": "ok", "❌": "fail", "✖": "fail", "⚠": "warn" };

/** Plain text with any status emoji split out. */
function textWithStatus(text: string): MdInline[] {
  return text.split(STATUS).filter((t) => t !== "").map((t) => {
    const kind = STATUS_KIND[t.replace("\uFE0F", "")];
    return kind ? { type: "status", kind, text: t } : { type: "text", text: t };
  });
}

export function parseInline(src: string): MdInline[] {
  return parseInlineRaw(src).flatMap((p) => (p.type === "text" ? textWithStatus(p.text) : [p]));
}

function parseInlineRaw(src: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: "text", text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: "bold", text: (m[2] ?? m[3])! });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ type: "italic", text: (m[4] ?? m[5])! });
    else if (m[6] !== undefined) out.push({ type: "link", text: m[6], href: m[7] });
    else out.push({ type: "link", text: m[8], href: m[8] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", text: src.slice(last) });
  return out;
}

/** Inline code that names a file or folder (`src/queue.ts`, `tsconfig.json`, `notes/`): no spaces, and a slash
 *  or a file extension (2-6 characters) after a name with a letter. Flags (`--strict`), versions (`2.0`) and words stay code. */
export function isPathLike(code: string): boolean {
  if (/\s/.test(code) || code.startsWith("-") || /^https?:/.test(code)) return false;
  if (code.includes("/")) return /[A-Za-z]/.test(code);
  return /^[\w.@~-]*[A-Za-z_][\w-]*\.[A-Za-z][A-Za-z0-9]{1,5}$/.test(code);
}
