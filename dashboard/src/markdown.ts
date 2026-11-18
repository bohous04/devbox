// A small markdown subset for assistant messages: fenced code, headings, lists, paragraphs and inline code,
// bold, italic and http(s) links. Parsed into plain data and rendered as React elements (never as HTML), so
// agent text cannot inject markup. Anything outside the subset shows as its literal text.

export type MdBlock =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "paragraph"; text: string };

export type MdInline =
  | { type: "text" | "code" | "bold" | "italic"; text: string }
  | { type: "link"; text: string; href: string };

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

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
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)|(?<![\w*])\*([^*\s][^*]*)\*(?![\w*])|(?<!\w)_([^_\s][^_]*)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    if (m.index > last) out.push({ type: "text", text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ type: "code", text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ type: "bold", text: (m[2] ?? m[3])! });
    else if (m[4] !== undefined || m[5] !== undefined) out.push({ type: "italic", text: (m[4] ?? m[5])! });
    else out.push({ type: "link", text: m[6], href: m[7] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: "text", text: src.slice(last) });
  return out;
}
