import { expect, test } from "bun:test";
import { openDb, insertSchedule, getSession, insertSession, type ScheduleRow, type SessionRow } from "../src/db";
import { CommandTimeout } from "../src/bridgeLink";
import { createScheduler, dueSchedules, scheduledNotifySession, scheduledPrompt, slug, stamp } from "../src/scheduler";

function sched(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return { id: "s1", name: "Nightly bump", cron: "0 3 * * *", folder: "acme", project: "shop", repo: "cms", clone_url: "https://x/cms.git", prompt: "bump deps", important: 1, enabled: 1, last_run_at: null, runtime: "tmux", agent: null, ...over };
}
const at3 = new Date(2026, 6, 9, 3, 0, 0);

test("dueSchedules: enabled + match + minute guard", () => {
  const db = openDb(":memory:"); insertSchedule(db, sched());
  expect(dueSchedules(db, at3).map((s) => s.id)).toEqual(["s1"]);
  const db2 = openDb(":memory:"); insertSchedule(db2, sched({ last_run_at: at3.getTime() }));
  expect(dueSchedules(db2, at3)).toEqual([]);
  const db3 = openDb(":memory:"); insertSchedule(db3, sched({ enabled: 0 }));
  expect(dueSchedules(db3, at3)).toEqual([]);
});

test("slug/stamp/scheduledPrompt", () => {
  expect(slug("Naïve bump!!")).toBe("na-ve-bump"); // diacritics/punctuation → '-', trim
  expect(stamp(at3)).toBe("20260709-0300");
  const p = scheduledPrompt(sched(), "auto/x-1");
  expect(p).toContain("auto/x-1");
  expect(p).toContain("bump deps");
  expect(p).toContain("pull request");
});

test("fireSchedule: running session → skip + notification, no open", async () => {
  const db = openDb(":memory:");
  const opened: unknown[] = []; const notes: string[] = [];
  const s = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: `dev-${t.project}-${t.repo}` } }; },
    containerRunning: async () => true, notify: (_t, m) => { notes.push(m); },
  });
  await s.fireSchedule(sched());
  expect(opened).toEqual([]);
  expect(notes[0]).toContain("skipped");
});

// Regression after the `open()` fix (see existingSessionId in sessions.ts): `open()` without `fresh`
// attaches to ANY running session of the repo and its "existing and running" shortcut returns BEFORE
// the prompt is written. If the scheduler only asked about the base id, the run would be logged,
// a "started" notification would go out — and the scheduled work would silently never happen.
test("fireSchedule: skips even when a different session of the repo than the base id is running", async () => {
  const db = openDb(":memory:");
  insertSession(db, {
    id: "dev-shop-cms-2", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms-2",
    port_base: 41500, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0,
  });
  const opened: unknown[] = []; const notes: string[] = []; const extras: unknown[] = [];
  const s = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: `dev-${t.project}-${t.repo}` } }; },
    containerRunning: async (id) => id === "dev-shop-cms-2",   // the base id is NOT running
    notify: (_t, m, e) => { notes.push(m); extras.push(e); },
  });
  await s.fireSchedule(sched());
  expect(opened).toEqual([]);                    // no open → no lost prompt
  expect(notes[0]).toContain("skipped");
  // The notification points at the session that is actually running, not at an id that does not exist.
  expect((extras[0] as { session?: { id: string } }).session!.id).toBe("dev-shop-cms-2");
});

// The core of the morning alarm: `important` on a notification means Pushover EMERGENCY
// (priority 2 — rings every minute for a whole hour until you acknowledge it, see pushover.ts).
// "Run started" wants NOTHING from the operator, so it must not wake them like that — not even
// for a schedule that has `important` on (that carries over to the SESSION, where it only makes
// sense: blocking and finishing the work).
test("fireSchedule: \"started\" is never sent as emergency, not even for an important schedule", async () => {
  const db = openDb(":memory:");
  const extras: unknown[] = [];
  const s = createScheduler({
    db, open: async (t) => ({ session: { id: `dev-${t.project}-${t.repo}` } }),
    containerRunning: async () => false, notify: (_t, _m, e) => { extras.push(e); }, now: () => at3.getTime(),
  });
  await s.fireSchedule(sched({ important: 1 }));
  expect((extras[0] as { important?: boolean }).important).toBeUndefined();
  // the session still stays marked — only its own work is loud
  expect(getSession(db, "dev-shop-cms")).toBe(null);   // open is a stub, it created no row
});

