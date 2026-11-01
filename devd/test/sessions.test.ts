import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountMountList } from "../src/accountProfiles";
import { DEFAULT_CONFIG } from "../src/config";
import { activeLeases, getRepoAgent, getSession, insertLease, insertSession, listAccounts, listEvents, openDb, setAutoEnd, setRepoAgent, setSessionAgent, type SessionRow } from "../src/db";
import { endFinishedRuns } from "../src/autoEnd";
import { sh } from "./helpers/sh";
import { bakedAgentStale, credentialMounts, existingSessionId, resolveAgent, SessionManager, sessionWorktreePath } from "../src/sessions";
import { barePath } from "../src/tree";
import { hasDocker as dockerAvailable, removeContainers, RUN_ID, testPortBase } from "./helpers/docker";

// Linux only: Docker Desktop on a mac reports the bind source as /host_mnt/private/… after the
// container stops, so the workspace check (correctly) rejects recreate; devd runs on Linux.
const hasDocker = process.platform === "linux" && dockerAvailable;

// Docker containers, volumes and HOST PORTS are a GLOBAL resource shared with everything that
// runs against the same docker daemon — another parallel session on the same mac, a second
// concurrent run of this suite, .... A hard-coded "shop"/"dev-shop-app"/port 41200 without
// a unique suffix collided on both "name already in use" and "port is already
// allocated" (see docs/account-pool-followups.md — the second only surfaced here,
// after the container names were fixed: two concurrent runs with different names still
// hit the same `-p 127.0.0.1:41200:...`). Names therefore carry RUN_ID (PID +
// randomness) and ports a random block — see helpers/docker.ts. `d.root` (mkdtempSync) is
// already unique on the FILESYSTEM by itself, so a conflict was only possible on the docker name and port.
const PROJECT = `shop-${RUN_ID}`;
const APP_ID = `dev-${PROJECT}-app`;
const ACCT_VOLUME = `devd-test-acct-primary-${RUN_ID}`;
const PORT_BASE = testPortBase();

// A test that fails before its `end()` would leave the container alive and the next test would
// then hit "name already in use" (openSolo numbers by the fresh root,
// so it picks claudeSolo-1 again) — one failure would spill into other tests.
afterEach(() => { if (hasDocker) removeContainers(`dev-${PROJECT}-`); });
afterAll(() => { if (hasDocker) sh(process.cwd(), "docker", "volume", "rm", "-f", ACCT_VOLUME); });

function makeDeps() {
  const root = mkdtempSync(join(tmpdir(), "devd-sess-"));
  const bare = join(root, "origin.git");
  sh(root, "git", "init", "--bare", "-b", "main", bare);
  const seed = mkdtempSync(join(tmpdir(), "seed-"));
  sh(seed, "git", "init", "-b", "main"); sh(seed, "git", "config", "user.email", "t@t"); sh(seed, "git", "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), "x\n");
  sh(seed, "git", "add", "."); sh(seed, "git", "commit", "-m", "init");
  sh(seed, "git", "push", bare, "HEAD:main");
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.settings.portRangeStart = PORT_BASE;
  const notifications: string[][] = [];
  return {
    db: openDb(":memory:"), cfg, root, image: "alpine:3", extraMounts: [], cmd: ["sleep", "infinity"], bareUrl: bare,
    controlRoot: join(root, "ctl"),
    notifications, notify: (t: string, m: string) => notifications.push([t, m]),
  };
}

test.skipIf(!hasDocker)("open → stop → reopen → end lifecycle", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const opened = await mgr.open(t);
  expect(opened.created).toBe(true);
  expect(opened.session.id).toBe(APP_ID);
  expect(opened.session.port_base).toBe(PORT_BASE);
  expect(opened.pull.status).toBe("clean");
  // A new repo is cloned into the new shape (bare + worktree), so the session's files live
  // in its worktree, not in the repo's shared working directory.
  expect(existsSync(join(sessionWorktreePath(d.root, APP_ID), "f.txt"))).toBe(true);

  await mgr.stop(APP_ID);
  expect(mgr.list()[0].status).toBe("stopped");

  const reopened = await mgr.open(t);
  expect(reopened.created).toBe(false);
  expect(mgr.list()[0].status).toBe("running");

  await mgr.end(APP_ID);
  expect(mgr.list()).toHaveLength(0);
  expect(existsSync(barePath(d.root, "acme", PROJECT, "app"))).toBe(true); // repo stays
}, 180_000);

