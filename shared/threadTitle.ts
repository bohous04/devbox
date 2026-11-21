// A short thread title from the session's first message: devd's inbox `topic`, and the web thread header when the
// session has no nickname. No title generator: this picks the first clause that reads as words, not as a command.
// The Apple apps copy it (ThreadTitle); shared/fixtures/thread-titles.json pins both.

const MAX_WORDS = 6;
/** A hard cap in code points, the ellipsis included: one long token must not make a title run on. */
const MAX_CHARS = 60;

/** A clause looks like code when it has shell or code punctuation, or is mostly numbers. */
function codeLike(clause: string): boolean {
  if (/[$=|&<>{}()[\]\\`#*~^]/.test(clause)) return true;
  const words = clause.split(/\s+/).filter(Boolean);
  const numeric = words.filter((w) => /^[\d.,:/-]+$/.test(w)).length;
  return numeric / words.length >= 0.3;
}

const clip = (words: string[]): string => {
  let t = words.slice(0, MAX_WORDS).join(" ").replace(/[,;:–—-]+$/, "");
  let cut = words.length > MAX_WORDS;
  const chars = [...t];
  if (chars.length + (cut ? 1 : 0) > MAX_CHARS) { t = chars.slice(0, MAX_CHARS - 1).join("").trimEnd(); cut = true; }
  return cut ? `${t}…` : t;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The first non-empty line outside a ``` fence. */
function firstProseLine(message: string): string {
  let fenced = false;
  for (const raw of message.split("\n")) {
    const l = raw.trim();
    if (l.startsWith("```")) { fenced = !fenced; continue; }
    if (!fenced && l !== "") return l;
  }
  return "";
}

/** "Small offline sync task for the notes app: queue …" → "Small offline sync task for the…"; null when nothing usable. */
export function threadTitle(firstMessage: string): string | null {
  const text = firstProseLine(firstMessage).replace(/^#+\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  // Clauses end at sentence punctuation, a colon or semicolon, or a dash between spaces.
  const clauses = text.split(/[.!?;:](?:\s|$)|;|\s[—–-]\s/).map((c) => c.trim()).filter(Boolean);
  const pick = clauses.find((c) => c.split(/\s+/).length >= 2 && !codeLike(c));
  if (pick) return capitalize(clip(pick.split(/\s+/)));
  const words = text.split(/\s+/).filter((w) => !codeLike(w));
  return words.length > 0 ? capitalize(clip(words)) : null;
}
