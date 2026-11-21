// A short thread title from the session's first message: devd's inbox `topic`, and the web thread header when the
// session has no nickname. No title generator: this picks the first clause that reads as words, not as a command.
// The Apple apps copy it (ThreadTitle); shared/fixtures/thread-titles.json pins both.

const MAX_WORDS = 6;

/** A clause looks like code when it has shell or code punctuation, or is mostly numbers. */
function codeLike(clause: string): boolean {
  if (/[$=|&<>{}()[\]\\`#*~^]/.test(clause)) return true;
  const words = clause.split(/\s+/).filter(Boolean);
  const numeric = words.filter((w) => /^[\d.,:/-]+$/.test(w)).length;
  return numeric / words.length >= 0.3;
}

const clip = (words: string[]): string => {
  const t = words.slice(0, MAX_WORDS).join(" ").replace(/[,;:–—-]+$/, "");
  return words.length > MAX_WORDS ? `${t}…` : t;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Small offline sync task for the notes app: queue …" → "Small offline sync task for the…"; null when nothing usable. */
export function threadTitle(firstMessage: string): string | null {
  const line = firstMessage.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const text = line.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  // Clauses end at sentence punctuation, a colon or semicolon, or a dash between spaces.
  const clauses = text.split(/[.!?;:](?:\s|$)|;|\s[—–-]\s/).map((c) => c.trim()).filter(Boolean);
  const pick = clauses.find((c) => c.split(/\s+/).length >= 2 && !codeLike(c));
  if (pick) return capitalize(clip(pick.split(/\s+/)));
  const words = text.split(/\s+/).filter((w) => !codeLike(w));
  return words.length > 0 ? capitalize(clip(words)) : null;
}