// The core of Task 5: two sessions on ONE repo stop stepping on each other's files.
// It verifies the result on disk and in the container, not that some command was issued.
test.skipIf(!hasDocker)("two sessions of one repo have their own worktree and their own branch", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const first = await mgr.open(t);
  const second = await mgr.open({ ...t, fresh: true });
  // Cleanup even on failure: a forgotten container holds the name and port and would break the rest of the file.
  try {
    expect(existsSync(barePath(d.root, "acme", PROJECT, "app"))).toBe(true);
    // The repo's shared working directory is no longer created — both sessions would sit exactly in it.
    expect(existsSync(join(d.root, "acme", PROJECT, "app"))).toBe(false);

    const w1 = getSession(d.db, first.session.id)!.worktree!;
    const w2 = getSession(d.db, second.session.id)!.worktree!;
    expect(w1).toBe(sessionWorktreePath(d.root, APP_ID));
    expect(w2).toBe(sessionWorktreePath(d.root, `${APP_ID}-2`));
    expect(existsSync(join(w1, "f.txt"))).toBe(true);
    expect(existsSync(join(w2, "f.txt"))).toBe(true);

    // The first session holds the default branch (the bare clone does not hold it, so it can take it), the second
    // got its own — git does not allow the same branch in two worktrees.
    expect(sh(w1, "git", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("main");
    expect(sh(w2, "git", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("session/app-2");

    // The files are separate: this is the whole point of the task.
    writeFileSync(join(w2, "second-only.txt"), "x\n");
    expect(existsSync(join(w1, "second-only.txt"))).toBe(false);

    // And git inside the container is not dead: `.git` in the worktree is a file with an ABSOLUTE
    // host path to the bare clone, so without mounting it at the same path every git command
    // inside ends with "not a git repository". The test image has no git, so we
    // ask about what matters — whether that path is visible inside.
    const gitdir = readFileSync(join(w2, ".git"), "utf8").replace("gitdir:", "").trim();
    expect(sh(process.cwd(), "docker", "exec", second.session.id, "ls", join(gitdir, "HEAD")).code).toBe(0);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 300_000);

// Incident 2026-10-05: a session with the base id got branch `session/app-1` at creation,
// because another session of the repo was running alongside. On a later reopen there was no
// sibling in the DB, the branch was computed AGAIN as "first session" → `main`, and the repair
// of the lost worktree registration thus moved the session to the default branch. The branch is a property
// of the session decided ONCE at creation; reopen must take it from the row, not derive it.
test.skipIf(!hasDocker)("reopen with a broken registration returns the session to ITS branch, not the default", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await mgr.open(t);                                   // APP_ID on main
  await mgr.open({ ...t, fresh: true });               // APP_ID-2
  try {
    await mgr.end(APP_ID);
    const again = await mgr.open({ ...t, fresh: true }); // bare id back, but not the first
    expect(again.session.id).toBe(APP_ID);
    const wt = getSession(d.db, APP_ID)!.worktree!;
    expect(sh(wt, "git", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("session/app-1");
    expect(getSession(d.db, APP_ID)!.branch).toBe("session/app-1");

    await mgr.end(`${APP_ID}-2`);                      // the sibling is gone
    await mgr.stop(APP_ID);
    rmSync(join(barePath(d.root, "acme", PROJECT, "app"), "worktrees", APP_ID), { recursive: true, force: true });
    await mgr.open(t);
    expect(sh(wt, "git", "rev-parse", "--abbrev-ref", "HEAD").stdout.trim()).toBe("session/app-1");
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 300_000);

// Rows from before the `branch` column: devd fills in their branch from the LIVE worktree at startup,
// while the registration still works — later there would be nowhere to take it from.
test("recordBranches fills in a missing branch from a live worktree and leaves a broken one alone", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const bare = join(d.root, "app.git");
  sh(d.root, "git", "clone", "--bare", "-q", d.bareUrl, bare);
  const live = join(d.root, "_sessions", "dev-x-app");
  const dead = join(d.root, "_sessions", "dev-x-app-2");
  sh(bare, "git", "worktree", "add", "-q", "-b", "session/app-1", live, "main");
  sh(bare, "git", "worktree", "add", "-q", "-b", "session/app-2", dead, "main");
  rmSync(join(bare, "worktrees", "dev-x-app-2"), { recursive: true, force: true });
  const row = (id: string, worktree: string, port_base: number, branch?: string): SessionRow => ({
    id, folder: "x", project: "x", repo: "app", container: id, port_base, status: "running", solo: 0,
    created_at: 1, last_active_at: 1, important: 0, worktree, branch,
  });
  insertSession(d.db, row("dev-x-app", live, 50000));
  insertSession(d.db, row("dev-x-app-2", dead, 50020));
  insertSession(d.db, row("dev-x-app-3", live, 50040, "session/app-3"));

  await mgr.recordBranches();

  expect(getSession(d.db, "dev-x-app")!.branch).toBe("session/app-1");
  expect(getSession(d.db, "dev-x-app-2")!.branch).toBeNull();
  expect(getSession(d.db, "dev-x-app-3")!.branch).toBe("session/app-3"); // a recorded one is not overwritten
});

// Finding from the Task 7 review: the "Attach / New session" menu asks by the RUNNING sessions
// of the repo, but `open()` without `fresh` reached hard for the BASE id `dev-<project>-<repo>`.
// When its row was missing (the session ended), `nextSessionId` returned it as free and
// "attach" SILENTLY created a new container with its own worktree and branch; when the row was
// stopped, something other than the running one the prompt was about got revived.
test.skipIf(!hasDocker)("open() without fresh attaches to a running session of the repo even when the base id is not running", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const first = await mgr.open(t);
  const second = await mgr.open({ ...t, fresh: true });
  try {
    expect(first.session.id).toBe(APP_ID);
    expect(second.session.id).toBe(`${APP_ID}-2`);

    // 1) Base session stopped (watchdog), the second is running → attach to the RUNNING one.
    await mgr.stop(APP_ID);
    const onStopped = await mgr.open(t);
    expect(onStopped.session.id).toBe(`${APP_ID}-2`);
    expect(onStopped.created).toBe(false);
    expect(getSession(d.db, APP_ID)!.status).toBe("stopped");   // the stopped one was not revived

    // 2) Base session ended (row deleted), the second is running → still attach, do not create.
    await mgr.end(APP_ID);
    const onEnded = await mgr.open(t);
    expect(onEnded.session.id).toBe(`${APP_ID}-2`);
    expect(onEnded.created).toBe(false);
    expect(mgr.list()).toHaveLength(1);                          // no extra container
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 300_000);

// Task 6: end() cleans up the worktree session but leaves the branch alone — work in progress
// may hang on it and deleting it quietly when a window closes would be destructive.
test.skipIf(!hasDocker)("end() deletes the worktree session but does NOT let the branch disappear", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const first = await mgr.open(t);
  const second = await mgr.open({ ...t, fresh: true });
  try {
    const wt = getSession(d.db, second.session.id)!.worktree!;
    expect(existsSync(wt)).toBe(true);

    await mgr.end(second.session.id);

    // The worktree belongs to the session and leaves with it.
    expect(existsSync(wt)).toBe(false);
    // The branch does NOT: orphaned branches are an acceptable price, lost work is not.
    const branches = sh(barePath(d.root, "acme", PROJECT, "app"), "git", "branch", "--list").stdout;
    expect(branches).toContain("session/app-2");
    // And the first session must not lose its worktree because of this.
    expect(existsSync(getSession(d.db, first.session.id)!.worktree!)).toBe(true);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 300_000);

// A clash of two features that arose independently (merge origin/main): cron ends the session BY ITSELF
// after finished work (autoEnd.ts) and end() DELETES the worktree including uncommitted work
// (`worktree remove --force`). Together that would silently throw away work without a human
// in the loop, so the automatic cleanup deletes only a CLEAN tree. A manual End is not affected.
// The whole path for real: the real `mgr.end`, real git, no injected stub.
test.skipIf(!hasDocker)("automatic cleanup: a dirty worktree stays, a clean one disappears", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const end = (id: string, soloAction?: "keep" | "delete", opts?: { keepWorktree?: boolean }) => mgr.end(id, soloAction, opts);
  await mgr.open(t);                                   // the first session holds the repo
  try {
    // Both sessions are created AT ONCE: `nextSessionId` fills gaps from the bottom, so
    // opening the second only after ending the first would mean the same slot and the same directory.
    const dirty = await mgr.open({ ...t, fresh: true });
    const clean = await mgr.open({ ...t, fresh: true });
    const dirtyWt = getSession(d.db, dirty.session.id)!.worktree!;
    const cleanWt = getSession(d.db, clean.session.id)!.worktree!;
    setAutoEnd(d.db, dirty.session.id, 1);
    setAutoEnd(d.db, clean.session.id, 1);
    writeFileSync(join(dirtyWt, "wip.txt"), "agent work\n");   // untracked = work in progress

    expect(await endFinishedRuns({ db: d.db, end }, [dirty.session.id, clean.session.id]))
      .toEqual([dirty.session.id, clean.session.id]);

    // Dirty: the directory survived, the session still ended and the Log says why.
    expect(existsSync(dirtyWt)).toBe(true);
    expect(getSession(d.db, dirty.session.id)).toBeNull();
    const kept = listEvents(d.db, { session: dirty.session.id }).find((e) => e.type === "auto_end_kept");
    expect(kept).toBeDefined();
    expect(JSON.parse(kept!.data!).reason).toBe("dirty");
    expect(readFileSync(join(dirtyWt, "wip.txt"), "utf8")).toContain("agent work");

    // Clean: cleaned up as before and no "I left a directory here" is reported.
    expect(existsSync(cleanWt)).toBe(false);
    expect(listEvents(d.db, { session: clean.session.id }).some((e) => e.type === "auto_end_kept")).toBe(false);
  } finally { for (const s of mgr.list()) await mgr.end(s.id); }
}, 300_000);

// Existing repos are not migrated: whatever is in the shared working directory today stays there
// and behaves exactly as before. The repo is built by hand, because open() clones new repos
// straight into the new shape.
test.skipIf(!hasDocker)("a repo in the old shape stays on the shared workspace", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const ws = join(d.root, "acme", PROJECT, "old");
  sh(d.root, "git", "clone", d.bareUrl, ws);         // clone into the current location

  const s = await mgr.open({ folder: "acme", project: PROJECT, repo: "old", cloneUrl: d.bareUrl });
  try {
    expect(getSession(d.db, s.session.id)!.worktree).toBeNull();
    expect(existsSync(barePath(d.root, "acme", PROJECT, "old"))).toBe(false);
    expect(existsSync(sessionWorktreePath(d.root, s.session.id))).toBe(false);
    const mounts = sh(process.cwd(), "docker", "inspect", s.session.id, "--format", "{{json .Mounts}}").stdout;
    expect(mounts).toContain(ws);
  } finally { for (const x of mgr.list()) await mgr.end(x.id); }
}, 180_000);

// Task 6, safety boundary: `worktree === null` is the shared repo directory in the old
// shape — it also belongs to the other sessions on the same repo, so end() must not delete it (unlike
// the new-shape worktree above).
test.skipIf(!hasDocker)("end() does not delete the shared workspace of an old-shape repo", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const ws = join(d.root, "acme", PROJECT, "old2");
  sh(d.root, "git", "clone", d.bareUrl, ws);         // clone into the current location

  const s = await mgr.open({ folder: "acme", project: PROJECT, repo: "old2", cloneUrl: d.bareUrl });
  expect(getSession(d.db, s.session.id)!.worktree).toBeNull();

  await mgr.end(s.session.id);
  expect(existsSync(ws)).toBe(true);
}, 180_000);

// auto_end (the flag "when the agent finishes its turn, end the session") applies EXCLUSIVELY to that
// one scheduled run. If it stays stuck on a stopped session and you then open it
// by hand, it would vanish under you right after your first own finished turn.
// So every container restart clears it; the scheduler sets it itself after open().
test.skipIf(!hasDocker)("open clears auto_end inherited from a scheduled run", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await mgr.open(t);
  setAutoEnd(d.db, APP_ID, 1);
  await mgr.stop(APP_ID);

  await mgr.open(t);
  expect(getSession(d.db, APP_ID)!.auto_end).toBe(0);
  await mgr.end(APP_ID);
}, 180_000);

test.skipIf(!hasDocker)("open recreates container removed out-of-band", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  const first = await mgr.open(t);
  sh(process.cwd(), "docker", "rm", "-f", APP_ID);
  const reopened = await mgr.open(t);
  expect(reopened.created).toBe(false);
  expect(reopened.session.port_base).toBe(first.session.port_base);
  expect(mgr.list()[0].status).toBe("running");
  await mgr.end(APP_ID);
}, 180_000);

test.skipIf(!hasDocker)("open cleans up reserved port when runContainer fails", async () => {
  const d = makeDeps();
  d.image = "devd-no-such-image:nope";
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await expect(mgr.open(t)).rejects.toThrow();
  expect(mgr.list()).toHaveLength(0);
}, 120_000);

test.skipIf(!hasDocker)("claudeSolo numbering and delete-on-end", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s1 = await mgr.openSolo("acme", PROJECT);
  expect(s1.session.id).toBe(`dev-${PROJECT}-claudeSolo-1`);
  expect(existsSync(join(d.root, "acme", PROJECT, "claudeSolo-1", ".git"))).toBe(true);
  await mgr.end(s1.session.id, "delete");
  expect(existsSync(join(d.root, "acme", PROJECT, "claudeSolo-1"))).toBe(false);
}, 180_000);

test.skipIf(!hasDocker)("conflict writes prompt file, clean clears it, end removes control dir", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await mgr.open(t);
  const ctl = join(d.root, "ctl", APP_ID);
  const promptFile = join(ctl, "prompt");
  expect(existsSync(promptFile)).toBe(false);
  await mgr.stop(APP_ID);

  const other = join(d.root, "other");
  sh(d.root, "git", "clone", d.bareUrl, other);
  sh(other, "git", "config", "user.email", "t@t"); sh(other, "git", "config", "user.name", "t");
  writeFileSync(join(other, "f.txt"), "remote\n");
  sh(other, "git", "commit", "-am", "remote"); sh(other, "git", "push");
  const ws = sessionWorktreePath(d.root, APP_ID);
  sh(ws, "git", "config", "user.email", "t@t"); sh(ws, "git", "config", "user.name", "t");
  writeFileSync(join(ws, "f.txt"), "local\n");
  sh(ws, "git", "commit", "-am", "local");

  const conflicted = await mgr.open(t);
  expect(conflicted.pull.status).toBe("conflict");
  expect(readFileSync(promptFile, "utf8")).toContain("A git pull resulted in a conflict");
  expect(conflicted.claudePrompt).toContain("f.txt");
  expect(d.notifications).toHaveLength(1);
  expect(d.notifications[0][1]).toContain(`${PROJECT}/app`);
  expect(d.notifications[0][1]).toContain("pull conflict");

  await mgr.stop(APP_ID);
  sh(ws, "git", "rebase", "--abort");
  sh(ws, "git", "reset", "--hard", "origin/main");
  const clean = await mgr.open(t);
  expect(clean.pull.status).toBe("clean");
  expect(existsSync(promptFile)).toBe(false);

  await mgr.end(APP_ID);
  expect(existsSync(ctl)).toBe(false);
}, 240_000);

test.skipIf(!hasDocker)("open({prompt}) writes the initial prompt to the prompt channel; without a prompt it is clean", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const promptFile = join(d.root, "ctl", APP_ID, "prompt");

  // with a prompt: clean pull → the prompt is written (scheduled run)
  const withPrompt = await mgr.open({ folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl, prompt: "scheduled task: do X" });
  expect(withPrompt.claudePrompt).toBe("scheduled task: do X");
  expect(readFileSync(promptFile, "utf8")).toBe("scheduled task: do X");
  await mgr.stop(APP_ID);

  // without a prompt: clean pull → the file is deleted (behaviour unchanged)
  const noPrompt = await mgr.open({ folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl });
  expect(noPrompt.claudePrompt).toBeUndefined();
  expect(existsSync(promptFile)).toBe(false);
  await mgr.end(APP_ID);
}, 180_000);

test("open() resolves gitea credentials for the clone URL (before docker; no docker needed)", async () => {
  const d = makeDeps();
  d.image = "devd-no-such-image:nope"; // runContainer fails AFTER the clone → no container started
  const seen: string[] = [];
  const mgr = new SessionManager({ ...d, credentials: (url) => { seen.push(url); return {}; } });
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await mgr.open(t).catch(() => {}); // clone (+pull) run first; the container start then fails
  // credentials() is resolved once from the clone URL and reused for clone + pull.
  expect(seen).toEqual([d.bareUrl]);
  expect(existsSync(join(sessionWorktreePath(d.root, APP_ID), "f.txt"))).toBe(true); // clone happened
});

test("credentialMounts builds read-only gh + gitea mounts when set", () => {
  expect(credentialMounts(undefined, undefined)).toEqual([]);
  expect(credentialMounts("/home/u/.config/gh", "/etc/devd/gitea-tokens.json")).toEqual([
    "/home/u/.config/gh:/home/dev/.config/gh:ro",
    "/etc/devd/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro",
  ]);
});

// Session selection for "attach" (without `fresh`) without docker — only rows in the DB. Covers
// the ordering the fix relies on: running before stopped, on a tie the lowest ordinal.
let portSeq = 0;   // `port_base` is UNIQUE — every row must get its own
const row = (id: string, status: "running" | "stopped", created_at = 0): SessionRow => ({
  id, folder: "acme", project: PROJECT, repo: "app", container: id,
  port_base: 41300 + portSeq++, status, solo: 0, created_at, last_active_at: 0, important: 0,
});

test("existingSessionId: running wins over stopped, even when the stopped one is the base", () => {
  const d = makeDeps();
  insertSession(d.db, row(APP_ID, "stopped"));
  insertSession(d.db, row(`${APP_ID}-2`, "running"));
  expect(existingSessionId(d.db, PROJECT, "app")).toBe(`${APP_ID}-2`);
});

test("existingSessionId: a missing base id row does not mean \"create a new one\"", () => {
  const d = makeDeps();
  insertSession(d.db, row(`${APP_ID}-2`, "running"));
  // This is the silent case: `nextSessionId` would return the base id as free.
  expect(existingSessionId(d.db, PROJECT, "app")).toBe(`${APP_ID}-2`);
});

test("existingSessionId: on an equal state the lowest ordinal wins, not the table order", () => {
  const d = makeDeps();
  insertSession(d.db, row(`${APP_ID}-10`, "running", 1));
  insertSession(d.db, row(`${APP_ID}-2`, "running", 2));
  // Without the base session, otherwise the assertion would pass even with string sorting (the base is
  // a prefix of both). Numerically `-2` < `-10`, as strings the other way round — THIS is what the test should measure.
  expect(existingSessionId(d.db, PROJECT, "app")).toBe(`${APP_ID}-2`);
  insertSession(d.db, row(APP_ID, "running", 3));      // inserted last, still wins
  expect(existingSessionId(d.db, PROJECT, "app")).toBe(APP_ID);
  insertSession(d.db, row(`${APP_ID}-3`, "stopped", 0));
  expect(existingSessionId(d.db, PROJECT, "app")).toBe(APP_ID);
});

test("existingSessionId: another repo does not count and without rows it returns null", () => {
  const d = makeDeps();
  expect(existingSessionId(d.db, PROJECT, "app")).toBeNull();
  insertSession(d.db, { ...row(`dev-${PROJECT}-web`, "running"), repo: "web" });
  expect(existingSessionId(d.db, PROJECT, "app")).toBeNull();
});

test("restartSolo throws Unknown session for a missing id", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  await expect(mgr.restartSolo("nope")).rejects.toThrow(/Unknown session/);
});

