import { expect, test } from "bun:test";
import type { Attention, InboxItem } from "../../shared/thread";
import { claimsUndo, focusOwnsUndo, seenMoves, settleShortcut, Settler, wantsSeen } from "./inboxSettle";

const item = (sessionId: string, attention: Attention, runtime: InboxItem["runtime"] = "tmux"): InboxItem => ({
  sessionId, runtime, title: sessionId, project: "p", repo: "r", agent: "claude", attention, lastText: null,
});
const done = (id = "t", since = 10) => item(id, { section: "needs_you", reason: "completed", since });
const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key: k, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt });

/** A fake devd: each call resolves, or rejects with the next queued error. */
function fakeApi() {
  const calls: string[] = [];
  const errors: Error[] = [];
  const answer = (what: string, id: string) => {
    calls.push(`${what} ${id}`);
    const e = errors.shift();
    return e ? Promise.reject(e) : Promise.resolve();
  };
  return {
    calls, errors,
    api: {
      settle: (id: string) => answer("settle", id).then(() => item(id, { section: "settled", reason: null, since: 1 })),
      unsettle: (id: string) => answer("unsettle", id).then(() => item(id, { section: "idle", reason: null, since: 1 })),
      seen: (id: string) => answer("seen", id),
    },
  };
}

test("settleShortcut: ⌘⇧S on a Mac, Ctrl+Shift+S elsewhere; nothing else", () => {
  expect(settleShortcut(key("S", { meta: true, shift: true }), true)).toBe(true);
  expect(settleShortcut(key("s", { meta: true, shift: true }), true)).toBe(true);
  expect(settleShortcut(key("S", { ctrl: true, shift: true }), true)).toBe(false);
  expect(settleShortcut(key("S", { ctrl: true, shift: true }), false)).toBe(true);
  expect(settleShortcut(key("S", { meta: true, shift: true, alt: true }), true)).toBe(false);
  expect(settleShortcut(key("s", { meta: true }), true)).toBe(false);
});

test("claimsUndo: ⌘Z only while the notice shows and no text field has the keyboard", () => {
  expect(claimsUndo(key("z", { meta: true }), true, { noticeShown: true, focusOwnsUndo: false })).toBe(true);
  expect(claimsUndo(key("z", { ctrl: true }), false, { noticeShown: true, focusOwnsUndo: false })).toBe(true);
  expect(claimsUndo(key("z", { meta: true }), true, { noticeShown: false, focusOwnsUndo: false })).toBe(false);
  expect(claimsUndo(key("z", { meta: true }), true, { noticeShown: true, focusOwnsUndo: true })).toBe(false);
  // ⌘⇧Z is redo, not undo.
  expect(claimsUndo(key("Z", { meta: true, shift: true }), true, { noticeShown: true, focusOwnsUndo: false })).toBe(false);
  expect(claimsUndo(key("z", { ctrl: true }), true, { noticeShown: true, focusOwnsUndo: false })).toBe(false);
});