// A skipped and a failed run are likewise just status reports.
test("fireSchedule: neither skip nor failure is emergency", async () => {
  const db = openDb(":memory:");
  const extras: (Record<string, unknown> | undefined)[] = [];
  const skip = createScheduler({
    db, open: async () => ({ session: { id: "x" } }),
    containerRunning: async () => true, notify: (_t, _m, e) => { extras.push(e as Record<string, unknown>); },
  });
  await skip.fireSchedule(sched({ important: 1 }));
  const fail = createScheduler({
    db, open: async () => { throw new Error("clone failed"); },
    containerRunning: async () => false, notify: (_t, _m, e) => { extras.push(e as Record<string, unknown>); },
  });
  await fail.fireSchedule(sched({ important: 1 }));
  expect(extras.every((e) => e?.important !== true)).toBe(true);
});

test("fireSchedule: a failed run carries the schedules target (tapping opens the schedule)", async () => {
  const db = openDb(":memory:");
  const extras: unknown[] = [];
  const fail = createScheduler({
    db, open: async () => { throw new Error("clone failed"); },
    containerRunning: async () => false, notify: (_t, _m, e) => { extras.push(e); },
  });
  await fail.fireSchedule(sched({}));
  expect(extras).toEqual([{ target: { kind: "schedules" } }]);
});

test("fireSchedule: free → open with prompt(branch) + important + audit", async () => {
  const db = openDb(":memory:");
  const opened: { prompt: string }[] = [];
  const s = createScheduler({
    db, open: async (t) => { opened.push(t as { prompt: string }); return { session: { id: `dev-${t.project}-${t.repo}` } }; },
    containerRunning: async () => false, notify: () => {}, now: () => at3.getTime(),
  });
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms", port_base: 1, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);
  await s.fireSchedule(sched());
  expect(opened[0].prompt).toContain("auto/nightly-bump-20260709-0300");
  expect(getSession(db, "dev-shop-cms")!.important).toBe(1);
  const types = (db.query("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type);
  expect(types).toContain("schedule_run");
});

// A scheduled run is one-off work, not a working session — once the agent finishes it,
// it has no reason to stay alive (autoEnd.ts). The flag lives on the session row so that a devd
// restart mid-run does not mean nobody cleans up afterwards.
test("fireSchedule: the created session gets auto_end=1", async () => {
  const db = openDb(":memory:");
  const s = createScheduler({
    db, open: async (t) => ({ session: { id: `dev-${t.project}-${t.repo}` } }),
    containerRunning: async () => false, notify: () => {}, now: () => at3.getTime(),
  });
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms", port_base: 1, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);
  await s.fireSchedule(sched());
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(1);
});

// A skipped run (someone already works under the same id) must not mark someone else's session —
// otherwise cron would kill manual work right after its first finished turn.
test("fireSchedule: a skipped run does not set auto_end", async () => {
  const db = openDb(":memory:");
  const s = createScheduler({
    db, open: async (t) => ({ session: { id: `dev-${t.project}-${t.repo}` } }),
    containerRunning: async () => true, notify: () => {}, now: () => at3.getTime(),
  });
  insertSession(db, { id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms", port_base: 1, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0 } as SessionRow);
  await s.fireSchedule(sched());
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(0);
});

// Chat schedules: no prompt file; the prompt is the session's first turn, sent through the bridge once it connects.
// `mode`: how the bridge reacts to the first turn.
function fakeLinks(mode: "accept" | "refuse" | "never" | "late" | "unknown" = "accept") {
  const calls: string[] = []; const turns: Record<string, string> = {};
  let done: ((e: Error | null) => void) | null = null;
  return {
    calls, turns,
    /** For "late": the turn went out right at the deadline and the bridge answers now. */
    answer: (e: Error | null) => done?.(e),
    links: {
      ensure: (id: string) => { calls.push(`ensure ${id}`); },
      startTurnWhenConnected: (id: string, text: string, onDone: (e: Error | null) => void) => {
        calls.push(`start ${id}`); turns[id] = text; done = onDone;
        if (mode === "accept") onDone(null);
        if (mode === "refuse") onDone(new Error("bridge refused the turn"));
        if (mode === "unknown") onDone(new CommandTimeout("bridge did not answer startTurn"));
      },
      discardFirstTurn: (id: string) => { calls.push(`discard ${id}`); delete turns[id]; return mode === "never"; },
    },
  };
}
const chatDeps = (f: ReturnType<typeof fakeLinks>, ended: string[], over: Record<string, unknown> = {}) => ({
  links: f.links, end: async (id: string) => { ended.push(id); }, changes: async () => [] as string[], repoAgent: () => null, bridgeWaitMs: 30,
  containerRunning: async () => false, ...over,
});
const row = () => ({ id: "dev-shop-cms", folder: "acme", project: "shop", repo: "cms", container: "dev-shop-cms", port_base: 1, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "chat" } as SessionRow);

test("fireSchedule (chat): opens a chat session without a prompt and sends the scheduled prompt as the first turn", async () => {
  const db = openDb(":memory:");
  const opened: Record<string, unknown>[] = []; const notes: string[] = []; const ended: string[] = [];
  const f = fakeLinks();
  const s = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: "dev-shop-cms" } }; },
    notify: (_t, m) => { notes.push(m); }, now: () => at3.getTime(), ...chatDeps(f, ended),
  });
  insertSession(db, row());
  await s.fireSchedule(sched({ runtime: "chat", agent: "codex" }));
  expect(opened[0]).toMatchObject({ runtime: "chat", agent: "codex" });
  expect(opened[0].prompt).toBeUndefined();
  expect(f.calls).toEqual(["ensure dev-shop-cms", "start dev-shop-cms"]);
  expect(f.turns["dev-shop-cms"]).toBe(scheduledPrompt(sched(), "auto/nightly-bump-20260709-0300"));
  expect(getSession(db, "dev-shop-cms")!.auto_end).toBe(1);
  expect(notes).toEqual(['Scheduled run "Nightly bump" started']);
  expect(ended).toEqual([]);
});