test("restartSolo rejects a non-solo session", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  insertSession(d.db, { id: APP_ID, folder: "acme", project: PROJECT, repo: "app", container: APP_ID,
    port_base: 41300, status: "stopped", solo: 0, created_at: 0, last_active_at: 0, important: 0 });
  await expect(mgr.restartSolo(APP_ID)).rejects.toThrow(/is not a claudeSolo/);
});

test.skipIf(!hasDocker)("restartSolo brings a stopped solo back on the same port", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  await mgr.stop(s.session.id);
  await mgr.restartSolo(s.session.id);
  expect(mgr.list().find((x) => x.id === s.session.id)?.status).toBe("running");
  await mgr.end(s.session.id, "delete");
}, 180_000);

// Sister test to "proxy profile: an unlocked vault propagates into an existing
// container" a bit below — that one goes via open(), this one via restartSolo. This path
// used to be missing: restartSolo went straight to startContainer with the old environment, so
// a stopped solo proxy session reproduced the same dead end ("unlock the vault
// and open again" forever) even after unlocking.
test.skipIf(!hasDocker)("restartSolo: a stopped proxy session picks up the key after the vault is unlocked", async () => {
  const d = makeDeps();
  d.cfg.settings.proxyModels = { gpt: "gpt-5.6-sol" };
  let key: string | null = null;                       // locked vault
  const mgr = new SessionManager({ ...d, cliproxyKey: () => key });
  const s = await mgr.openSolo("acme", PROJECT, "claude-gpt");
  const born = containerId(s.session.id);
  await mgr.stop(s.session.id);

  // 1) A restart with a LOCKED vault must not tear anything down — an empty key is not newer.
  await mgr.restartSolo(s.session.id);
  expect(containerId(s.session.id)).toBe(born);
  await mgr.stop(s.session.id);

  // 2) Unlocked vault + restart of a stopped session: the container is rebuilt and the key arrives.
  key = "k-after-unlock";
  await mgr.restartSolo(s.session.id);
  expect(containerId(s.session.id)).not.toBe(born);
  expect(inspectEnv(s.session.id).DEVD_CLIPROXY_KEY).toBe("k-after-unlock");
  expect(inspectEnv(s.session.id).DEVD_AGENT_MODEL).toBe("gpt-5.6-sol");
  const recreates = listEvents(d.db, { session: s.session.id }).filter((e) => e.type === "recreate");
  expect(recreates.some((e) => JSON.parse(e.data ?? "{}").reason === "proxy-env")).toBe(true);

  await mgr.end(s.session.id, "delete");
}, 300_000);

