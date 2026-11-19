import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub, type NotifyExtra } from "../src/agentEvents";
import { chatAttention, tmuxAttention } from "../src/attention";
import { ChatHub } from "../src/chatHub";
import { getSession, getSessionAttention, getSessionPr, insertSession, listSessions, openDb, type SessionRow } from "../src/db";
import { EventBus } from "../src/eventBus";
import { sh } from "../src/git";
import { checkPrs, PrWatch, type PrState } from "../src/prWatch";
import { hubShelfDeps } from "../src/sessionAttention";
import { Inbox } from "../src/sessionInbox";
import { ThreadStore } from "../src/threadStore";
import type { BridgeEvent, RunRow, ThreadSnapshot } from "../../shared/thread";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

// ---------------------------------------------------------------- checkPrs (provider reads)

/** A session worktree with branch `feat` pushed to a local origin, then origin rewritten to `remoteUrl`
 *  (the remote-tracking ref stays, so the branch counts as pushed). */
async function repo(remoteUrl: string, opts: { push?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "devd-prwatch-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", origin);
  const work = join(root, "work");
  await sh(root, "git", "clone", "-q", origin, work);
  await sh(work, "git", "config", "user.email", "t@t"); await sh(work, "git", "config", "user.name", "Tester");
  writeFileSync(join(work, "f.txt"), "base\n");
  await sh(work, "git", "add", "."); await sh(work, "git", "commit", "-q", "-m", "base");
  await sh(work, "git", "push", "-q", "-u", "origin", "main");
  await sh(work, "git", "remote", "set-head", "origin", "main");
  await sh(work, "git", "checkout", "-q", "-b", "feat");
  writeFileSync(join(work, "g.txt"), "feat\n");
  await sh(work, "git", "add", "."); await sh(work, "git", "commit", "-q", "-m", "feat");
  if (opts.push !== false) await sh(work, "git", "push", "-q", "origin", "feat");
  await sh(work, "git", "remote", "set-url", "origin", remoteUrl);
  return { root, work };
}

const ROW: SessionRow = {
  id: "dev-a-web", folder: "acme", project: "a", repo: "web", container: "dev-a-web",
  port_base: 40100, status: "running", solo: 0, created_at: 0, last_active_at: 0, important: 0, agent: "claude", runtime: "chat",
};

type GhCall = string[];
function fakeGh(out: unknown) {
  const calls: GhCall[] = [];
  return {
    calls,
    run: async (_cwd: string, ...cmd: string[]) => { calls.push(cmd); return { code: 0, stdout: JSON.stringify(out), stderr: "" }; },
  };
}
const noFetch = async (): Promise<Response> => { throw new Error("no fetch expected"); };

test("GitHub: gh pr list by head branch; a pending check run makes the checks pending", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const gh = fakeGh([{
    number: 7, url: "https://github.com/o/n/pull/7", state: "OPEN", mergedAt: null,
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
    ],
  }]);
  const s = { ...ROW, worktree: work, branch: "feat" };
  const prs = await checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (id, e) => { throw e; } });
  expect(prs).toEqual([{ sessionId: s.id, number: 7, url: "https://github.com/o/n/pull/7", state: "open", checks: "pending" }]);
  expect(gh.calls).toEqual([["gh", "pr", "list", "--repo", "o/n", "--head", "feat", "--state", "all", "--limit", "1", "--json", "number,url,state,mergedAt,statusCheckRollup"]]);
});

test("GitHub: rollup success / failure / none, merged and closed states", async () => {
  const { root, work } = await repo("git@github.com:o/n.git");
  const s = { ...ROW, worktree: work, branch: "feat" };
  const one = async (pr: Record<string, unknown>) => {
    const gh = fakeGh([{ number: 3, url: "u", state: "OPEN", mergedAt: null, statusCheckRollup: [], ...pr }]);
    const r = await checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; } });
    return r[0];
  };
  expect((await one({ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }] })).checks).toBe("success");
  expect((await one({ statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] })).checks).toBe("failure");
  expect((await one({ statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] })).checks).toBe("pending");
  expect((await one({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] })).checks).toBe("failure");
  expect((await one({ statusCheckRollup: [] })).checks).toBe("none");
  expect(await one({ state: "MERGED", mergedAt: "2026-11-18T10:00:00Z" })).toMatchObject({ state: "merged" });
  expect(await one({ state: "CLOSED" })).toMatchObject({ state: "closed" });
});