test("fireSchedule (chat): a devd conflict prompt goes in front of the scheduled prompt", async () => {
  const db = openDb(":memory:");
  const f = fakeLinks();
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" }, claudePrompt: "resolve the conflict" }),
    notify: () => {}, ...chatDeps(f, []),
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(f.turns["dev-shop-cms"]).toStartWith("resolve the conflict\n\nAutomated scheduled run");
});

test("fireSchedule (chat): a bridge that never connects fails visibly, drops the first turn and ends the session", async () => {
  const db = openDb(":memory:");
  const notes: string[] = []; const extras: unknown[] = []; const ended: string[] = [];
  const f = fakeLinks("never");
  insertSession(db, row());
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" } }),
    notify: (_t, m, e) => { notes.push(m); extras.push(e); }, ...chatDeps(f, ended),
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(f.calls).toContain("discard dev-shop-cms");
  expect(ended).toEqual(["dev-shop-cms"]);
  const ev = db.query("SELECT type, data FROM events").all() as { type: string; data: string }[];
  expect(ev.map((e) => e.type)).toEqual(["auto_end", "schedule_error"]);
  expect(ev[1].data).toContain("did not connect");
  expect(ev[1].data).toContain("dev-shop-cms ended");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("failed");
  expect(notes[0]).toContain("ended");
  expect(extras).toEqual([{ target: { kind: "schedules" } }]);
});