// The highest risk of all of Task 10: with the real PRODUCTION closure from index.ts
// (`accountMountList(listAccounts(db).map(...))`), over a real (empty) DB, a BIT-IDENTICAL
// `RunOpts` must come out — exactly what goes into `docker run` — as without
// `accountMounts` at all. The previous version of the test only checked that the output
// did not contain "claude-acct-" (that would pass even with an extra foreign mount) and also
// spread `[]` by hand (proving only JS spread semantics, not the DB closure).
// This test goes straight to `runOpts()` (without docker — deterministic and fast;
// `docker inspect` does not guarantee a `.Mounts` order matching the `-v` arguments,
// so comparing the `docker run` arguments BEFORE Docker reorders them
// is a more precise test of the real gate).
// /resume isolation: all containers have cwd /workspace and share claude-home,
// so the transcripts of ALL sessions on the whole devbox land in one project
// key `projects/-workspace` — /resume in any session then offered ~200 foreign
// conversations. A per-session directory bind-mounted OVER that key keeps the rest of
// ~/.claude shared (auth, settings, upkeep) and the picker sees only its own history.
test("runOpts: projects/-workspace is overlaid by a per-session directory (/resume isolation)", async () => {
  const d = makeDeps();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = new SessionManager(d) as any;
  const opts = await mgr.runOpts(APP_ID, "/tmp/ws", 41200, PROJECT, "app", "claude");
  expect(opts.extraMounts).toContain(
    `${join(d.root, "_claude-projects", APP_ID)}:/home/dev/.claude/projects/-workspace`,
  );
});

