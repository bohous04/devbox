import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub } from "../src/agentEvents";
import { WORKING_GRACE_MS, type LinkState } from "../src/attention";
import { getSession, insertSession, listSessions, openDb, setSessionName, type SessionRow } from "../src/db";
import { EventBus } from "../src/eventBus";
import { Inbox, LAST_TEXT_MAX, sortInbox } from "../src/sessionInbox";
import { ThreadStore } from "../src/threadStore";
import type { BridgeEvent, InboxItem } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const BASE: SessionRow = {
  id: "dev-a-chat", folder: "acme", project: "a", repo: "chat", container: "dev-a-chat",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
};
const TMUX: SessionRow = { ...BASE, id: "dev-a-tmux", container: "dev-a-tmux", repo: "tmux", port_base: 40200, runtime: "tmux" };

const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });
const said = (runId: string, text: string): BridgeEvent => ({ type: "message.final", runId, itemId: `m-${runId}`, role: "assistant", text });
const asked = (runId: string, text: string): BridgeEvent => ({ type: "run.queued", runId, text, attachments: [] });

function setup(opts: { link?: LinkState | null; now?: () => number; coalesceMs?: number } = {}) {
  const db = openDb(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "inbox-"));
  const stores = new Map<string, ThreadStore>();
  cleanups.push(() => { for (const s of stores.values()) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const threads = (id: string) => {
    let s = stores.get(id);
    if (!s) { s = ThreadStore.open(dir, id); stores.set(id, s); }
    return s;
  };
  const hub = new AgentEventHub({ db, notify: () => {} });
  const bus = new EventBus();
  const link = opts.link === undefined ? { status: "connected" as const, since: 1 } : opts.link;
  const inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => link, tmuxLive: (id) => hub.liveSnapshot(id), bus,
    now: opts.now ?? (() => 1_000_000), coalesceMs: opts.coalesceMs,
  });
  const published: InboxItem[] = [];
  bus.subscribe(["inbox"], (_t, data) => published.push(data as InboxItem));
  return { db, threads, hub, bus, inbox, published };
}

/** A chat session whose events are stamped ts = 1000 * seq. */
function chat(t: ReturnType<typeof setup>, row: SessionRow, events: BridgeEvent[]) {
  insertSession(t.db, row);
  const s = t.threads(row.id);
  const first = s.lastSeq() + 1;
  events.forEach((event, i) => s.apply({ seq: first + i, ts: 1000 * (first + i), event }));
  return s;
}

const item = (sessionId: string, section: InboxItem["attention"]["section"], since: number): InboxItem => ({
  sessionId, runtime: "chat", title: sessionId, project: "p", repo: "r", agent: "claude",
  attention: { section, reason: null, since }, lastText: null,
});

test("inbox orders needs_you oldest first, then working and idle newest first", () => {
  const sorted = sortInbox([
    item("idle-old", "idle", 1), item("work-old", "working", 2), item("need-new", "needs_you", 30),
    item("idle-new", "idle", 40), item("need-old", "needs_you", 10), item("work-new", "working", 50),
  ]);
  expect(sorted.map((i) => i.sessionId)).toEqual(["need-old", "need-new", "work-new", "work-old", "idle-new", "idle-old"]);
});

test("chat item: attention from the thread and the link, lastText is the newest message, clipped", () => {
  const t = setup();
  const long = "x".repeat(LAST_TEXT_MAX + 50);
  chat(t, BASE, [started("r1"), said("r1", long), completed("r1")]);
  const it = t.inbox.item(getSession(t.db, BASE.id)!);
  expect(it).toEqual({
    sessionId: BASE.id, runtime: "chat", title: "a/chat", project: "a", repo: "chat", agent: "claude", branch: null,
    attention: { section: "needs_you", reason: "completed", since: 3000 }, lastText: `${"x".repeat(LAST_TEXT_MAX)}…`, topic: null,
  });
});

test("chat item: the topic is a short title from the first user message and stays while the thread goes on", () => {
  const t = setup();
  const s = chat(t, BASE, [asked("r1", "Add a retry queue for the offline sync: create src/sync/queue.ts"), started("r1"), said("r1", "OK"), completed("r1")]);
  const first = t.inbox.item(getSession(t.db, BASE.id)!);
  expect(first.topic).toBe("Add a retry queue for the…");
  expect(first.lastText).toBe("OK");
  s.apply({ seq: 5, ts: 5000, event: asked("r2", "Now rename the module") });
  expect(t.inbox.item(getSession(t.db, BASE.id)!).topic).toBe("Add a retry queue for the…");
});