test("fireSchedule (chat): a bridge refusal of the first turn is a failure and ends the session", async () => {
  const db = openDb(":memory:");
  const notes: string[] = []; const ended: string[] = [];
  insertSession(db, row());
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" } }),
    notify: (_t, m) => { notes.push(m); }, ...chatDeps(fakeLinks("refuse"), ended),
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("bridge refused the turn");
  expect(ended).toEqual(["dev-shop-cms"]);
  expect((db.query("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type)).toEqual(["auto_end", "schedule_error"]);
});

test("fireSchedule (chat): a failure on a reused session with a dirty tree keeps the worktree", async () => {
  const db = openDb(":memory:");
  insertSession(db, { ...row(), worktree: "/w" } as SessionRow);
  const calls: unknown[] = [];
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" } }), notify: () => {},
    ...chatDeps(fakeLinks("refuse"), [], { end: async (id: string, _a: unknown, opts: unknown) => { calls.push([id, opts]); }, changes: async () => ["M src/a.ts"] }),
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(calls).toEqual([["dev-shop-cms", { keepWorktree: true }]]);
  expect((db.query("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type)).toContain("auto_end_kept");
});

test("fireSchedule (chat): a first turn with an unknown outcome keeps the session and says to check it", async () => {
  const db = openDb(":memory:");
  insertSession(db, row());
  const notes: string[] = []; const ended: string[] = [];
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" } }),
    notify: (_t, m) => { notes.push(m); }, ...chatDeps(fakeLinks("unknown"), ended),
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(ended).toEqual([]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("outcome unknown");
  expect(notes[0]).toContain("check the session");
  const ev = db.query("SELECT type, data FROM events").all() as { type: string; data: string }[];
  expect(ev.map((e) => e.type)).toEqual(["schedule_error"]);
  expect(ev[0].data).toContain("check the session");
});

test("fireSchedule (chat): a turn sent right at the deadline counts as started, not failed", async () => {
  const db = openDb(":memory:");
  const notes: string[] = []; const ended: string[] = [];
  const f = fakeLinks("late");
  const s = createScheduler({
    db, open: async () => ({ session: { id: "dev-shop-cms" } }),
    notify: (_t, m) => { notes.push(m); }, ...chatDeps(f, ended),
  });
  const run = s.fireSchedule(sched({ runtime: "chat" }));
  await Bun.sleep(60);   // past the 30 ms wait: discardFirstTurn said "already sent"
  f.answer(null);
  await run;
  expect(notes).toEqual(['Scheduled run "Nightly bump" started']);
  expect(ended).toEqual([]);
});

test("fireSchedule (chat): an agent chat cannot run fails before open, creating no session", async () => {
  const db = openDb(":memory:");
  const opened: unknown[] = []; const notes: string[] = []; const ended: string[] = [];
  const f = fakeLinks();
  const s = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: "x" } }; },
    notify: (_t, m) => { notes.push(m); }, ...chatDeps(f, ended),
  });
  await s.fireSchedule(sched({ runtime: "chat", agent: "grok" }));
  // NULL agent: the repo's remembered one counts
  const s2 = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: "x" } }; },
    notify: (_t, m) => { notes.push(m); }, ...chatDeps(f, ended, { repoAgent: () => "antigravity" }),
  });
  await s2.fireSchedule(sched({ runtime: "chat", agent: null }));
  expect(opened).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(ended).toEqual([]);
  expect(notes).toHaveLength(2);
  expect(notes.every((n) => n.includes("failed") && n.includes("not available in chat"))).toBe(true);
  expect((db.query("SELECT type FROM events").all() as { type: string }[]).map((e) => e.type)).toEqual(["schedule_error", "schedule_error"]);
});

test("fireSchedule (chat): skip-if-running is unchanged", async () => {
  const db = openDb(":memory:");
  const opened: unknown[] = []; const notes: string[] = [];
  const f = fakeLinks();
  const s = createScheduler({
    db, open: async (t) => { opened.push(t); return { session: { id: "x" } }; },
    containerRunning: async () => true, notify: (_t, m) => { notes.push(m); }, links: f.links, end: async () => {}, repoAgent: () => null,
  });
  await s.fireSchedule(sched({ runtime: "chat" }));
  expect(opened).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(notes[0]).toContain("skipped");
});

test("fireSchedule (tmux): still opens with the prompt file channel and no runtime", async () => {
  const db = openDb(":memory:");
  const opened: Record<string, unknown>[] = [];
  const s = createScheduler({ db, open: async (t) => { opened.push(t); return { session: { id: "x" } }; }, containerRunning: async () => false, notify: () => {} });
  await s.fireSchedule(sched());
  expect(opened[0].runtime).toBeUndefined();
  expect(opened[0].agent).toBeUndefined();
  expect(String(opened[0].prompt)).toContain("bump deps");
});

test("the scheduled run's started notification carries the session runtime (the Mac click opens a chat thread)", async () => {
  for (const runtime of ["chat", "tmux"] as const) {
    const db = openDb(":memory:");
    const extras: unknown[] = [];
    const f = fakeLinks();
    insertSession(db, { ...row(), runtime });
    const s = createScheduler({
      db, open: async () => ({ session: { id: "dev-shop-cms" } }),
      notify: (_t, _m, e) => { extras.push(e); }, ...chatDeps(f, []),
    });
    await s.fireSchedule(sched({ runtime }));
    expect(extras).toEqual([{ session: { id: "dev-shop-cms", project: "shop", repo: "cms", runtime } }]);
  }
  // onRestoredTurnDone (index.ts) builds its target from the session row the same way.
  expect(scheduledNotifySession({ ...row(), runtime: "chat" })).toEqual({ id: "dev-shop-cms", project: "shop", repo: "cms", runtime: "chat" });
});