// A bind mount of a nonexistent host directory would make docker create it ROOT-owned
// and cc (uid 1000) would silently not write transcripts — the same trap as a root-owned .git
// in a fresh clone. So the directory must be created (and owned by uid 1000) already in runOpts.
test("runOpts: the per-session projects directory exists and is owned by uid 1000", async () => {
  const d = makeDeps();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = new SessionManager(d) as any;
  await mgr.runOpts(APP_ID, "/tmp/ws", 41200, PROJECT, "app", "claude");
  const dir = join(d.root, "_claude-projects", APP_ID);
  expect(existsSync(dir)).toBe(true);
  expect(statSync(dir).uid).toBe(process.getuid?.() === 0 ? 1000 : process.getuid!());
});

test.skipIf(!hasDocker)("end() cleans up the per-session projects directory", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  const dir = join(d.root, "_claude-projects", s.session.id);
  expect(existsSync(dir)).toBe(true);
  await mgr.end(s.session.id, "delete");
  expect(existsSync(dir)).toBe(false);
}, 60_000);

test("zero accounts from the production closure = identical RunOpts as without accountMounts at all", async () => {
  const d = makeDeps();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseline = new SessionManager(d) as any;
  const pooled = new SessionManager({ ...d, accountMounts: () => accountMountList(listAccounts(d.db).map((a) => a.id)) }) as any;
  // await is REQUIRED here: since runOpts became async (PR #36), toEqual on two
  // Promises would compare two empty objects and always pass, even with an extra foreign mount.
  const baseOpts = await baseline.runOpts(APP_ID, "/tmp/ws", 41200, PROJECT, "app", "claude");
  const poolOpts = await pooled.runOpts(APP_ID, "/tmp/ws", 41200, PROJECT, "app", "claude");
  expect(poolOpts).toEqual(baseOpts);
});