test("GitHub: an unknown check conclusion is an error, not a guess", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const s = { ...ROW, worktree: work, branch: "feat" };
  const gh = fakeGh([{ number: 3, url: "u", state: "OPEN", mergedAt: null, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "WEIRD" }] }]);
  const errors: string[] = [];
  const prs = await checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (id, e) => errors.push(`${id}: ${e.message}`) });
  expect(prs).toEqual([]);
  expect(errors).toEqual([expect.stringContaining("WEIRD")]);
});

test("only sessions with a pushed branch are polled; no PR yet means no state", async () => {
  const unpushed = await repo("https://github.com/o/n.git", { push: false });
  const pushed = await repo("https://github.com/o/m.git");
  const gh = fakeGh([]);
  const prs = await checkPrs({
    sessions: [
      { ...ROW, id: "dev-unpushed", worktree: unpushed.work, branch: "feat" },
      { ...ROW, id: "dev-nobranch", worktree: pushed.work, branch: null },
      { ...ROW, id: "dev-default", worktree: pushed.work, branch: "main" },
      { ...ROW, id: "dev-pushed", worktree: pushed.work, branch: "feat" },
    ],
    root: pushed.root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; },
  });
  expect(prs).toEqual([]);
  expect(gh.calls.map((c) => c[4])).toEqual(["o/m"]);
});

test("Gitea: PR by head branch through the API with the instance token, combined commit status", async () => {
  const { root, work } = await repo("ssh://git@gitea.test:2222/o/n.git");
  const urls: string[] = [];
  const auth: (string | null)[] = [];
  let status = "pending";
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(url);
    auth.push(new Headers(init?.headers).get("authorization"));
    if (url.includes("/pulls?")) {
      return Response.json([
        { number: 4, html_url: "http://gitea.test:3000/o/n/pulls/4", state: "open", merged: false, head: { ref: "other", sha: "x" } },
        { number: 5, html_url: "http://gitea.test:3000/o/n/pulls/5", state: "open", merged: false, head: { ref: "feat", sha: "abc" } },
      ]);
    }
    return Response.json({ state: status, total_count: 2 });
  };
  const s = { ...ROW, worktree: work, branch: "feat" };
  const run = () => checkPrs({ sessions: [s], root, gh: async () => { throw new Error("no gh for gitea"); }, fetcher, giteaUrls: ["http://gitea.test:3000"], giteaToken: (host) => (host === "gitea.test:2222" ? "tok" : undefined), onError: (_id, e) => { throw e; } });
  expect(await run()).toEqual([{ sessionId: s.id, number: 5, url: "http://gitea.test:3000/o/n/pulls/5", state: "open", checks: "pending" }]);
  expect(urls).toEqual(["http://gitea.test:3000/api/v1/repos/o/n/pulls?state=all&sort=recentupdate&limit=50", "http://gitea.test:3000/api/v1/repos/o/n/commits/abc/status"]);
  expect(auth).toEqual(["token tok", "token tok"]);
  status = "failure";
  expect((await run())[0].checks).toBe("failure");
  status = "error";
  expect((await run())[0].checks).toBe("failure");
  status = "success";
  expect((await run())[0].checks).toBe("success");
});