test("chat item: a first message with nothing that reads as words has no topic", () => {
  const t = setup();
  chat(t, BASE, [asked("r1", "`ls -la`")]);
  expect(t.inbox.item(getSession(t.db, BASE.id)!).topic).toBeNull();
});

test("an item carries the branch devd recorded for the session", () => {
  const t = setup();
  insertSession(t.db, { ...BASE, worktree: "/w/a-chat", branch: "dev/a-chat-1" });
  expect(t.inbox.item(getSession(t.db, BASE.id)!).branch).toBe("dev/a-chat-1");
});

test("tmux item uses the hub's live state and carries runtime tmux", () => {
  const t = setup();
  insertSession(t.db, TMUX);
  setSessionName(t.db, TMUX.id, "Old school");
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit", { promptId: "p1" });
  const it = t.inbox.item(getSession(t.db, TMUX.id)!);
  expect(it.runtime).toBe("tmux");
  expect(it.title).toBe("Old school");
  expect(it.lastText).toBeNull();
  expect(it.topic).toBeNull();
  expect(it.attention.section).toBe("working");
});

test("list covers every session, sorted", () => {
  const t = setup();
  insertSession(t.db, TMUX); // no hub state: idle since 0
  chat(t, BASE, [started("r1"), completed("r1")]);
  expect(t.inbox.list().map((i) => [i.sessionId, i.attention.section])).toEqual([[BASE.id, "needs_you"], [TMUX.id, "idle"]]);
});

test("inbox events are coalesced: at most one per session per window, the last state wins", async () => {
  const t = setup({ coalesceMs: 60 });
  const s = chat(t, BASE, [started("r1")]);
  t.inbox.changed(BASE.id); // leading edge: published now
  expect(t.published.length).toBe(1);
  expect(t.published[0].attention.section).toBe("working");
  s.apply({ seq: 2, ts: 2000, event: said("r1", "one") });
  t.inbox.changed(BASE.id);
  s.apply({ seq: 3, ts: 3000, event: completed("r1") });
  t.inbox.changed(BASE.id);
  expect(t.published.length).toBe(1);
  await Bun.sleep(100);
  expect(t.published.length).toBe(2);
  expect(t.published[1].attention.section).toBe("needs_you");
  expect(t.published[1].lastText).toBe("one");
});

test("an unchanged item is not published again", async () => {
  const t = setup({ coalesceMs: 10 });
  chat(t, BASE, [started("r1")]);
  t.inbox.changed(BASE.id);
  await Bun.sleep(30);
  t.inbox.changed(BASE.id);
  await Bun.sleep(30);
  expect(t.published.length).toBe(1);
});

test("a run in its working grace window is re-published once the window ends", async () => {
  let now = 3000; // run ended at 3000 (seq 3)
  const t = setup({ coalesceMs: 5, now: () => now });
  chat(t, BASE, [started("r1"), said("r1", "done"), completed("r1")]);
  t.inbox.changed(BASE.id);
  expect(t.published.at(-1)!.attention.section).toBe("working");
  now = 3000 + WORKING_GRACE_MS + 1;
  await Bun.sleep(WORKING_GRACE_MS + 100);
  expect(t.published.at(-1)!.attention.section).toBe("needs_you");
});

test("a session that is gone (or ending) publishes its removal", async () => {
  const t = setup({ coalesceMs: 0 });
  chat(t, BASE, [started("r1"), completed("r1")]);
  t.inbox.changed(BASE.id);
  expect(t.published.at(-1)).toMatchObject({ sessionId: BASE.id, attention: { section: "needs_you" } });
  await Bun.sleep(5);
  t.db.run("DELETE FROM sessions WHERE id=?", [BASE.id]);
  t.inbox.changedSafe(BASE.id);
  expect(t.published.at(-1) as unknown).toEqual({ sessionId: BASE.id, removed: true });
});

test("event bus delivers to subscribers of the topic only and unsubscribes", () => {
  const bus = new EventBus();
  const got: [string, unknown][] = [];
  const off = bus.subscribe(["thread:a", "inbox"], (topic, data) => got.push([topic, data]));
  bus.publish("thread:a", 1);
  bus.publish("thread:b", 2);
  bus.publish("inbox", 3);
  off();
  bus.publish("thread:a", 4);
  expect(got).toEqual([["thread:a", 1], ["inbox", 3]]);
});