// Sister test to the previous one: `accountMounts` MUST be reflected when
// an account actually exists — otherwise the equality above could pass just because
// mounts are not computed at all.
test.skipIf(!hasDocker)("open() on an idle session adds a missing account mount by rebuilding the container", async () => {
  const d = makeDeps();
  sh(process.cwd(), "docker", "volume", "create", ACCT_VOLUME);
  const mounts: string[] = [];
  const mgr = new SessionManager({ ...d, accountMounts: () => mounts });
  try {
    const s = await mgr.openSolo("acme", PROJECT);
    const before = sh(process.cwd(), "docker", "inspect", "-f", "{{.Id}}", s.session.id).stdout.trim();
    expect(sh(process.cwd(), "docker", "inspect", s.session.id, "--format", "{{json .Mounts}}").stdout)
      .not.toContain("/home/dev/.claude-accounts/primary");
    mounts.push(`${ACCT_VOLUME}:/home/dev/.claude-accounts/primary`);
    const again = await mgr.open({ folder: "acme", project: PROJECT, repo: s.session.repo });
    expect(again.created).toBe(false);
    expect(again.session.id).toBe(s.session.id);
    const after = sh(process.cwd(), "docker", "inspect", "-f", "{{.Id}}", s.session.id).stdout.trim();
    expect(after).not.toBe(before);
    const inspect = sh(process.cwd(), "docker", "inspect", s.session.id, "--format", "{{json .Mounts}}").stdout;
    expect(inspect).toContain(ACCT_VOLUME);
    expect(inspect).toContain("/home/dev/.claude-accounts/primary");
    expect(listEvents(d.db).some((e) => e.type === "recreate" && e.data?.includes("account-mounts"))).toBe(true);
    await mgr.end(s.session.id, "delete");
  } finally {
    sh(process.cwd(), "docker", "volume", "rm", "-f", ACCT_VOLUME);
  }
}, 90_000);

test.skipIf(!hasDocker)("accountMounts is reflected in the mounts of a new container", async () => {
  const d = makeDeps();
  sh(process.cwd(), "docker", "volume", "create", ACCT_VOLUME);
  const mgr = new SessionManager({ ...d, accountMounts: () => [`${ACCT_VOLUME}:/home/dev/.claude-accounts/primary`] });
  try {
    const s = await mgr.openSolo("acme", PROJECT);
    const mounts = sh(process.cwd(), "docker", "inspect", s.session.id, "--format", "{{json .Mounts}}").stdout;
    expect(mounts).toContain(ACCT_VOLUME);
    expect(mounts).toContain("/home/dev/.claude-accounts/primary");
    await mgr.end(s.session.id, "delete");
  } finally {
    sh(process.cwd(), "docker", "volume", "rm", "-f", ACCT_VOLUME);
  }
}, 60_000);

// Important #1 from the review: `prodMounts` (a few lines up in the same file) wraps
// a structurally identical risk in try/catch, so a bad dependency does not prevent
// the container from being created. `accountMounts` was the only unguarded call on that line —
// this test fails without the guard (the exception falls through from runOpts into open()).
test.skipIf(!hasDocker)("an accountMounts that throws does not stop the container from being created", async () => {
  const d = makeDeps();
  const mgr = new SessionManager({ ...d, accountMounts: () => { throw new Error("db is down right now"); } });
  const s = await mgr.openSolo("acme", PROJECT);
  expect(mgr.list().find((x) => x.id === s.session.id)?.status).toBe("running");
  await mgr.end(s.session.id, "delete");
}, 60_000);

