import { expect, test } from "bun:test";
import type { MirrorInfo } from "../../shared/mirror";
import { ApiError } from "./api";
import { activeTrigger, offeredTrigger } from "./composerTrigger";
import { MIRROR_IMAGES_OFF, mirrorComposerProps, mirrorFieldOff, mirrorNotice, mirrorSendLock, mirrorUnsupported, sendToMirror, type MirrorLock } from "./mirrorView";
import { streamUrl } from "./useEventStream";

const live: MirrorInfo = { state: "live", agent: "Claude Code", conversationId: "c", activity: "idle", terminalPrompt: null, sendBlock: null };

test("a refused send becomes the composer's lock; other failures stay errors", () => {
  const draft = new ApiError("terminal-has-draft", 409, { error: "terminal-has-draft", message: "Text is already typed." });
  expect(mirrorSendLock(draft)).toEqual({ code: "terminal-has-draft", message: "Text is already typed." });
  expect(mirrorSendLock(new ApiError("Commands can't be sent", 400, { error: "Commands can't be sent" }))).toBeNull();
  expect(mirrorSendLock(new ApiError("session-ending", 409, { error: "session-ending" }))).toEqual({ code: "session-ending", message: "This session is ending; nothing more can be sent to it." });
  expect(mirrorSendLock(new ApiError("unknown-session", 404, { error: "unknown-session" }))).toEqual({ code: "unknown-session", message: "devd no longer has this session." });
  expect(mirrorSendLock(new ApiError("not-a-tmux-session", 409, { error: "not-a-tmux-session" }))).toEqual({ code: "not-a-tmux-session", message: "This is no longer a terminal session; reload the page." });
  expect(mirrorSendLock(new ApiError("something-new", 409, { error: "something-new" }))).toBeNull();
  expect(mirrorSendLock(new Error("network"))).toBeNull();
});

test("the line above the composer: the terminal's question first, then the refused send, then devd's reason", () => {
  expect(mirrorNotice(live, null)).toBeNull();
  const exited: MirrorInfo = { ...live, state: "agent-exited", sendBlock: { code: "agent-not-running", message: "No agent runs." } };
  expect(mirrorNotice(exited, null)).toEqual({ kind: "lock", text: "No agent runs.", dismissible: false });
  expect(mirrorNotice(live, { code: "terminal-has-draft", message: "Draft." })).toEqual({ kind: "lock", text: "Draft.", dismissible: true });
  const waiting: MirrorInfo = { ...live, activity: "waiting", terminalPrompt: { text: "Which file?" }, sendBlock: { code: "agent-waiting-in-terminal", message: "Answer it there." } };
  expect(mirrorNotice(waiting, { code: "terminal-has-draft", message: "Draft." })).toEqual({ kind: "prompt", text: "Which file?", dismissible: false });
});

test("only devd's standing reason turns the field off; a refused send keeps the text editable", () => {
  expect(mirrorFieldOff(live)).toBeUndefined();
  expect(mirrorFieldOff({ ...live, sendBlock: { code: "agent-not-running", message: "No agent runs." } })).toBe("No agent runs.");
});

test("a Codex conversation is read-only: the composer shows devd's lock with Open terminal and stays off", () => {
  const codex: MirrorInfo = { ...live, agent: "Codex", sendBlock: { code: "codex-send-unsupported", message: "Sending from chat isn't available for Codex yet; reply in the terminal." } };
  expect(mirrorNotice(codex, null)).toEqual({ kind: "lock", text: "Sending from chat isn't available for Codex yet; reply in the terminal.", dismissible: false });
  expect(mirrorFieldOff(codex)).toBe("Sending from chat isn't available for Codex yet; reply in the terminal.");
  expect(mirrorUnsupported(codex)).toBeNull();
});

test("an agent the mirror cannot read says so by name", () => {
  expect(mirrorUnsupported(live)).toBeNull();
  const codex: MirrorInfo = { ...live, state: "unsupported", agent: "Codex", sendBlock: { code: "unsupported-agent", message: "Chat view isn't supported for Codex yet." } };
  expect(mirrorUnsupported(codex)).toBe("Chat view isn't supported for Codex yet.");
  expect(mirrorUnsupported({ ...codex, sendBlock: null })).toBe("Chat view isn't supported for Codex yet.");
});

test("a refused send locks the composer and keeps the text; a sent one clears the lock; other failures throw", async () => {
  const locks: (MirrorLock | null)[] = [];
  const draft = new ApiError("terminal-has-draft", 409, { error: "terminal-has-draft", message: "Text is already typed." });
  expect(await sendToMirror(() => Promise.reject(draft), (l) => locks.push(l))).toBe(false);
  expect(await sendToMirror(() => Promise.resolve({ sent: true }), (l) => locks.push(l))).toBeUndefined();
  expect(locks).toEqual([{ code: "terminal-has-draft", message: "Text is already typed." }, null]);
  const bad = new ApiError("Commands can't be sent", 400, { error: "Commands can't be sent" });
  await expect(sendToMirror(() => Promise.reject(bad), (l) => locks.push(l))).rejects.toBe(bad);
  expect(locks).toHaveLength(2);
});

test("a tmux session streams its mirror; a chat session the shared stream", () => {
  expect(streamUrl(undefined, false, undefined)).toBe("/api/stream");
  expect(streamUrl("dev-a b", false, 7)).toBe("/api/stream?session=dev-a+b&afterSeq=7");
  expect(streamUrl("dev-a b", true, 7)).toBe("/api/sessions/dev-a%20b/mirror/stream?afterSeq=7");
  expect(streamUrl("dev-a", true, undefined)).toBe("/api/sessions/dev-a/mirror/stream");
  expect(streamUrl(undefined, true, undefined)).toBe("/api/stream");
});

test("the mirror composer opens no / or @ menu and takes no images; its placeholder is devd's reason when sending is off", () => {
  const props = mirrorComposerProps(live);
  for (const text of ["/", "/rev", "look at @src", "@"]) {
    const found = activeTrigger(text, text.length);
    expect(found).not.toBeNull();
    expect(offeredTrigger(found, props)).toBeNull();
    // The same word in a chat session's composer does open its menu.
    expect(offeredTrigger(found, { commands: [{ name: "review" }], searchFiles: async () => ({ files: [] }) })).toEqual(found);
  }
  expect(props.imagesOff).toBe(MIRROR_IMAGES_OFF);
  expect(props.placeholder).toBe("Message the agent in the terminal");
  const codex = mirrorComposerProps({ ...live, agent: "Codex", sendBlock: { code: "codex-send-unsupported", message: "Read-only." } });
  expect([codex.fieldOff, codex.placeholder]).toEqual(["Read-only.", "Read-only."]);
});
