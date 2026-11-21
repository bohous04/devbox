import { expect, test } from "bun:test";
import { activeTrigger, applyPick, composerPlaceholder, filterCommands } from "./composerTrigger";

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
