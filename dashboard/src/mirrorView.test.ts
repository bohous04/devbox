import { expect, test } from "bun:test";
import type { MirrorInfo } from "../../shared/mirror";
import { ApiError } from "./api";
import { mirrorFieldOff, mirrorNotice, mirrorSendLock, mirrorUnsupported } from "./mirrorView";

const live: MirrorInfo = { state: "live", agent: "Claude Code", conversationId: "c", activity: "idle", terminalPrompt: null, sendBlock: null };

test("a refused send becomes the composer's lock; other failures stay errors", () => {
  const draft = new ApiError("terminal-has-draft", 409, { error: "terminal-has-draft", message: "Text is already typed." });
  expect(mirrorSendLock(draft)).toEqual({ code: "terminal-has-draft", message: "Text is already typed." });
  expect(mirrorSendLock(new ApiError("Commands can't be sent", 400, { error: "Commands can't be sent" }))).toBeNull();
  expect(mirrorSendLock(new ApiError("session-ending", 409, { error: "session-ending" }))).toBeNull();
  expect(mirrorSendLock(new Error("network"))).toBeNull();
});

test("the line above the composer: the terminal's question first, then the refused send, then devd's reason", () => {
  expect(mirrorNotice(live, null)).toBeNull();
  const exited: MirrorInfo = { ...live, state: "agent-exited", sendBlock: { code: "agent-not-running", message: "No agent runs." } };
  expect(mirrorNotice(exited, null)).toEqual({ kind: "lock", text: "No agent runs." });
  expect(mirrorNotice(live, { code: "terminal-has-draft", message: "Draft." })).toEqual({ kind: "lock", text: "Draft." });
  const waiting: MirrorInfo = { ...live, activity: "waiting", terminalPrompt: { text: "Which file?" }, sendBlock: { code: "agent-waiting-in-terminal", message: "Answer it there." } };
  expect(mirrorNotice(waiting, { code: "terminal-has-draft", message: "Draft." })).toEqual({ kind: "prompt", text: "Which file?" });
});

test("only devd's standing reason turns the field off; a refused send keeps the text editable", () => {
  expect(mirrorFieldOff(live)).toBeUndefined();
  expect(mirrorFieldOff({ ...live, sendBlock: { code: "agent-not-running", message: "No agent runs." } })).toBe("No agent runs.");
});

test("an agent the mirror cannot read says so by name", () => {
  expect(mirrorUnsupported(live)).toBeNull();
  const codex: MirrorInfo = { ...live, state: "unsupported", agent: "Codex", sendBlock: { code: "unsupported-agent", message: "Chat view isn't supported for Codex yet." } };
  expect(mirrorUnsupported(codex)).toBe("Chat view isn't supported for Codex yet.");
  expect(mirrorUnsupported({ ...codex, sendBlock: null })).toBe("Chat view isn't supported for Codex yet.");
});
