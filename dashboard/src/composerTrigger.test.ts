import { expect, test } from "bun:test";
import { activeTrigger, applyPick, composerPlaceholder, filterCommands, keyAction, type KeyInput, type MenuState } from "./composerTrigger";

test("/ opens only at the start of the message and until the command name ends", () => {
  expect(activeTrigger("/", 1)).toEqual({ kind: "/", query: "", start: 0, end: 1 });
  expect(activeTrigger("/com", 4)).toEqual({ kind: "/", query: "com", start: 0, end: 4 });
  // The caret inside the name: the whole name is replaced; on the arguments, nothing opens.
  expect(activeTrigger("/compactx", 3)).toEqual({ kind: "/", query: "co", start: 0, end: 9 });
  expect(activeTrigger("/compact now", 12)).toBeNull();
  expect(activeTrigger("/compact ", 9)).toBeNull();
  expect(activeTrigger("see /tmp", 8)).toBeNull();
  expect(activeTrigger(" /x", 3)).toBeNull();
});

test("@ opens on a word that starts with it, anywhere in the message", () => {
  expect(activeTrigger("@", 1)).toEqual({ kind: "@", query: "", start: 0, end: 1 });
  expect(activeTrigger("look at @src/ma", 15)).toEqual({ kind: "@", query: "src/ma", start: 8, end: 15 });
  expect(activeTrigger("line\n@rea", 9)).toEqual({ kind: "@", query: "rea", start: 5, end: 9 });
  // The caret in the middle of the word: the word up to its end is replaced, the query is what is before the caret.
  expect(activeTrigger("@readme more", 3)).toEqual({ kind: "@", query: "re", start: 0, end: 7 });
  // An e-mail address or a word with @ inside is no trigger.
  expect(activeTrigger("mail me@host", 12)).toBeNull();
  expect(activeTrigger("@src done", 9)).toBeNull();
});

test("commands: name prefix first, then name contains, then description contains (3+ characters); case-insensitive", () => {
  const cmds = [{ name: "review" }, { name: "code-review", description: "Review the diff" }, { name: "compact", description: "Summarize the conversation" }, { name: "init", description: "Write the project config" }];
  expect(filterCommands(cmds, "").map((c) => c.name)).toEqual(["review", "code-review", "compact", "init"]);
  expect(filterCommands(cmds, "RE").map((c) => c.name)).toEqual(["review", "code-review"]);
  expect(filterCommands(cmds, "summ").map((c) => c.name)).toEqual(["compact"]);
  expect(filterCommands(cmds, "zzz")).toEqual([]);
  // "co" is in "Write the project config", but two letters match too many descriptions to help.
  expect(filterCommands(cmds, "co").map((c) => c.name)).toEqual(["code-review", "compact"]);
});

test("a pick replaces the trigger word and puts the caret after a space, where no menu opens again", () => {
  expect(applyPick("/co", { kind: "/", query: "co", start: 0, end: 3 }, "compact")).toEqual({ text: "/compact ", caret: 9 });
  expect(applyPick("see @sr and", { kind: "@", query: "sr", start: 4, end: 7 }, "src/main.ts")).toEqual({ text: "see @src/main.ts and", caret: 17 });
  expect(applyPick("see @sr", { kind: "@", query: "sr", start: 4, end: 7 }, "src/main.ts")).toEqual({ text: "see @src/main.ts ", caret: 17 });
  for (const [text, t] of [["see @sr and", { kind: "@", query: "sr", start: 4, end: 7 }], ["/co rest", { kind: "/", query: "co", start: 0, end: 3 }]] as const) {
    const next = applyPick(text, t, "compact");
    expect(activeTrigger(next.text, next.caret)).toBeNull();
  }
});