test.skipIf(!hasDocker)("end() releases the session lease so the account does not stay busy after ending", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  insertLease(d.db, { account_id: "primary", client: "devbox", session_id: s.session.id, label: null, created_at: Date.now(), released_at: null });
  expect(activeLeases(d.db, Date.now(), 999_999_999).some((l) => l.session_id === s.session.id)).toBe(true);
  await mgr.end(s.session.id, "delete");
  expect(activeLeases(d.db, Date.now(), 999_999_999).some((l) => l.session_id === s.session.id)).toBe(false);
}, 60_000);

// Important #1 from the review, second half: `releaseLeasesForSession` sits BETWEEN
// `removeContainer` and `deleteSession` — without the guard an error here would leave
// an orphaned session row pointing at a container that no longer exists. Simulated
// by dropping the `account_leases` table so the query really fails (not a mock).
test.skipIf(!hasDocker)("end() survives an error while releasing the lease — the session is still deleted", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  d.db.query("DROP TABLE account_leases").run();
  await mgr.end(s.session.id, "delete");
  expect(mgr.list()).toHaveLength(0);
}, 60_000);

// Follow-up (docs/account-pool-followups.md): `stop()` did not release the lease, only
// `end()` did — so a stopped session looked running in the dashboard (the lease keeps
// the account taken until `autoStopHours` expires) and the poller on that account needlessly
// ran at the fast cadence even after the stop. Symmetry with `end()`: the same call, at
// the same place in the order (after stopping the container, before writing the state to the DB).
test.skipIf(!hasDocker)("stop() releases the session lease so the account does not stay busy after stopping", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  insertLease(d.db, { account_id: "primary", client: "devbox", session_id: s.session.id, label: null, created_at: Date.now(), released_at: null });
  expect(activeLeases(d.db, Date.now(), 999_999_999).some((l) => l.session_id === s.session.id)).toBe(true);
  await mgr.stop(s.session.id);
  expect(activeLeases(d.db, Date.now(), 999_999_999).some((l) => l.session_id === s.session.id)).toBe(false);
  await mgr.end(s.session.id, "delete");
}, 60_000);

// The same resilience as `end()`: an error while releasing the lease (table gone) must not
// prevent the container stop itself — `stop()` is the only operation here, there is no
// further step (like `deleteSession` in `end()`) that could hang on it, but
// the principle "a side effect must not drown the main one" applies just the same.
test.skipIf(!hasDocker)("stop() survives an error while releasing the lease — the session still stops", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const s = await mgr.openSolo("acme", PROJECT);
  d.db.query("DROP TABLE account_leases").run();
  await mgr.stop(s.session.id);
  expect(mgr.list().find((x) => x.id === s.session.id)?.status).toBe("stopped");
  await mgr.end(s.session.id, "delete");
}, 60_000);

test("resolveAgent: explicit choice → remembered → claude", () => {
  expect(resolveAgent("codex", "claude")).toBe("codex");
  expect(resolveAgent(undefined, "codex")).toBe("codex");
  expect(resolveAgent(undefined, null)).toBe("claude");
  expect(resolveAgent(undefined, undefined)).toBe("claude");
});

// After a live agent switch (agentSwitch.ts) the DB carries the new profile, but the container has
// the old DEVD_AGENT baked in — a reopen via docker start would silently return the session to
// the old agent. So REALITY decides (the container env); the DB is only a fallback for
// an unreadable inspect / missing container.
test("bakedAgentStale: the container reality decides, the DB is the fallback", () => {
  expect(bakedAgentStale("codex", "claude", "claude")).toBe(true);   // switched live → recreate
  expect(bakedAgentStale("claude", "codex", "claude")).toBe(false);  // env matches → just docker start
  expect(bakedAgentStale("codex", "codex", "codex")).toBe(false);
  expect(bakedAgentStale(undefined, "codex", "claude")).toBe(true);  // no env → today's DB comparison
  expect(bakedAgentStale(undefined, "claude", "claude")).toBe(false);
  expect(bakedAgentStale(undefined, null, "claude")).toBe(false);    // an old row without an agent = claude
});

test.skipIf(!hasDocker)("reopen after a live agent switch: baked DEVD_AGENT ≠ DB → recreate on the profile from the DB", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };

  await mgr.open({ ...t, agent: "codex" });   // baked DEVD_AGENT=codex
  // A live agent switch writes the DB + repo memory, the container stays (in-place pane restart).
  setSessionAgent(d.db, APP_ID, "claude");
  setRepoAgent(d.db, "acme", PROJECT, "app", "claude", Date.now());

  await mgr.stop(APP_ID);
  const reopened = await mgr.open(t);         // without an explicit choice (remembered = claude)
  expect(reopened.session.agent).toBe("claude");
  const env = sh(process.cwd(), "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", APP_ID).stdout;
  expect(env).toContain("DEVD_AGENT=claude"); // recreate — docker start by nechal codex

  await mgr.end(APP_ID);
}, 300_000);

