import type { AgentCommand } from "../../shared/thread";

/** What the composer offers at the caret: `/` the agent's commands (only at the start of the message, as an agent
 *  reads a command only there), `@` the session repo's files (on any word that starts with it). `start`..`end` is the
 *  word a pick replaces (to its end, also when the caret is inside it); `query` is the part before the caret. */
export interface Trigger { kind: "/" | "@"; query: string; start: number; end: number }

export function activeTrigger(text: string, caret: number): Trigger | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  const kind = text[start];
  if (kind === "/" && start === 0) return { kind, query: text.slice(1, caret), start, end };
  if (kind === "@") return { kind, query: text.slice(start + 1, caret), start, end };
  return null;
}

/** Commands matching `query` (case-insensitive): names starting with it, then names containing it, then (from three
 *  characters on, where a description match stops being noise) descriptions containing it; the agent's order within
 *  each. */
export function filterCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const q = query.toLowerCase();
  const rank = (c: AgentCommand) => {
    const name = c.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : q.length >= 3 && c.description?.toLowerCase().includes(q) ? 2 : -1;
  };
  return commands.map((c) => ({ c, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r).map((x) => x.c);
}

/** The text with the trigger word replaced by the pick (`/name` or `@path`), and the caret after it and one space (the
 *  one already there, else a new one): past the word, so the menu does not open on it again. */
export function applyPick(text: string, t: Trigger, value: string): { text: string; caret: number } {
  // A path with spaces is quoted, so the agent reads it as one path.
  const word = `${t.kind}${t.kind === "@" && /\s/.test(value) ? `"${value}"` : value}`;
  const rest = text.slice(t.end);
  const sep = /^\s/.test(rest) ? "" : " ";
  return { text: text.slice(0, t.start) + word + sep + rest, caret: t.start + word.length + 1 };
}

/** The empty composer names the triggers this session has (a Codex chat runs no slash commands, so no `/`). */
export function composerPlaceholder(o: { running: boolean; commands: boolean; files: boolean }): string {
  if (o.running) return "Queue a message for after this run";
  return ["Ask anything", ...(o.files ? ["@ for files"] : []), ...(o.commands ? ["/ for commands"] : [])].join(" · ");
}

/** The open menu as the keys see it: `options` shown, `searching` (the file results are on their way: none yet, or an
 *  older query's), `exact` (what is typed already is the highlighted option). */
export interface MenuState { options: number; searching: boolean; exact: boolean }
export interface KeyInput { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean; keyCode: number }
/** `hold`: swallow the key (nothing happens); `default`: the field's own behaviour (a newline, focus move, caret move). */
export type KeyAction = "pick" | "next" | "prev" | "dismiss" | "send" | "hold" | "default";

/** What a key in the composer does. `menu` null = no menu open; `enterSends`: Enter sends (a mouse or trackpad; on
 *  touch Enter is a newline and the Send button sends). */
export function keyAction(menu: MenuState | null, e: KeyInput, enterSends: boolean): KeyAction {
  // An IME's own keys (Safari ends a composition with keyCode 229 and isComposing false).
  if (e.isComposing || e.keyCode === 229) return "default";
  const enter = e.key === "Enter" && !e.shiftKey;
  const plainEnter = enter && enterSends ? "send" : "default";
  if (menu === null) return plainEnter;
  if (e.key === "Escape") return "dismiss";
  const modified = e.shiftKey || e.altKey || e.ctrlKey || e.metaKey;
  const tab = e.key === "Tab" && !modified;
  if (menu.searching) return enter || tab ? "hold" : "default";
  if (menu.options === 0) return plainEnter;
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !modified) return e.key === "ArrowDown" ? "next" : "prev";
  if (tab) return "pick";
  if (enter) return menu.exact ? plainEnter : "pick";
  return "default";
}