test("Gitea: merged and closed PRs; no statuses = none; a missing token is an error", async () => {
  const { root, work } = await repo("http://gitea.test:3000/o/n.git");
  let pr: Record<string, unknown> = { number: 9, html_url: "h", state: "closed", merged: true, head: { ref: "feat", sha: "abc" } };
  const fetcher = async (url: string) => (url.includes("/pulls?") ? Response.json([pr]) : Response.json({ state: "", total_count: 0 }));
  const s = { ...ROW, worktree: work, branch: "feat" };
  const errors: string[] = [];
  const run = (token: string | undefined) => checkPrs({ sessions: [s], root, gh: async () => { throw new Error("no gh"); }, fetcher, giteaUrls: ["http://gitea.test:3000"], giteaToken: () => token, onError: (_id, e) => errors.push(e.message) });
  expect((await run("tok"))[0]).toMatchObject({ state: "merged", checks: "none" });
  pr = { ...pr, merged: false };
  expect((await run("tok"))[0]).toMatchObject({ state: "closed" });
  pr = { ...pr, state: "open" };
  expect((await run("tok"))[0]).toMatchObject({ state: "open", checks: "none" });
  expect(await run(undefined)).toEqual([]);
  expect(errors).toEqual([expect.stringContaining("token")]);
});

// ---------------------------------------------------------------- attention

const snap = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({ lastSeq: 2, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null, ...over });
const endedRun: RunRow = {
  runId: "r1", origin: "user", status: "completed", harness: null, nativeThreadId: null, model: null,
  queuedAt: 1, startedAt: 1, endedAt: 1000, endedSeq: 2, usage: null, error: null,
};

test("attention: pending checks are working pr-checks; a failure after the last run is needs_you ci-failed", () => {
  const link = { status: "connected" as const, since: 1 };
  const t = snap({ runs: [endedRun] });
  expect(chatAttention(t, link, 50_000, { checks: "pending", since: 2000 })).toEqual({ section: "working", reason: "pr-checks", since: 2000 });
  expect(chatAttention(t, null, 50_000, { checks: "pending", since: 2000 })).toEqual({ section: "working", reason: "pr-checks", since: 2000 });
  expect(chatAttention(t, link, 50_000, { checks: "failure", since: 3000 })).toEqual({ section: "needs_you", reason: "ci-failed", since: 3000 });
  // A run that ended after the failure was seen supersedes it.
  expect(chatAttention(t, link, 50_000, { checks: "failure", since: 500 })).toEqual({ section: "needs_you", reason: "completed", since: 1000 });
  const done = { status: "done" as const, body: "", reason: null, startedAt: 1, updatedAt: 1000, statusSince: 1000 };
  expect(tmuxAttention(done, { checks: "pending", since: 2000 })).toEqual({ section: "working", reason: "pr-checks", since: 2000 });
  expect(tmuxAttention(done, { checks: "failure", since: 2000 })).toEqual({ section: "needs_you", reason: "ci-failed", since: 2000 });
  expect(tmuxAttention({ ...done, status: "working" }, { checks: "pending", since: 2000 })).toEqual({ section: "working", reason: "running", since: 1000 });
  expect(tmuxAttention(null, { checks: "pending", since: 2000 })).toEqual({ section: "working", reason: "pr-checks", since: 2000 });
});

// ---------------------------------------------------------------- PrWatch

const CHAT: SessionRow = { ...ROW, id: "dev-a-chat", container: "dev-a-chat", branch: "feat-chat" };
const TMUX: SessionRow = { ...ROW, id: "dev-a-tmux", container: "dev-a-tmux", repo: "tmux", port_base: 40200, runtime: "tmux", branch: "feat-tmux" };
const QUIET = 1000;
const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });

/** Hub, ChatHub, inbox and PR watch over one clock, wired like index.ts; the provider answers come from `prs`. */
function setup(dbPath = ":memory:") {
  let now = 1_000_000;
  const db = openDb(dbPath);
  const dir = mkdtempSync(join(tmpdir(), "prwatch-"));
  const stores = new Map<string, ThreadStore>();
  cleanups.push(() => { for (const s of stores.values()) s.close(); rmSync(dir, { recursive: true, force: true }); });
  const threads = (id: string) => {
    let s = stores.get(id);
    if (!s) { s = ThreadStore.open(dir, id); stores.set(id, s); }
    return s;
  };
  const notified: { title: string; message: string; extra?: NotifyExtra }[] = [];
  const logs: string[] = [];
  let inbox: Inbox;
  let watch: PrWatch;
  const hub = new AgentEventHub({
    db, notify: (title, message, extra) => notified.push({ title, message, extra }), now: () => now, quietMs: QUIET,
    ...hubShelfDeps({ activity: (id, k) => inbox.activity(id, k), snoozed: (id) => inbox.snoozed(id) }, (m) => logs.push(m)),
  });
  const chatHub = new ChatHub({
    hub, session: (id) => getSession(db, id), now: () => now, log: (m) => logs.push(m),
    pr: { pending: (id) => watch.pending(id), check: (id) => watch.checkNow(id) },
  });
  inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: (id) => hub.liveSnapshot(id), bus: new EventBus(),
    prHold: (id) => watch.hold(id), now: () => now, coalesceMs: 0,
    timers: { set: () => 0, clear: () => {} },
  });
  const prs = new Map<string, PrState>();
  const polled: string[][] = [];
  const snapshot = (id: string) => threads(id).snapshot({ limit: 0 });
  watch = new PrWatch({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id),
    check: async (sessions) => { polled.push(sessions.map((s) => s.id)); return sessions.flatMap((s) => (prs.has(s.id) ? [prs.get(s.id)!] : [])); },
    inbox, checksEnded: (id) => chatHub.prChecksEnded(id, () => snapshot(id)),
    notify: (title, message, extra) => notified.push({ title, message, extra }),
    now: () => now, log: (m) => logs.push(m),
  });
  const feed = async (id: string, events: BridgeEvent[]) => {
    const s = threads(id);
    for (const event of events) {
      const e = { seq: s.lastSeq() + 1, ts: now, event };
      s.apply(e);
      chatHub.onEvent(id, e, () => snapshot(id));
    }
    await Bun.sleep(0); // the completion's PR check
    await Bun.sleep(0);
  };
  if (!getSession(db, CHAT.id)) insertSession(db, CHAT);
  if (!getSession(db, TMUX.id)) insertSession(db, TMUX);
  const pr = (id: string, state: PrState["state"], checks: PrState["checks"], number = 7) =>
    prs.set(id, { sessionId: id, number, url: `https://github.com/o/n/pull/${number}`, state, checks });
  const attention = (id: string) => inbox.item(getSession(db, id)!).attention;
  const sweep = () => { now += QUIET; hub.sweep(); };
  return { db, hub, chatHub, inbox, watch, feed, pr, prs, polled, notified, logs, attention, sweep, tick: (ms: number) => { now += ms; } };
}

test("pending checks hold a chat thread in working: no done until CI finishes, then done", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  expect(t.attention(CHAT.id)).toMatchObject({ section: "working", reason: "pr-checks" });
  t.sweep();
  t.sweep();
  expect(t.notified).toEqual([]);
  t.pr(CHAT.id, "open", "success");
  await t.watch.tick();
  t.sweep();
  expect(t.notified.map((n) => n.message)).toEqual(["Claude finished working"]);
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "completed" });
});

test("pending checks hold a tmux session in working", async () => {
  const t = setup();
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit");
  t.hub.handle(getSession(t.db, TMUX.id)!, "stop");
  t.sweep();
  expect(t.attention(TMUX.id)).toMatchObject({ section: "needs_you", reason: "completed" });
  t.pr(TMUX.id, "open", "pending");
  await t.watch.tick();
  expect(t.attention(TMUX.id)).toMatchObject({ section: "working", reason: "pr-checks" });
});

