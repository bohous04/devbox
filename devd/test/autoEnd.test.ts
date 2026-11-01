import { expect, test } from "bun:test";
import { endFinishedRuns } from "../src/autoEnd";
import { getSession, insertSession, listEvents, openDb, setAutoEnd, type SessionRow } from "../src/db";
import type { Database } from "bun:sqlite";

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id, folder: "games", project: id, repo: "cms", container: id, port_base: 40100,
    status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, ...over,
  };
}

function db(...ids: string[]): Database {
  const d = openDb(":memory:");
  ids.forEach((id, i) => insertSession(d, row(id, { port_base: 40100 + i * 10 })));
  return d;
}

test("ends a session that finished its turn and has auto_end=1", async () => {
  const d = db("dev-a-cms");
  setAutoEnd(d, "dev-a-cms", 1);
  const ended: string[] = [];
  expect(await endFinishedRuns({ db: d, end: async (id) => { ended.push(id); } }, ["dev-a-cms"]))
    .toEqual(["dev-a-cms"]);
  expect(ended).toEqual(["dev-a-cms"]);
});

test("leaves a session without the flag running", async () => {
  const d = db("dev-a-cms");
  const ended: string[] = [];
  expect(await endFinishedRuns({ db: d, end: async (id) => { ended.push(id); } }, ["dev-a-cms"]))
    .toEqual([]);
  expect(ended).toEqual([]);
});

// The sweep also gets ids of sessions whose row has disappeared in the meantime (a manual End in the dashboard
// a second earlier). A missing row is not an error, there is just nothing to end.
test("skips an unknown session", async () => {
  const d = db();
  const ended: string[] = [];
  expect(await endFinishedRuns({ db: d, end: async (id) => { ended.push(id); } }, ["dev-ghost-cms"]))
    .toEqual([]);
  expect(ended).toEqual([]);
});

// One stuck docker rm must not deprive the other runs in the same tick of their cleanup.
test("one failed end does not prevent the others", async () => {
  const d = db("dev-a-cms", "dev-b-cms");
  setAutoEnd(d, "dev-a-cms", 1);
  setAutoEnd(d, "dev-b-cms", 1);
  const ended: string[] = [];
  const res = await endFinishedRuns({
    db: d,
    end: async (id) => { if (id === "dev-a-cms") throw new Error("docker rm failed"); ended.push(id); },
  }, ["dev-a-cms", "dev-b-cms"]);
  expect(res).toEqual(["dev-b-cms"]);
  expect(ended).toEqual(["dev-b-cms"]);
  // The failure must stay visible, not vanish into the console
  expect(listEvents(d).some((e) => e.type === "auto_end_error")).toBe(true);
});

// The reason belongs in the Log: a manual "End" and the automatic cleanup after cron otherwise look
// the same in events, and the difference is the only interesting thing when tracing back.
test("writes the end reason to the event log", async () => {
  const d = db("dev-a-cms");
  setAutoEnd(d, "dev-a-cms", 1);
  await endFinishedRuns({ db: d, end: async () => {} }, ["dev-a-cms"]);
  const ev = listEvents(d).find((e) => e.type === "auto_end");
  expect(ev).toBeDefined();
  expect(ev!.session_id).toBe("dev-a-cms");
});

// When ending fails, the flag must stay — otherwise nobody would try the session again.
test("the flag stays set after a failure", async () => {
  const d = db("dev-a-cms");
  setAutoEnd(d, "dev-a-cms", 1);
  await endFinishedRuns({ db: d, end: async () => { throw new Error("boom"); } }, ["dev-a-cms"]);
  expect(getSession(d, "dev-a-cms")!.auto_end).toBe(1);
});

// ——— Cron vs. uncommitted work ———
// A scheduled run ends the session WITHOUT a human in the loop. `end()` deletes the worktree
// along with work in progress (`git worktree remove --force`), so without this safeguard
// cron would silently throw away what the agent left behind. A manual end does not change.

function dbWithWorktree(dir: string | null): Database {
  const d = openDb(":memory:");
  insertSession(d, row("dev-a-cms", { worktree: dir }));
  setAutoEnd(d, "dev-a-cms", 1);
  return d;
}

test("a clean worktree is deleted (keepWorktree=false)", async () => {
  const d = dbWithWorktree("/wt/a");
  const calls: { id: string; keep?: boolean }[] = [];
  await endFinishedRuns({
    db: d, changes: async () => [],
    end: async (id, _solo, opts) => { calls.push({ id, keep: opts?.keepWorktree }); },
  }, ["dev-a-cms"]);
  expect(calls).toEqual([{ id: "dev-a-cms", keep: false }]);
  expect(listEvents(d).some((e) => e.type === "auto_end_kept")).toBe(false);
});

test("a dirty worktree stays and the reason goes to the Log", async () => {
  const d = dbWithWorktree("/wt/a");
  const calls: { id: string; keep?: boolean }[] = [];
  await endFinishedRuns({
    db: d, changes: async () => [" M src/index.ts", "?? scratch.txt"],
    end: async (id, _solo, opts) => { calls.push({ id, keep: opts?.keepWorktree }); },
  }, ["dev-a-cms"]);
  expect(calls).toEqual([{ id: "dev-a-cms", keep: true }]);
  const ev = listEvents(d).find((e) => e.type === "auto_end_kept");
  expect(ev).toBeDefined();
  const data = JSON.parse(ev!.data!) as { reason: string; worktree: string; changes: number; sample: string[] };
  expect(data.reason).toBe("dirty");
  expect(data.worktree).toBe("/wt/a");
  expect(data.changes).toBe(2);
  expect(data.sample).toContain("?? scratch.txt");
});

// "Don't know" must not pass as "clean": a deleted directory, a broken worktree registration
// or a crashed git would otherwise lead to blind `--force` deletion.
test("an undeterminable state is treated as dirty", async () => {
  const d = dbWithWorktree("/wt/a");
  const calls: { keep?: boolean }[] = [];
  await endFinishedRuns({
    db: d, changes: async () => null,
    end: async (_id, _solo, opts) => { calls.push({ keep: opts?.keepWorktree }); },
  }, ["dev-a-cms"]);
  expect(calls).toEqual([{ keep: true }]);
  expect(JSON.parse(listEvents(d).find((e) => e.type === "auto_end_kept")!.data!).reason).toBe("status-unknown");
});

// An old repo with a shared workspace: `end()` deletes nothing there, so there is nothing to ask about.
test("a session without a worktree does not ask about the state at all", async () => {
  const d = dbWithWorktree(null);
  let asked = false;
  const calls: { keep?: boolean }[] = [];
  await endFinishedRuns({
    db: d, changes: async () => { asked = true; return null; },
    end: async (_id, _solo, opts) => { calls.push({ keep: opts?.keepWorktree }); },
  }, ["dev-a-cms"]);
  expect(asked).toBe(false);
  expect(calls).toEqual([{ keep: false }]);
  expect(listEvents(d).some((e) => e.type === "auto_end_kept")).toBe(false);
});