test("event bus: a throwing subscriber is logged and does not stop the others", () => {
  const logs: string[] = [];
  const bus = new EventBus({ log: (m) => logs.push(m) });
  const got: unknown[] = [];
  bus.subscribe(["inbox"], () => { throw new Error("boom"); });
  bus.subscribe(["inbox"], (_t, d) => got.push(d));
  bus.publish("inbox", 1);
  expect(got).toEqual([1]);
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("boom");
});

test("a rate-limited chat run is a needs-you item that says so", () => {
  const t = setup();
  chat(t, { ...BASE, agent: "vibe" }, [started("r1"), said("r1", "working on it"),
    { type: "run.failed", runId: "r1", error: "rate-limited: usage limit reached", reason: "rate-limited" }]);
  const it = t.inbox.item(getSession(t.db, BASE.id)!);
  expect(it.attention).toEqual({ section: "needs_you", reason: "rate-limited", since: 3000 });
});

test("a broken chat store is one needs-you item, logged once per message, not a failed inbox", () => {
  const logs: string[] = [];
  const t = setup();
  insertSession(t.db, BASE);
  insertSession(t.db, TMUX);
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id),
    threads: () => { throw new Error("disk I/O error"); },
    chatLink: () => null, tmuxLive: () => null, bus: t.bus, now: () => 42, log: (m) => logs.push(m),
  });
  const items = inbox.list();
  inbox.list();
  expect(items.map((i) => i.sessionId)).toEqual([BASE.id, TMUX.id]);
  expect(items[0].attention).toEqual({ section: "needs_you", reason: "failed", since: 42 });
  expect(items[0].lastText).toBe("thread store unreadable: disk I/O error");
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("disk I/O error");
});

test("T11: a broken store keeps the time it broke, is published once, and its recovery is logged; a new break logs again", () => {
  const logs: string[] = [];
  const t = setup();
  insertSession(t.db, BASE);
  let now = 42;
  let broken = true;
  const pending: (() => void)[] = [];
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id),
    threads: (id) => { if (broken) throw new Error("disk I/O error"); return t.threads(id); },
    chatLink: () => null, tmuxLive: () => null, bus: t.bus, now: () => now, log: (m) => logs.push(m), coalesceMs: 0,
    timers: { set: (fn) => pending.push(fn), clear: () => {} },
  });
  inbox.changed(BASE.id);
  now = 1042;
  expect(inbox.item(getSession(t.db, BASE.id)!).attention).toEqual({ section: "needs_you", reason: "failed", since: 42 });
  // A later change in the window: the trailing publish finds the same item and sends nothing.
  inbox.changed(BASE.id);
  pending.shift()!();
  expect(t.published).toHaveLength(1);
  broken = false;
  expect(inbox.item(getSession(t.db, BASE.id)!).lastText).toBeNull();
  broken = true;
  now = 2042;
  expect(inbox.item(getSession(t.db, BASE.id)!).attention.since).toBe(2042);
  expect(logs).toEqual([
    `inbox: thread store of ${BASE.id} unreadable: disk I/O error`,
    `inbox: thread store of ${BASE.id} readable again`,
    `inbox: thread store of ${BASE.id} unreadable: disk I/O error`,
  ]);
});

test("T11: a removed session leaves no re-check timer behind", () => {
  let now = 3000;
  const t = setup();
  const pending = new Map<number, () => void>();
  let next = 0;
  const inbox = new Inbox({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id), threads: t.threads,
    chatLink: () => null, tmuxLive: () => null, bus: t.bus, now: () => now, coalesceMs: 0,
    timers: { set: (fn) => { pending.set(++next, fn); return next; }, clear: (h) => { pending.delete(h as number); } },
  });
  chat(t, BASE, [started("r1"), said("r1", "done"), completed("r1")]);
  inbox.changed(BASE.id);
  // The coalesce window and the grace window's re-check.
  expect(pending.size).toBe(2);
  const window = pending.get(1)!;
  pending.delete(1);
  window();
  t.db.run("DELETE FROM sessions WHERE id=?", [BASE.id]);
  now += 10;
  inbox.changedSafe(BASE.id);
  expect(t.published.at(-1) as unknown).toEqual({ sessionId: BASE.id, removed: true });
  // Only the new coalesce window is left; the re-check of the removed session is gone.
  expect(pending.size).toBe(1);
});