test("a CI failure puts the session in needs_you ci-failed, notifies once and wakes a snooze", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.inbox.snooze(CHAT.id, 10 ** 13, "time");
  t.tick(5000);
  t.pr(CHAT.id, "open", "failure");
  await t.watch.tick();
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "ci-failed" });
  expect(getSessionAttention(t.db, CHAT.id)?.snooze_until).toBeNull();
  const ci = t.notified.filter((n) => n.message.includes("CI failed"));
  expect(ci).toEqual([{ title: "a/web", message: "CI failed on PR #7", extra: expect.objectContaining({ sound: true, session: expect.objectContaining({ id: CHAT.id }) }) }]);
  await t.watch.tick();
  expect(t.notified.filter((n) => n.message.includes("CI failed"))).toHaveLength(1);
  // The held completion is released once CI is over.
  t.sweep();
  expect(t.notified.map((n) => n.message)).toContain("Claude finished working");
});

test("merged settles the thread and stops polling that PR", async () => {
  const t = setup();
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(10_000); // past the grace a just-ended run still counts as working
  t.pr(CHAT.id, "open", "success");
  t.pr(TMUX.id, "open", "success");
  await t.watch.tick();
  t.pr(CHAT.id, "merged", "none");
  await t.watch.tick();
  expect(t.attention(CHAT.id).section).toBe("settled");
  expect(getSessionAttention(t.db, CHAT.id)?.settled_reason).toBe("merged");
  await t.watch.tick();
  expect(t.polled.at(-1)).toEqual([TMUX.id]);
});

test("merge during an active run settles after it", async () => {
  const t = setup();
  await t.feed(CHAT.id, [started("r1")]);
  t.pr(CHAT.id, "merged", "none");
  await t.watch.tick();
  expect(t.attention(CHAT.id)).toMatchObject({ section: "working", reason: "running" });
  await t.feed(CHAT.id, [completed("r1")]);
  t.tick(10_000);
  await t.watch.tick();
  expect(t.attention(CHAT.id).section).toBe("settled");
  // tmux: the hub's run
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit");
  t.pr(TMUX.id, "merged", "none");
  await t.watch.tick();
  expect(t.attention(TMUX.id).section).toBe("working");
  t.hub.handle(getSession(t.db, TMUX.id)!, "stop");
  t.sweep();
  await t.watch.tick();
  expect(t.attention(TMUX.id).section).toBe("settled");
});

test("after a devd restart: no second failure notification, a merge the user unsettled stays unsettled, pending still holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prwatch-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "devd.db");
  const a = setup(path);
  a.pr(CHAT.id, "merged", "none");
  a.pr(TMUX.id, "open", "failure");
  await a.watch.tick();
  expect(a.attention(CHAT.id).section).toBe("settled");
  a.inbox.unsettle(CHAT.id);
  expect(getSessionPr(a.db, TMUX.id)).toMatchObject({ number: 7, state: "open", checks: "failure" });

  const b = setup(path);
  b.pr(TMUX.id, "open", "failure");
  await b.watch.tick();
  expect(b.attention(CHAT.id).section).not.toBe("settled");
  expect(b.notified.filter((n) => n.message.includes("CI failed"))).toEqual([]);
  expect(b.polled.at(-1)).toEqual([TMUX.id]);
  b.pr(TMUX.id, "open", "pending");
  await b.watch.tick();
  const c = setup(path);
  expect(c.attention(TMUX.id)).toMatchObject({ section: "working", reason: "pr-checks" });
});

test("a session the PR watch cannot read keeps its last state; the error is logged once", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.watch.tick();
  const failing = new PrWatch({
    db: t.db, sessions: () => listSessions(t.db), session: (id) => getSession(t.db, id),
    check: async (sessions, onError) => { for (const s of sessions) onError(s.id, new Error("gh: HTTP 502")); return []; },
    inbox: t.inbox, checksEnded: () => {}, notify: () => {}, log: (m) => t.logs.push(m),
  });
  await failing.tick();
  await failing.tick();
  expect(failing.pending(CHAT.id)).toBe(true);
  expect(t.logs.filter((l) => l.includes("HTTP 502"))).toHaveLength(2); // once per session
});
