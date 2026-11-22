import { expect, test } from "bun:test";
import type { Attention, InboxItem } from "../../shared/thread";
import { claimsUndo, failureText, FOCUS_LOOK_GAP_MS, focusOwnsUndo, SeenWatch, seenMoves, settleKey, settleShortcut, Settler, wantsSeen } from "./inboxSettle";

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

test("settleKey: a bare E on a focused row, not from a text field, not held down", () => {
  expect(settleKey(key("e"), false)).toBe(true);
  expect(settleKey(key("E"), false)).toBe(true);
  expect(settleKey(key("e"), true)).toBe(false);
  expect(settleKey({ ...key("e"), repeat: true }, false)).toBe(false);
  expect(settleKey(key("e", { meta: true }), false)).toBe(false);
  expect(settleKey(key("E", { shift: true }), false)).toBe(false);
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
  // devd clears done and failed only: CI, a limit or a lost agent stay whatever seen says.
  for (const reason of ["ci-failed", "rate-limited", "disconnected", "bridge-behind"] as const) {
    expect(wantsSeen(item("x", { section: "needs_you", reason, since: 1 }))).toBe(false);
  }
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

/** Timers the test runs by hand. */
function fakeTimers() {
  let n = 0;
  const due = new Map<number, () => void>();
  return {
    timers: { set: (fn: () => void) => { due.set(++n, fn); return n; }, clear: (h: unknown) => { due.delete(h as number); } },
    pending: () => due.size,
    fire: () => { const all = [...due.values()]; due.clear(); for (const fn of all) fn(); },
  };
}

test("the notice's timer lives in the settler: it ends the notice whatever page is open; a later settle's stays", async () => {
  const t = fakeTimers();
  const s = new Settler(fakeApi().api, 5_000, t.timers);
  await s.settle(done("a"));
  await s.settle(done("b"));
  expect(t.pending()).toBe(1);
  t.fire();
  expect(s.state.notice).toBeNull();
  expect(await s.undo()).toBeNull();
});

test("hold keeps the notice while the pointer or the keyboard is on it; letting go starts a full lifetime", async () => {
  const t = fakeTimers();
  const s = new Settler(fakeApi().api, 5_000, t.timers);
  await s.settle(done("a"));
  s.hold(true);
  expect(t.pending()).toBe(0);
  s.hold(false);
  expect(t.pending()).toBe(1);
  t.fire();
  expect(s.state.notice).toBeNull();
});

test("an undo ends the notice's timer", async () => {
  const t = fakeTimers();
  const s = new Settler(fakeApi().api, 5_000, t.timers);
  await s.settle(done("a"));
  await s.undo();
  expect(t.pending()).toBe(0);
});

test("failureText keeps the real error and its HTTP status", () => {
  const withStatus = Object.assign(new Error("session-ending"), { status: 409 });
  expect(failureText(withStatus)).toBe("session-ending (HTTP 409)");
  expect(failureText(Object.assign(new Error("HTTP 503"), { status: 503 }))).toBe("HTTP 503");
  expect(failureText(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  expect(failureText(Object.assign(new Error(""), { name: "AbortError" }))).toBe("AbortError");
  expect(failureText("offline")).toBe("offline");
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

test("seen failures are suppressed once dismissed, by key, until that key works again", async () => {
  const s = new Settler(fakeApi().api);
  s.report("Couldn't read the inbox", "t@inbox");
  s.dismiss();
  s.report("Couldn't read the inbox", "t@inbox");
  expect(s.state.problem).toBeNull();
  s.cleared("t@inbox");
  s.report("Couldn't read the inbox again", "t@inbox");
  expect(s.state.problem).toBe("Couldn't read the inbox again");
  s.cleared("t@inbox");
  expect(s.state.problem).toBeNull();
});

/** A SeenWatch over a fake inbox, a fake clock, visibility and deferred tasks run by hand. */
function watch(items: InboxItem[]) {
  const f = fakeApi();
  const settler = new Settler(f.api);
  const env = { visible: true, now: 0, reads: 0, failRead: null as Error | null, tasks: [] as (() => void)[] };
  const w = new SeenWatch({
    items: () => { env.reads++; return env.failRead ? Promise.reject(env.failRead) : Promise.resolve(items); },
    settler, visible: () => env.visible, now: () => env.now,
    defer: (fn) => { env.tasks.push(fn); return () => { env.tasks = env.tasks.filter((t) => t !== fn); }; },
  });
  const runTasks = async () => { const all = env.tasks; env.tasks = []; for (const t of all) t(); await new Promise((r) => setTimeout(r, 0)); };
  return { w, f, settler, env, runTasks };
}
const failed = (id = "t", since = 10) => item(id, { section: "needs_you", reason: "failed", since });

test("SeenWatch: opening marks a finish seen; a failure only on leaving", async () => {
  const { w, f, runTasks } = watch([done("d"), failed("x")]);
  await w.open("d");
  await w.open("x");
  expect(f.calls).toEqual(["seen d"]);
  w.leave("x");
  expect(f.calls).toEqual(["seen d"]);
  await runTasks();
  expect(f.calls).toEqual(["seen d", "seen x"]);
});

test("SeenWatch: StrictMode's unmount and remount is not a leave", async () => {
  const { w, f, env, runTasks } = watch([failed("x")]);
  await w.open("x");
  w.leave("x");
  await w.open("x");
  await runTasks();
  expect(f.calls).toEqual([]);
  expect(env.reads).toBe(1);
  w.leave("x");
  await runTasks();
  expect(f.calls).toEqual(["seen x"]);
});

test("SeenWatch: nothing while the page is hidden", async () => {
  const { w, f, env, runTasks } = watch([done("d")]);
  env.visible = false;
  await w.open("d");
  await w.focus("d");
  w.leave("d");
  await runTasks();
  expect(env.reads).toBe(0);
  expect(f.calls).toEqual([]);
});

test("SeenWatch: focus looks again after a gap, and focus with visibility together read once", async () => {
  const { w, f, env } = watch([done("d", 10)]);
  await w.open("d");
  expect(env.reads).toBe(1);
  await w.focus("d");
  expect(env.reads).toBe(1);
  env.now += FOCUS_LOOK_GAP_MS;
  await Promise.all([w.focus("d"), w.focus("d")]);
  expect(env.reads).toBe(2);
  expect(f.calls).toEqual(["seen d"]);
});

test("SeenWatch: a failed inbox read is shown, under a key a dismissal holds", async () => {
  const { w, env, settler } = watch([done("d")]);
  env.failRead = Object.assign(new Error("HTTP 502"), { status: 502 });
  await w.open("d");
  expect(settler.state.problem).toBe("Couldn't mark this session seen: could not read the inbox (HTTP 502)");
  settler.dismiss();
  env.now += FOCUS_LOOK_GAP_MS;
  await w.focus("d");
  expect(settler.state.problem).toBeNull();
});