test.skipIf(!hasDocker)("open with an agent: stores the row, env and memory; switching the agent recreates the container", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };

  const codex = await mgr.open({ ...t, agent: "codex" });
  expect(codex.session.agent).toBe("codex");
  expect(getRepoAgent(d.db, "acme", PROJECT, "app")).toBe("codex");
  const env1 = sh(process.cwd(), "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", APP_ID).stdout;
  expect(env1).toContain("DEVD_AGENT=codex");

  // Without an explicit choice the remembered codex is used (session running → just attach).
  const again = await mgr.open(t);
  expect(again.session.agent).toBe("codex");

  await mgr.stop(APP_ID);
  const switched = await mgr.open({ ...t, agent: "claude" });
  expect(switched.session.agent).toBe("claude");
  const env2 = sh(process.cwd(), "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", APP_ID).stdout;
  expect(env2).toContain("DEVD_AGENT=claude");

  await mgr.end(APP_ID);
}, 300_000);

test.skipIf(!hasDocker)("open logs agent-switch (not recreate) even when the container was missing and the agent changed at the same time", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };

  await mgr.open({ ...t, agent: "codex" });
  sh(process.cwd(), "docker", "rm", "-f", APP_ID); // the container disappears outside devd → state "missing"

  // state === "missing" AND AT THE SAME TIME switching === true: previously nothing was logged at this intersection
  // (agent-switch was gated on state !== "missing", recreate on !switching).
  const switched = await mgr.open({ ...t, agent: "claude" });
  expect(switched.session.agent).toBe("claude");

  const events = listEvents(d.db, { session: APP_ID });
  const switchEvents = events.filter((e) => e.type === "agent-switch");
  expect(switchEvents).toHaveLength(1);
  expect(JSON.parse(switchEvents[0].data!)).toEqual({ from: "codex", to: "claude" });
  expect(events.some((e) => e.type === "recreate")).toBe(false); // agent-switch replaced recreate, not both

  await mgr.end(APP_ID);
}, 300_000);

test.skipIf(!hasDocker)("openSolo remembers the agent under the claudeSolo repo", async () => {
  const d = makeDeps();
  const mgr = new SessionManager(d);
  const r = await mgr.openSolo("acme", PROJECT, "codex");
  expect(r.session.agent).toBe("codex");
  expect(getRepoAgent(d.db, "acme", PROJECT, "claudeSolo")).toBe("codex");
  await mgr.end(r.session.id);
}, 300_000);

// The proxy key reaches the container only via `docker run -e`. Because EVERY devd restart
// locks the vault, this was a common (not an edge) path: the container was created with an empty
// key, agent-launch fell into zsh with the message "unlock the vault and open the session again",
// but reopening a running session was a mere attach and reopening a stopped one `docker start` — both
// with the same empty key. The user only got out of the loop by switching profiles.
function inspectEnv(id: string): Record<string, string> {
  const raw = sh(process.cwd(), "docker", "inspect", "-f", "{{json .Config.Env}}", id).stdout.trim();
  return Object.fromEntries((JSON.parse(raw) as string[]).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
}
const containerId = (id: string) => sh(process.cwd(), "docker", "inspect", "-f", "{{.Id}}", id).stdout.trim();

test.skipIf(!hasDocker)("proxy profile: an unlocked vault propagates into an existing container", async () => {
  const d = makeDeps();
  d.cfg.settings.proxyModels = { gpt: "gpt-5.6-sol" };
  let key: string | null = null;                       // locked vault
  const mgr = new SessionManager({ ...d, cliproxyKey: () => key });
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };

  await mgr.open({ ...t, agent: "claude-gpt" as const });
  expect(inspectEnv(APP_ID).DEVD_CLIPROXY_KEY).toBe("");
  const born = containerId(APP_ID);

  // 1) A reopen with a LOCKED vault must not tear anything down — an empty key is not newer.
  await mgr.open(t);
  expect(containerId(APP_ID)).toBe(born);

  // 2) Unlocked vault + reopen of a RUNNING session: the container is rebuilt and the key arrives.
  //    This is the loop — a reopen of a running session used to go straight to attach.
  key = "k-after-unlock";
  await mgr.open(t);
  expect(containerId(APP_ID)).not.toBe(born);
  expect(inspectEnv(APP_ID).DEVD_CLIPROXY_KEY).toBe("k-after-unlock");
  expect(inspectEnv(APP_ID).DEVD_AGENT_MODEL).toBe("gpt-5.6-sol");
  const withKey = containerId(APP_ID);

  // 3) Without a config change the container is not rebuilt (no needless recreates).
  await mgr.open(t);
  expect(containerId(APP_ID)).toBe(withKey);

  // 4) Key rotation under a RUNNING agent waits — recreate must not take away a turn in progress.
  key = "k-rotated";
  await mgr.open(t);
  expect(containerId(APP_ID)).toBe(withKey);

  // 5) …but a stopped session picks it up on reopen (there is nothing left to lose).
  await mgr.stop(APP_ID);
  await mgr.open(t);
  expect(inspectEnv(APP_ID).DEVD_CLIPROXY_KEY).toBe("k-rotated");
  const recreates = listEvents(d.db, { session: APP_ID }).filter((e) => e.type === "recreate");
  expect(recreates.some((e) => JSON.parse(e.data ?? "{}").reason === "proxy-env")).toBe(true);

  await mgr.end(APP_ID);
}, 300_000);

test.skipIf(!hasDocker)("a native profile is never rebuilt because of the proxy key", async () => {
  const d = makeDeps();
  const mgr = new SessionManager({ ...d, cliproxyKey: () => "k" });
  const t = { folder: "acme", project: PROJECT, repo: "app", cloneUrl: d.bareUrl };
  await mgr.open({ ...t, agent: "claude" as const });
  const born = containerId(APP_ID);
  await mgr.open(t);
  await mgr.stop(APP_ID);
  await mgr.open(t);
  expect(containerId(APP_ID)).toBe(born);
  await mgr.end(APP_ID);
}, 300_000);
