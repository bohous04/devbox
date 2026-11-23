import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertSession, openDb, putSessionAttention, type SessionRow } from "../src/db";
import { endingIds, endsInFlight, resumeEnds } from "../src/endsInFlight";
import { SessionManager } from "../src/sessions";
import { DEFAULT_CONFIG } from "../src/config";

let port = 41500;
const row = (id: string): SessionRow => ({
  id, folder: "acme", project: "a", repo: id, container: id, port_base: port += 10,
  status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, runtime: "tmux",
} as SessionRow);

async function withFakeDocker<T>(fn: () => Promise<T>): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const orig = process.env.PATH;
  process.env.PATH = `${bin}:${orig}`;
  try { return await fn(); } finally { process.env.PATH = orig; }
}

// Every end (F9, `dev end`, the dashboard, cron, a settle) goes through mgr.end, so that is where it is written down:
// a devd that dies mid-end (a deploy) leaves the row behind and the next devd finishes the end.
test("mgr.end records the end while it runs, with how it ends, and clears it when it finishes or fails", async () => {
  await withFakeDocker(async () => {
    const db = openDb(":memory:");
    const root = mkdtempSync(join(tmpdir(), "end-flight-"));
    insertSession(db, row("dev-a-b"));
    insertSession(db, row("dev-a-c"));
    const seen: unknown[] = [];
    const mgr = new SessionManager({
      db, cfg: DEFAULT_CONFIG, root, image: "unused", extraMounts: [], cmd: [], controlRoot: join(root, "ctl"),
      now: () => 1234,
      preserveForEnd: async (c) => { seen.push(endsInFlight(db)); if (c === "dev-a-c") throw new Error("backup failed"); },
    });
    await mgr.end("dev-a-b", "keep", { keepWorktree: true });
    await expect(mgr.end("dev-a-c", "delete")).rejects.toThrow("backup failed");
    expect(seen).toEqual([
      [{ session_id: "dev-a-b", solo_action: "keep", keep_worktree: 1, started_at: 1234 }],
      [{ session_id: "dev-a-c", solo_action: "delete", keep_worktree: 0, started_at: 1234 }],
    ]);
    expect(endsInFlight(db)).toEqual([]);
    db.close();
  });
});

test("after a restart every end that was running resumes the same way; settles stay with the inbox; gone sessions are dropped", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("dev-a-manual"));
  insertSession(db, row("dev-a-settled"));
  const put = db.query(`INSERT INTO ends_in_flight (session_id, solo_action, keep_worktree, started_at) VALUES (?,?,?,?)`);
  put.run("dev-a-manual", "delete", 1, 5);
  put.run("dev-a-settled", "keep", 0, 5);
  put.run("dev-a-gone", "keep", 0, 5);
  putSessionAttention(db, { session_id: "dev-a-settled", settled_at: 1, settled_reason: "manual", snooze_until: null, snooze_kind: null,
    updated_at: 1, end_at: 1, end_error: null, end_started_at: 2 });
  const calls: unknown[] = [];
  const notes: string[] = [];
  const resumed = resumeEnds({ db, end: async (...a) => { calls.push(a); }, notify: (t, m) => notes.push(`${t}: ${m}`) });
  expect(resumed).toEqual(["dev-a-manual"]);
  await Bun.sleep(0);
  expect(calls).toEqual([["dev-a-manual", "delete", { keepWorktree: true }]]);
  expect(notes).toEqual(["Session ended: dev-a-manual: finished after a devd restart."]);
  expect(endsInFlight(db).map((r) => r.session_id)).toEqual(["dev-a-manual", "dev-a-settled"]);
  db.close();
});

test("a resumed end that fails says so", async () => {
  const db = openDb(":memory:");
  insertSession(db, row("dev-a-manual"));
  db.query(`INSERT INTO ends_in_flight (session_id, solo_action, keep_worktree, started_at) VALUES (?,?,?,?)`).run("dev-a-manual", "keep", 0, 5);
  const notes: string[] = [];
  resumeEnds({ db, end: async () => { throw new Error("backup before ending failed: x"); }, notify: (t, m) => notes.push(`${t}: ${m}`) });
  await Bun.sleep(0);
  expect(notes).toEqual(["Ending session failed: dev-a-manual: backup before ending failed: x"]);
  db.close();
});

// Startup recovery starts stopped "running" sessions again: one whose end was cut short has its container stopped by
// the backup, and a `docker start` would throw that backup's proof away (host-docker.py) and bring back what is ending.
test("sessions with an end cut short (any end, or a started settle) are not for startup recovery", () => {
  const db = openDb(":memory:");
  db.query(`INSERT INTO ends_in_flight (session_id, solo_action, keep_worktree, started_at) VALUES (?,?,?,?)`).run("dev-a-manual", "keep", 0, 5);
  putSessionAttention(db, { session_id: "dev-a-settled", settled_at: 1, settled_reason: "manual", snooze_until: null, snooze_kind: null,
    updated_at: 1, end_at: 1, end_error: null, end_started_at: 2 });
  putSessionAttention(db, { session_id: "dev-a-waiting", settled_at: 1, settled_reason: "manual", snooze_until: null, snooze_kind: null,
    updated_at: 1, end_at: 1, end_error: null, end_started_at: null });
  expect([...endingIds(db)].sort()).toEqual(["dev-a-manual", "dev-a-settled"]);
  db.close();
});