test("the placeholder names only the triggers this session has", () => {
  expect(composerPlaceholder({ running: false, commands: true, files: true })).toBe("Ask anything · @ for files · / for commands");
  expect(composerPlaceholder({ running: false, commands: false, files: true })).toBe("Ask anything · @ for files");
  expect(composerPlaceholder({ running: false, commands: false, files: false })).toBe("Ask anything");
  expect(composerPlaceholder({ running: true, commands: true, files: true })).toBe("Queue a message for after this run");
});

const key = (k: string, o: Partial<KeyInput> = {}): KeyInput => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...o });
const menu = (o: Partial<MenuState> = {}): MenuState => ({ options: 3, searching: false, exact: false, ...o });

test("keyAction: no menu: Enter sends where Enter sends (mouse or trackpad), Shift+Enter and IME keys keep their default", () => {
  expect(keyAction(null, key("Enter"), true)).toBe("send");
  expect(keyAction(null, key("Enter"), false)).toBe("default");
  expect(keyAction(null, key("Enter", { shiftKey: true }), true)).toBe("default");
  expect(keyAction(null, key("Enter", { isComposing: true }), true)).toBe("default");
  // Safari ends a composition with a keydown whose keyCode is 229 and isComposing false.
  expect(keyAction(null, key("Enter", { keyCode: 229 }), true)).toBe("default");
});

test("keyAction: an open menu with options: arrows move, Enter and Tab pick, Escape closes; modified arrows and IME keys are the field's", () => {
  expect(keyAction(menu(), key("ArrowDown"), true)).toBe("next");
  expect(keyAction(menu(), key("ArrowUp"), true)).toBe("prev");
  for (const mod of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) expect(keyAction(menu(), key("ArrowDown", { [mod]: true }), true)).toBe("default");
  expect(keyAction(menu(), key("Enter"), true)).toBe("pick");
  expect(keyAction(menu(), key("Enter"), false)).toBe("pick");
  expect(keyAction(menu(), key("Tab"), true)).toBe("pick");
  expect(keyAction(menu(), key("Tab", { shiftKey: true }), true)).toBe("default");
  expect(keyAction(menu(), key("Enter", { shiftKey: true }), true)).toBe("default");
  expect(keyAction(menu(), key("Escape"), true)).toBe("dismiss");
  expect(keyAction(menu(), key("Enter", { isComposing: true }), true)).toBe("default");
  expect(keyAction(menu(), key("Enter", { keyCode: 229 }), true)).toBe("default");
});

test("keyAction: what is typed already is the option: Enter does what it does without a menu (\"/compact\" + Enter sends); Tab still picks", () => {
  expect(keyAction(menu({ exact: true }), key("Enter"), true)).toBe("send");
  expect(keyAction(menu({ exact: true }), key("Enter"), false)).toBe("default");
  expect(keyAction(menu({ exact: true }), key("Tab"), true)).toBe("pick");
});

test("keyAction: results on their way (stale or none yet): Enter and Tab do nothing, so neither an old result nor the half-typed text goes out", () => {
  for (const m of [menu({ searching: true }), menu({ searching: true, options: 0 })]) {
    expect(keyAction(m, key("Enter"), true)).toBe("hold");
    expect(keyAction(m, key("Tab"), true)).toBe("hold");
    expect(keyAction(m, key("ArrowDown"), true)).toBe("default");
    expect(keyAction(m, key("Escape"), true)).toBe("dismiss");
  }
});

test("keyAction: a menu with nothing to pick (no match, or a failed search): Enter sends as without one", () => {
  expect(keyAction(menu({ options: 0 }), key("Enter"), true)).toBe("send");
  expect(keyAction(menu({ options: 0 }), key("Tab"), true)).toBe("default");
  expect(keyAction(menu({ options: 0 }), key("ArrowDown"), true)).toBe("default");
});

test("a file path with spaces is quoted", () => {
  expect(applyPick("@my", { kind: "@", query: "my", start: 0, end: 3 }, "docs/my notes.md")).toEqual({ text: '@"docs/my notes.md" ', caret: 20 });
});