test("focusOwnsUndo: text inputs, text areas and editable content keep their own ⌘Z", () => {
  expect(focusOwnsUndo(null)).toBe(false);
  expect(focusOwnsUndo({ tagName: "A", isContentEditable: false })).toBe(false);
  expect(focusOwnsUndo({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
  expect(focusOwnsUndo({ tagName: "INPUT", isContentEditable: false, type: "text" })).toBe(true);
  expect(focusOwnsUndo({ tagName: "INPUT", isContentEditable: false, type: "checkbox" })).toBe(false);
  expect(focusOwnsUndo({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
  expect(focusOwnsUndo({ tagName: "DIV", isContentEditable: true })).toBe(true);
});

test("wantsSeen: only a tmux session's unseen finish or failure; seenMoves: a pinned ask would drop", () => {
  expect(wantsSeen(done())).toBe(true);
  expect(wantsSeen(item("f", { section: "needs_you", reason: "failed", since: 1 }))).toBe(true);
  expect(wantsSeen(item("q", { section: "needs_you", reason: "request", since: 1 }))).toBe(false);
  expect(wantsSeen(item("c", { section: "needs_you", reason: "completed", since: 1 }, "chat"))).toBe(false);
  expect(wantsSeen(item("i", { section: "idle", reason: null, since: 1 }))).toBe(false);
  expect(wantsSeen(undefined)).toBe(false);
  expect(seenMoves(done())).toBe(false);
  expect(seenMoves(item("f", { section: "needs_you", reason: "failed", since: 1 }))).toBe(true);
});

test("settle: shows the undo notice; undo unsettles it once", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  const next = await s.settle(done("a"));
  expect(next?.attention.section).toBe("settled");
  expect(s.state.notice?.sessionId).toBe("a");
  expect(s.state.notice?.title).toBe("a");
  const back = await s.undo();
  expect(back?.attention.section).toBe("idle");
  expect(s.state.notice).toBeNull();
  expect(await s.undo()).toBeNull();
  expect(f.calls).toEqual(["settle a", "unsettle a"]);
});

test("settle: an open request is refused before devd, with the reason shown", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  expect(await s.settle(item("q", { section: "needs_you", reason: "request", since: 1 }))).toBeNull();
  expect(f.calls).toEqual([]);
  expect(s.state.problem).toBe("Couldn't settle “q”: Answer the open request first");
  expect(s.state.notice).toBeNull();
});

test("settle and undo failures are shown, never dropped", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  f.errors.push(new Error("session-ending"));
  expect(await s.settle(done("a"))).toBeNull();
  expect(s.state.problem).toBe("Couldn't settle “a”: session-ending");
  s.dismiss();
  expect(s.state.problem).toBeNull();
  await s.settle(done("b"));
  f.errors.push(new Error("HTTP 503"));
  expect(await s.undo()).toBeNull();
  expect(s.state.notice).toBeNull();
  expect(s.state.problem).toBe("Couldn't undo the settle of “b”: HTTP 503");
});

test("expire drops only the notice it was armed for", async () => {
  const s = new Settler(fakeApi().api);
  await s.settle(done("a"));
  const first = s.state.notice!.id;
  await s.settle(done("b"));
  s.expire(first);
  expect(s.state.notice?.sessionId).toBe("b");
  s.expire(s.state.notice!.id);
  expect(s.state.notice).toBeNull();
});

test("subscribers hear every change", async () => {
  const s = new Settler(fakeApi().api);
  let n = 0;
  const off = s.subscribe(() => n++);
  await s.settle(done("a"));
  off();
  await s.undo();
  expect(n).toBe(1);
});

test("seen: once per finish (id and since); a new finish of the same session posts again", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  expect(await s.seen(done("t", 10))).toBe("posted");
  expect(await s.seen(done("t", 10))).toBe("skipped");
  expect(await s.seen(done("t", 20))).toBe("posted");
  expect(await s.seen(item("q", { section: "needs_you", reason: "request", since: 1 }))).toBe("skipped");
  expect(f.calls).toEqual(["seen t", "seen t"]);
});

test("seen: a failed post is tried once more, then shown and left alone", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  f.errors.push(new Error("HTTP 503"), new Error("HTTP 503"));
  expect(await s.seen(done("t"))).toBe("failed");
  expect(s.state.problem).toBe("Couldn't mark “t” seen: HTTP 503");
  expect(await s.seen(done("t"))).toBe("failed");
  expect(await s.seen(done("t"))).toBe("skipped");
  expect(f.calls).toEqual(["seen t", "seen t"]);
});

test("seen: a retry that works clears its own failure; a dismissed seen failure is not raised again", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  f.errors.push(new Error("HTTP 503"));
  await s.seen(done("t"));
  s.dismiss();
  f.errors.push(new Error("HTTP 503"));
  expect(await s.seen(done("t"))).toBe("failed");
  expect(s.state.problem).toBeNull();
  f.errors.push(new Error("not-a-tmux-session"));
  await s.seen(done("u"));
  expect(s.state.problem).toBe("Couldn't mark “u” seen: not-a-tmux-session");
  expect(await s.seen(done("u"))).toBe("posted");
  expect(s.state.problem).toBeNull();
});

test("seen: two looks at once (focus and visibility together) post once", async () => {
  const f = fakeApi();
  const s = new Settler(f.api);
  const both = await Promise.all([s.seen(done("t")), s.seen(done("t"))]);
  expect(both).toEqual(["posted", "skipped"]);
  expect(f.calls).toEqual(["seen t"]);
});
