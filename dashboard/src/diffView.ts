/** One rendered line of a unified diff. `old`/`new` are the line numbers on each side (null where the line has
 *  none: a hunk header, the side it was added to or removed from, a "\ No newline" note). */
export interface DiffLine { kind: "hunk" | "add" | "del" | "ctx" | "note"; text: string; old: number | null; new: number | null }

/** The lines of a unified diff (git diff output) for display. The per-file header (diff --git, index, ---/+++)
 *  is dropped: the card already names the file. Inside a hunk, "---"/"+++" are ordinary removed/added lines. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let inHunk = false, o = 0, n = 0;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true; o = Number(hunk[1]); n = Number(hunk[2]);
      out.push({ kind: "hunk", text: line, old: null, new: null });
    } else if (line.startsWith("diff ")) inHunk = false;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) out.push({ kind: "add", text: line.slice(1), old: null, new: n++ });
    else if (line.startsWith("-")) out.push({ kind: "del", text: line.slice(1), old: o++, new: null });
    else if (line.startsWith("\\")) out.push({ kind: "note", text: line, old: null, new: null });
    else out.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
  }
  return out;
}

/** Runs at most `n` tasks at once; the rest wait in call order. "Open diffs" on a long list fetches through it. */
export function limiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return <T>(task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      task().then(resolve, reject).finally(() => { running--; waiting.shift()?.(); });
    };
    if (running < n) start(); else waiting.push(start);
  });
}

/** "Open diffs" is offered up to this many files; a longer list opens one file at a time. */
export const OPEN_ALL_MAX = 30;

/** A diff line split into plain text and escapes. Combining marks, control and format characters (zero-width,
 *  bidi overrides) are invisible or bend the text around them, which hides what a line really contains (Trojan
 *  Source); the diff shows them as `̀` instead. A tab stays a tab. */
export type DiffTextPart = { text: string; escaped: boolean };
const INVISIBLE = /[\p{Mn}\p{Me}\p{Cc}\p{Cf}]/u;
export function escapeInvisible(line: string): DiffTextPart[] {
  const parts: DiffTextPart[] = [];
  let plain = "";
  for (const ch of line) {
    if (ch === "\t" || !INVISIBLE.test(ch)) { plain += ch; continue; }
    if (plain) { parts.push({ text: plain, escaped: false }); plain = ""; }
    const cp = ch.codePointAt(0)!;
    parts.push({ text: cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`, escaped: true });
  }
  if (plain) parts.push({ text: plain, escaped: false });
  return parts;
}
