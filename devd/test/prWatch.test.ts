import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEventHub, PR_HOLD_MAX_MS, type NotifyExtra } from "../src/agentEvents";
import { chatAttention, tmuxAttention } from "../src/attention";
import { ChatHub } from "../src/chatHub";
import { getSession, getSessionAttention, getSessionPr, insertSession, listNotifyLog, listSessions, openDb, type SessionRow } from "../src/db";
import { EventBus } from "../src/eventBus";
import { sh } from "../src/git";
import { checkPrs, PR_CHECKS_GRACE_MS, PR_SETTLED_POLL_MS, PrWatch, type PrPoll, type PrState } from "../src/prWatch";
import { findPr } from "../src/unpushed";
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
/** The PRs found by a poll (sessions without one left out). */
const found = async (p: Promise<PrPoll[]>) => (await p).flatMap((x) => (x.pr ? [x.pr] : []));

test("GitHub: gh pr list by head branch; a pending check run makes the checks pending", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const gh = fakeGh([{
    number: 7, url: "https://github.com/o/n/pull/7", state: "OPEN", mergedAt: null, headRefOid: "sha1",
    statusCheckRollup: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
    ],
  }]);
  const s = { ...ROW, worktree: work, branch: "feat" };
  const prs = await found(checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (id, e) => { throw e; } }));
  expect(prs).toEqual([{ sessionId: s.id, number: 7, url: "https://github.com/o/n/pull/7", state: "open", checks: "pending", headSha: "sha1" }]);
  expect(gh.calls).toEqual([["gh", "pr", "list", "--repo", "o/n", "--head", "feat", "--state", "all", "--limit", "1", "--json", "number,url,state,mergedAt,statusCheckRollup,headRefOid"]]);
});

test("GitHub: rollup success / failure / none, merged and closed states", async () => {
  const { root, work } = await repo("git@github.com:o/n.git");
  const s = { ...ROW, worktree: work, branch: "feat" };
  const one = async (pr: Record<string, unknown>) => {
    const gh = fakeGh([{ number: 3, url: "u", state: "OPEN", mergedAt: null, headRefOid: "sha1", statusCheckRollup: [], ...pr }]);
    const r = await found(checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; } }));
    return r[0];
  };
  expect((await one({ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }] })).checks).toBe("success");
  expect((await one({ statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] })).checks).toBe("failure");
  expect((await one({ statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] })).checks).toBe("pending");
  expect((await one({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] })).checks).toBe("failure");
  expect((await one({ statusCheckRollup: [] })).checks).toBe("none");
  expect((await one({ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "STALE" }] })).checks).toBe("success");
  expect(await one({ state: "MERGED", mergedAt: "2026-11-18T10:00:00Z" })).toMatchObject({ state: "merged" });
  expect(await one({ state: "CLOSED" })).toMatchObject({ state: "closed" });
});

test("GitHub: an unknown check conclusion is an error, not a guess", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const s = { ...ROW, worktree: work, branch: "feat" };
  const gh = fakeGh([{ number: 3, url: "u", state: "OPEN", mergedAt: null, headRefOid: "sha1", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "WEIRD" }] }]);
  const errors: string[] = [];
  const prs = await found(checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (id, e) => errors.push(`${id}: ${e.message}`) }));
  expect(prs).toEqual([]);
  expect(errors).toEqual([expect.stringContaining("WEIRD")]);
});

test("only a pushed, non-default current branch is asked about; the registered branch does not matter (S5-R29)", async () => {
  const unpushed = await repo("https://github.com/o/n.git", { push: false });
  const onMain = await repo("https://github.com/o/k.git");
  await sh(onMain.work, "git", "checkout", "-q", "main");
  const pushed = await repo("https://github.com/o/m.git");
  const gh = fakeGh([]);
  const polls = await checkPrs({
    sessions: [
      { ...ROW, id: "dev-unpushed", worktree: unpushed.work, branch: "feat" },
      { ...ROW, id: "dev-default", worktree: onMain.work, branch: "feat" },
      { ...ROW, id: "dev-pushed", worktree: pushed.work, branch: "main" },
    ],
    root: pushed.root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; },
  });
  expect(polls.map((x) => [x.sessionId, x.branch, x.head === null, x.pr])).toEqual([
    ["dev-unpushed", "feat", true, null], ["dev-default", "main", false, null], ["dev-pushed", "feat", false, null],
  ]);
  expect(gh.calls.map((c) => [c[4], c[6]])).toEqual([["o/m", "feat"]]);
});

test("a repo whose remote is not named origin is reported, not skipped silently", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  await sh(work, "git", "remote", "rename", "origin", "upstream");
  const errors: string[] = [];
  const gh = fakeGh([]);
  const polls = await checkPrs({ sessions: [{ ...ROW, worktree: work, branch: "feat" }], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => errors.push(e.message) });
  expect(polls).toEqual([]);
  expect(errors).toEqual([expect.stringContaining("origin")]);
  expect(gh.calls).toEqual([]);
});

test("`want` sees the remote branch head and can skip the provider call", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const head = (await sh(work, "git", "rev-parse", "refs/remotes/origin/feat")).stdout.trim();
  const gh = fakeGh([]);
  const seen: string[] = [];
  const polls = await checkPrs({ sessions: [{ ...ROW, worktree: work, branch: "feat" }], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; }, want: (_id, h) => { seen.push(h); return false; } });
  expect(seen).toEqual([head]);
  expect(polls).toEqual([]);
  expect(gh.calls).toEqual([]);
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
  const run = () => found(checkPrs({ sessions: [s], root, gh: async () => { throw new Error("no gh for gitea"); }, fetcher, giteaUrls: ["http://gitea.test:3000"], giteaToken: (host) => (host === "gitea.test:2222" ? "tok" : undefined), onError: (_id, e) => { throw e; } }));
  expect(await run()).toEqual([{ sessionId: s.id, number: 5, url: "http://gitea.test:3000/o/n/pulls/5", state: "open", checks: "pending", headSha: "abc" }]);
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
  const run = (token: string | undefined) => found(checkPrs({ sessions: [s], root, gh: async () => { throw new Error("no gh"); }, fetcher, giteaUrls: ["http://gitea.test:3000"], giteaToken: () => token, onError: (_id, e) => errors.push(e.message) }));
  expect((await run("tok"))[0]).toMatchObject({ state: "merged", checks: "none" });
  pr = { ...pr, merged: false };
  expect((await run("tok"))[0]).toMatchObject({ state: "closed" });
  pr = { ...pr, state: "open" };
  expect((await run("tok"))[0]).toMatchObject({ state: "open", checks: "none" });
  expect(await run(undefined)).toEqual([]);
  expect(errors).toEqual([expect.stringContaining("token")]);
});

// ---------------------------------------------------------------- attention

const snap = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({ lastSeq: 2, seenSeq: 0, runs: [], items: [], pending: [], background: [], native: null, effort: null, ...over });
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
const MIN = 60_000;
const started = (runId: string): BridgeEvent => ({ type: "run.started", runId, origin: "user", nativeThreadId: null, model: null });
const completed = (runId: string): BridgeEvent => ({ type: "run.completed", runId, nativeThreadId: "n", usage: null, costUsd: null });

/** Hub, ChatHub, inbox and PR watch over one clock, wired like index.ts. The provider answers come from `prs`
 *  (per session), remote heads from `heads` (default "h1"), errors from `errors`. `seed: true` keeps the first-deploy
 *  seed pending (a fresh DB has it); otherwise the seed counts as done. */
function setup(opts: { dbPath?: string; seed?: boolean; dir?: string; now?: number; prCheck?: (id: string) => Promise<unknown>; prCheckTimeoutMs?: number } = {}) {
  let now = opts.now ?? 1_000_000;
  const db = openDb(opts.dbPath ?? ":memory:");
  if (!opts.seed) db.run("DELETE FROM pr_watch_seed");
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "prwatch-"));
  const stores = new Map<string, ThreadStore>();
  cleanups.push(() => { for (const s of stores.values()) s.close(); if (!opts.dir) rmSync(dir, { recursive: true, force: true }); });
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
    prChecks: (id) => (getSession(db, id)?.runtime === "chat" ? watch.hold(id)?.checks ?? null : null),
    onPrHoldExpired: (id) => watch.holdExpired(id),
  });
  const chatHub = new ChatHub({
    hub, session: (id) => getSession(db, id), now: () => now, log: (m) => logs.push(m),
    prCheck: opts.prCheck ?? ((id) => watch.checkNow(id)), prRow: (id) => getSessionPr(db, id),
    ...(opts.prCheckTimeoutMs !== undefined ? { prCheckTimeoutMs: opts.prCheckTimeoutMs } : {}),
  });
  inbox = new Inbox({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id), threads,
    chatLink: () => ({ status: "connected", since: 1 }), tmuxLive: (id) => hub.liveSnapshot(id), bus: new EventBus(),
    prHold: (id) => watch.hold(id), now: () => now, coalesceMs: 0,
    timers: { set: () => 0, clear: () => {} }, end: async () => {}, worktreeChanges: async () => [],
  });
  const prs = new Map<string, PrState>();
  const heads = new Map<string, string | null>();
  const errors = new Map<string, string>();
  const polled: string[] = [];
  const snapshot = (id: string) => threads(id).snapshot({ limit: 0 });
  watch = new PrWatch({
    db, sessions: () => listSessions(db), session: (id) => getSession(db, id),
    check: async (sessions, onError, want) => {
      const out: PrPoll[] = [];
      for (const s of sessions) {
        if (errors.has(s.id)) { onError(s.id, new Error(errors.get(s.id))); continue; }
        const head = heads.has(s.id) ? heads.get(s.id)! : "h1";
        if (head !== null && want && !want(s.id, head)) continue;
        polled.push(s.id);
        const pr = prs.get(s.id);
        // The PR's head commit: as set by the test, else the branch's pushed head.
        out.push({ sessionId: s.id, branch: s.branch ?? null, head, pr: pr ? { ...pr, headSha: pr.headSha ?? head } : null });
      }
      return out;
    },
    inbox, notify: (title, message, extra) => notified.push({ title, message, extra }),
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
  hub.loadPersisted(listSessions(db)); // as index.ts at startup
  /** The bridge link of a chat session connects (after a devd restart: ChatHub seeds from the store). */
  const connect = (id: string) => {
    chatHub.onStatus(id, "connecting", () => snapshot(id));
    chatHub.onStatus(id, "connected", () => snapshot(id));
  };
  const pr = (id: string, state: PrState["state"], checks: PrState["checks"], number = 7, headSha: string | null = null) =>
    prs.set(id, { sessionId: id, number, url: `https://github.com/o/n/pull/${number}`, state, checks, headSha });
  const attention = (id: string) => inbox.item(getSession(db, id)!).attention;
  const sweep = () => { now += QUIET; hub.sweep(); };
  const messages = () => notified.map((n) => n.message);
  return { db, dir, now: () => now, connect, hub, chatHub, inbox, watch, feed, pr, prs, heads, errors, polled, notified, messages, logs, attention, sweep, tick: (ms: number) => { now += ms; } };
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
  expect(t.messages()).toEqual(["Claude finished working"]);
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "completed" });
});

test("pending checks hold a tmux session in working (its done is not delayed, S5-R19)", async () => {
  const t = setup();
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit");
  t.hub.handle(getSession(t.db, TMUX.id)!, "stop");
  t.sweep();
  expect(t.attention(TMUX.id)).toMatchObject({ section: "needs_you", reason: "completed" });
  t.pr(TMUX.id, "open", "pending");
  await t.watch.tick();
  expect(t.attention(TMUX.id)).toMatchObject({ section: "working", reason: "pr-checks" });
});

test("a CI failure on a held chat run: needs_you ci-failed, exactly one notification, snooze woken", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.inbox.snooze(CHAT.id, 10 ** 13, "time");
  t.tick(5000);
  t.pr(CHAT.id, "open", "failure");
  await t.watch.tick();
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "ci-failed" });
  expect(getSessionAttention(t.db, CHAT.id)?.snooze_until).toBeNull();
  expect(t.notified).toEqual([{ title: "a/web", message: "CI failed on PR #7", extra: expect.objectContaining({ sound: true, session: expect.objectContaining({ id: CHAT.id }) }) }]);
  t.sweep();
  t.sweep();
  await t.watch.tick();
  expect(t.messages()).toEqual(["CI failed on PR #7"]);
  expect(listNotifyLog(t.db, { session: CHAT.id }).filter((r) => r.event === "sweep_done").map((r) => [r.decision, r.reason])).toContainEqual(["suppressed", "ci-failed"]);
});

test("a failure seen without a held run notifies once and a later completion still says finished", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "failure");
  await t.watch.tick();
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  expect(t.messages()).toEqual(["CI failed on PR #7", "Claude finished working"]);
});

test("the hold ends after PR_HOLD_MAX_MS with the normal done notification and a log row", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.tick(PR_HOLD_MAX_MS - 2 * QUIET);
  t.sweep();
  expect(t.notified).toEqual([]);
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
  expect(listNotifyLog(t.db, { session: CHAT.id }).some((r) => r.reason === "pr-hold-deadline")).toBe(true);
});

test("CI pending for 25 min: no stuck signal (turn not in progress, live state not stalled)", async () => {
  const t = setup();
  t.db.run("UPDATE sessions SET important=1 WHERE id=?", [CHAT.id]);
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.tick(25 * MIN);
  t.sweep();
  expect(t.hub.turnInProgress(CHAT.id)).toBe(false);
  expect(t.hub.liveSnapshot(CHAT.id)!.status).not.toBe("stalled");
  expect(t.notified).toEqual([]);
});

test("a pending PR that can no longer be found, or a session no longer watched, releases the hold", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.prs.delete(CHAT.id);
  await t.watch.tick();
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("none");
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);

  t.pr(TMUX.id, "open", "pending");
  t.heads.set(TMUX.id, "h2"); // pushed
  await t.watch.tick();
  expect(t.watch.pending(TMUX.id)).toBe(true);
  t.db.run("UPDATE sessions SET branch=NULL WHERE id=?", [TMUX.id]);
  await t.watch.tick();
  expect(getSessionPr(t.db, TMUX.id)?.checks).toBe("none");
});

test("three consecutive poll errors mark a pending PR unknown and release the hold; errors back off", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.errors.set(CHAT.id, "gh: HTTP 502");
  await t.watch.tick(); // error 1, next try in 2 min
  await t.watch.tick();
  expect(t.logs.filter((l) => l.includes("HTTP 502"))).toHaveLength(1);
  t.tick(2 * MIN);
  await t.watch.tick(); // error 2, next in 4 min
  t.tick(2 * MIN);
  await t.watch.tick(); // backing off: not tried
  expect(t.watch.pending(CHAT.id)).toBe(true);
  t.tick(2 * MIN);
  await t.watch.tick(); // error 3
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("unknown");
  expect(t.watch.pending(CHAT.id)).toBe(false);
  expect(t.logs.some((l) => l.includes("3 times"))).toBe(true);
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
});

test("merged settles the thread and stops polling that PR", async () => {
  const t = setup();
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.tick(10_000); // past the grace a just-ended run still counts as working
  t.pr(CHAT.id, "open", "pending");
  t.heads.set(CHAT.id, "h2"); // pushed
  await t.watch.tick();
  t.pr(CHAT.id, "merged", "none");
  await t.watch.tick();
  expect(t.attention(CHAT.id).section).toBe("settled");
  expect(getSessionAttention(t.db, CHAT.id)?.settled_reason).toBe("merged");
  t.polled.length = 0;
  t.tick(30 * MIN);
  await t.watch.tick();
  expect(t.polled).not.toContain(CHAT.id);
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
  t.hub.handle(getSession(t.db, TMUX.id)!, "user_prompt_submit");
  t.pr(TMUX.id, "merged", "none");
  t.heads.set(TMUX.id, "h2"); // pushed
  await t.watch.tick();
  expect(t.attention(TMUX.id).section).toBe("working");
  t.hub.handle(getSession(t.db, TMUX.id)!, "stop");
  t.sweep();
  await t.watch.tick();
  expect(t.attention(TMUX.id).section).toBe("settled");
});

test("after a closed or merged PR, a run completion polls again and picks up a new PR from the same branch", async () => {
  const t = setup();
  t.pr(CHAT.id, "closed", "none", 7);
  await t.watch.tick();
  t.pr(CHAT.id, "open", "pending", 8);
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ number: 8, state: "open", checks: "pending" });
  t.sweep();
  expect(t.notified).toEqual([]);
});

test("polling scope: pending every tick, settled checks every 10 min, no PR only when the remote head moved", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  t.pr(TMUX.id, "open", "success");
  await t.watch.tick();
  expect(t.polled.sort()).toEqual([CHAT.id, TMUX.id]);
  t.polled.length = 0;
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.polled).toEqual([CHAT.id]);
  t.polled.length = 0;
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  expect(t.polled.sort()).toEqual([CHAT.id, TMUX.id]);

  const u = setup(); // no PRs at all
  await u.watch.tick();
  expect(u.polled.sort()).toEqual([CHAT.id, TMUX.id]);
  u.polled.length = 0;
  u.tick(2 * MIN);
  await u.watch.tick();
  expect(u.polled).toEqual([]);
  u.heads.set(CHAT.id, "h2");
  u.tick(2 * MIN);
  await u.watch.tick();
  expect(u.polled).toEqual([CHAT.id]);
  // A PR opened after the push (no head move) is still found: no row = also every PR_SETTLED_POLL_MS.
  u.polled.length = 0;
  u.tick(PR_SETTLED_POLL_MS);
  await u.watch.tick();
  expect(u.polled.sort()).toEqual([CHAT.id, TMUX.id]);
});

test("polls of one session are serialized: an older result never overwrites a newer one", async () => {
  const t = setup();
  const answers: ((p: PrPoll[]) => void)[] = [];
  const calls: string[] = [];
  const w = new PrWatch({
    db: t.db, sessions: () => [getSession(t.db, CHAT.id)!], session: (id) => getSession(t.db, id),
    check: (sessions) => { calls.push(sessions[0].id); return new Promise((res) => answers.push(res)); },
    inbox: t.inbox, notify: () => {}, log: () => {},
  });
  const pollOf = (checks: PrState["checks"]): PrPoll[] => [{ sessionId: CHAT.id, branch: CHAT.branch!, head: "h1", pr: { sessionId: CHAT.id, number: 7, url: "u", state: "open", checks, headSha: "h1" } }];
  const tick = w.tick();
  const now = w.checkNow(CHAT.id);
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  answers[0](pollOf("pending"));
  await Bun.sleep(0);
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  answers[1](pollOf("success"));
  await Promise.all([tick, now]);
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("success");
});

test("first deploy: the seed pass records current PRs without notifying or settling; later failures notify", async () => {
  const t = setup({ seed: true });
  t.pr(CHAT.id, "merged", "none");
  t.pr(TMUX.id, "open", "failure");
  await t.watch.tick();
  expect(t.notified).toEqual([]);
  expect(t.attention(CHAT.id).section).not.toBe("settled");
  expect(getSessionPr(t.db, TMUX.id)).toMatchObject({ state: "open", checks: "failure" });
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  expect(t.attention(CHAT.id).section).not.toBe("settled");
  expect(t.notified).toEqual([]);
  t.pr(TMUX.id, "open", "pending");
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  t.pr(TMUX.id, "open", "failure");
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.messages()).toEqual(["CI failed on PR #7"]);
});

test("after a devd restart: no second failure notification, a merge the user unsettled stays unsettled, pending still holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prwatch-db-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "devd.db");
  const a = setup({ dbPath });
  a.pr(CHAT.id, "merged", "none");
  a.pr(TMUX.id, "open", "failure");
  await a.watch.tick();
  expect(a.attention(CHAT.id).section).toBe("settled");
  a.inbox.unsettle(CHAT.id);

  const b = setup({ dbPath });
  b.pr(CHAT.id, "merged", "none");
  b.pr(TMUX.id, "open", "failure");
  await b.watch.tick();
  expect(b.attention(CHAT.id).section).not.toBe("settled");
  expect(b.notified).toEqual([]);
  b.pr(TMUX.id, "open", "pending");
  b.tick(PR_SETTLED_POLL_MS);
  await b.watch.tick();
  const c = setup({ dbPath });
  expect(c.attention(TMUX.id)).toMatchObject({ section: "working", reason: "pr-checks" });
});

// ---------------------------------------------------------------- fix round 2: restart while held, seed window

/** devd A holds CHAT's "finished" for pending checks, then restarts as devd B over the same DB and thread store. */
async function heldThenRestarted() {
  const dbDir = mkdtempSync(join(tmpdir(), "prwatch-restart-"));
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }));
  const dbPath = join(dbDir, "devd.db");
  const storeDir = join(dbDir, "threads");
  const a = setup({ dbPath, dir: storeDir });
  a.pr(CHAT.id, "open", "pending");
  await a.feed(CHAT.id, [started("r1"), completed("r1")]);
  a.sweep();
  a.sweep();
  expect(a.notified).toEqual([]);
  const b = setup({ dbPath, dir: storeDir, now: a.now() + 60_000 });
  b.pr(CHAT.id, "open", "pending");
  return b;
}

test("a held finished survives a devd restart: CI success → exactly one finished", async () => {
  const b = await heldThenRestarted();
  b.connect(CHAT.id);
  b.sweep();
  b.sweep();
  expect(b.notified).toEqual([]);
  b.pr(CHAT.id, "open", "success");
  await b.watch.tick();
  b.sweep();
  b.sweep();
  expect(b.messages()).toEqual(["Claude finished working"]);
});

test("a held finished survives a devd restart: CI failure → only the CI notification", async () => {
  const b = await heldThenRestarted();
  b.connect(CHAT.id);
  b.sweep();
  b.pr(CHAT.id, "open", "failure");
  await b.watch.tick();
  b.sweep();
  b.sweep();
  expect(b.messages()).toEqual(["CI failed on PR #7"]);
  // The completion was re-sent after the restart and silenced, not just lost.
  expect(listNotifyLog(b.db, { session: CHAT.id }).some((r) => r.event === "sweep_done" && r.reason === "ci-failed")).toBe(true);
});

test("CI that failed while devd was down, before the link reconnects: only the CI notification", async () => {
  const b = await heldThenRestarted();
  b.pr(CHAT.id, "open", "failure");
  await b.watch.tick();
  b.connect(CHAT.id);
  b.sweep();
  b.sweep();
  expect(b.messages()).toEqual(["CI failed on PR #7"]);
  // The completion was re-sent after the restart and silenced, not just lost.
  expect(listNotifyLog(b.db, { session: CHAT.id }).some((r) => r.event === "sweep_done" && r.reason === "ci-failed")).toBe(true);
});

test("a completion notified before the restart is not completed again", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "prwatch-restart-"));
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }));
  const dbPath = join(dbDir, "devd.db");
  const storeDir = join(dbDir, "threads");
  const a = setup({ dbPath, dir: storeDir });
  await a.feed(CHAT.id, [started("r1"), completed("r1")]);
  a.sweep();
  expect(a.messages()).toEqual(["Claude finished working"]);
  const b = setup({ dbPath, dir: storeDir, now: a.now() + 60_000 });
  b.pr(CHAT.id, "open", "success");
  await b.watch.tick(); // a PR row newer than the run's end
  b.connect(CHAT.id);
  b.sweep();
  b.sweep();
  expect(b.notified).toEqual([]);
});

test("seed window: checkNow is not silenced by the seed marker", async () => {
  const t = setup({ seed: true });
  t.pr(CHAT.id, "open", "failure");
  await t.watch.checkNow(CHAT.id);
  expect(t.messages()).toEqual(["CI failed on PR #7"]);
});

test("seed window: a session whose poll failed during the seed tick is seeded on its next successful poll", async () => {
  const t = setup({ seed: true });
  t.pr(TMUX.id, "open", "failure");
  t.errors.set(TMUX.id, "gh: HTTP 502");
  await t.watch.tick();
  t.errors.delete(TMUX.id);
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(getSessionPr(t.db, TMUX.id)).toMatchObject({ checks: "failure" });
  expect(t.notified).toEqual([]);
  t.pr(TMUX.id, "open", "pending");
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  t.pr(TMUX.id, "open", "failure");
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.messages()).toEqual(["CI failed on PR #7"]);
});

test("a held finished already released and notified is not re-armed after a session stop/start", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.pr(CHAT.id, "open", "success");
  await t.watch.tick();
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
  t.tick(PR_SETTLED_POLL_MS);
  t.pr(CHAT.id, "merged", "none"); // a later PR row change, run still unseen
  await t.watch.tick();
  // Session stop/start: the hub forgets the live state, ChatHub drops its state.
  t.hub.retainRunning(new Set());
  t.chatHub.drop(CHAT.id);
  t.connect(CHAT.id);
  t.sweep();
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
});

// ---------------------------------------------------------------- final review fixes

test("a hung Gitea request fails the poll within the timeout", async () => {
  const hung = (_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  });
  const remote = { provider: "gitea" as const, url: "http://gitea.test:3000/o/n.git", host: "gitea.test:3000", owner: "o", name: "n" };
  const t0 = Date.now();
  await expect(findPr({ dir: "/x", branch: "feat", remote, giteaToken: "tok", giteaUrl: "http://gitea.test:3000", fetcher: hung, timeoutMs: 50 }))
    .rejects.toThrow("timed out");
  expect(Date.now() - t0).toBeLessThan(2000);
});

test("a hung PR read at completion does not hold the run: after the timeout the last known state decides (S5-R18)", async () => {
  const t = setup({ prCheck: () => new Promise(() => {}), prCheckTimeoutMs: 20 });
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  expect(t.notified).toEqual([]);
  await Bun.sleep(40);
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
  expect(t.logs.some((l) => l.includes("not read at completion"))).toBe(true);
});

test("a hold that reaches its deadline marks the checks unknown: inbox leaves pr-checks, later runs are not held, 10-min cadence", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "pending");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  t.sweep();
  t.tick(PR_HOLD_MAX_MS);
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("unknown");
  expect(t.attention(CHAT.id).reason).not.toBe("pr-checks");
  await t.watch.tick(); // due: the last poll was at the completion, an hour ago
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("unknown");
  t.polled.length = 0;
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.polled).not.toContain(CHAT.id);
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  expect(t.polled).toContain(CHAT.id);
  expect(getSessionPr(t.db, CHAT.id)?.checks).toBe("unknown"); // the provider still says pending: no new hold
  await t.feed(CHAT.id, [started("r2"), completed("r2")]);
  t.sweep();
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working", "Claude finished working"]);
  // A new push starts a new CI run: pending holds again.
  t.heads.set(CHAT.id, "h2");
  await t.feed(CHAT.id, [started("r3"), completed("r3")]);
  expect(t.watch.pending(CHAT.id)).toBe(true);
});

// ---------------------------------------------------------------- S5-R29: the worktree's current branch

test("S5-R29: a session registered on main whose worktree is on a feature branch is watched by that branch", async () => {
  const t = setup();
  const { root, work } = await repo("https://github.com/o/n.git"); // checked out on `feat`, pushed
  t.db.run("UPDATE sessions SET branch='main', worktree=? WHERE id=?", [work, CHAT.id]);
  let rollup: unknown[] = [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }];
  const heads: string[] = [];
  const gh = async (_cwd: string, ...cmd: string[]) => {
    const head = cmd[cmd.indexOf("--head") + 1];
    heads.push(head);
    const out = head === "feat" ? [{ number: 7, url: "https://github.com/o/n/pull/7", state: "OPEN", mergedAt: null, headRefOid: "sha1", statusCheckRollup: rollup }] : [];
    return { code: 0, stdout: JSON.stringify(out), stderr: "" };
  };
  const w = new PrWatch({
    db: t.db, sessions: () => [getSession(t.db, CHAT.id)!], session: (id) => getSession(t.db, id),
    check: (sessions, onError, want) => checkPrs({ sessions, root, gh, giteaUrls: [], giteaToken: () => undefined, onError, want }),
    inbox: t.inbox, notify: (title, message, extra) => t.notified.push({ title, message, extra }), log: (m) => t.logs.push(m),
  });
  await w.tick();
  expect(heads).toEqual(["feat"]);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ number: 7, checks: "pending", branch: "feat" });
  expect(t.attention(CHAT.id)).toMatchObject({ section: "working", reason: "pr-checks" });

  rollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }];
  await w.tick();
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "ci-failed" });
  expect(t.messages()).toEqual(["CI failed on PR #7"]);

  // A detached HEAD (a rebase in progress) skips the poll: the row stays as it was.
  await sh(work, "git", "checkout", "-q", "--detach");
  await w.checkNow(CHAT.id);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ number: 7, checks: "failure", branch: "feat" });
  await sh(work, "git", "checkout", "-q", "feat");

  // The agent switches to another branch without a PR: the old branch's PR no longer speaks for the session.
  await sh(work, "git", "checkout", "-q", "-b", "other");
  await w.checkNow(CHAT.id);
  expect(getSessionPr(t.db, CHAT.id)).toBeNull();
  expect(t.attention(CHAT.id).reason).not.toBe("ci-failed");
  expect(w.pending(CHAT.id)).toBe(false);
});

test("S5-R29: a session with no registered branch but a worktree is watched; a detached HEAD skips the poll", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  const gh = fakeGh([{ number: 3, url: "u", state: "OPEN", mergedAt: null, headRefOid: "sha1", statusCheckRollup: [] }]);
  const s = { ...ROW, worktree: work, branch: null };
  expect(await found(checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; } })))
    .toMatchObject([{ number: 3 }]);
  await sh(work, "git", "checkout", "-q", "--detach");
  const polls = await checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; } });
  expect(polls).toEqual([]); // skipped: no answer for this poll, nothing changes
  expect(gh.calls).toHaveLength(1);
});

test("S5-R29: a worktree git cannot read is an error for the poll (onError, backoff), not \"no branch\"", async () => {
  const { root } = await repo("https://github.com/o/n.git");
  const errors: string[] = [];
  const polls = await checkPrs({
    sessions: [{ ...ROW, worktree: join(root, "missing"), branch: "feat" }], root, gh: fakeGh([]).run, fetcher: noFetch,
    giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => errors.push(e.message),
  });
  expect(polls).toEqual([]);
  expect(errors).toHaveLength(1);
});

test("S5-R29: a session without its own worktree (shared checkout) keeps watching its registered branch", async () => {
  const { root, work } = await repo("https://github.com/o/n.git");
  await sh(work, "git", "checkout", "-q", "main"); // the shared checkout is elsewhere now
  const gh = fakeGh([]);
  // workspacePath(root, "", "", "work") = <root>/work: the session works in the shared checkout.
  const s = { ...ROW, folder: "", project: "", repo: "work", worktree: null, branch: "feat" };
  const polls = await checkPrs({ sessions: [s], root, gh: gh.run, fetcher: noFetch, giteaUrls: [], giteaToken: () => undefined, onError: (_id, e) => { throw e; } });
  expect(polls.map((x) => x.branch)).toEqual(["feat"]);
  expect(gh.calls.map((c) => c[6])).toEqual(["feat"]);
});

test("S5-R29 deploy: adding the branch column re-arms the seed, so old rows and newly watched sessions notify nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prwatch-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "devd.db");
  // A database from before S5-R29: session_prs without `branch`, the first-deploy seed long done, a failing row.
  const old = openDb(dbPath);
  old.run("ALTER TABLE session_prs DROP COLUMN branch");
  old.run("DELETE FROM pr_watch_seed");
  old.run(`INSERT INTO session_prs (session_id,number,url,state,checks,since,merge_settled_at,updated_at) VALUES (?,7,'u','open','failure',1,NULL,1)`, [CHAT.id]);
  old.close();
  const t = setup({ dbPath, seed: true });
  t.pr(CHAT.id, "open", "failure", 7);
  t.pr(TMUX.id, "open", "failure", 9); // newly watched, already failing
  await t.watch.tick();
  expect(t.notified).toEqual([]);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ checks: "failure", branch: CHAT.branch });
  expect(getSessionPr(t.db, TMUX.id)).toMatchObject({ checks: "failure" });
  // After the seed, a new failure notifies as usual.
  t.pr(TMUX.id, "open", "pending", 9);
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  t.pr(TMUX.id, "open", "failure", 9);
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.messages()).toEqual(["CI failed on PR #9"]);
});

// ---------------------------------------------------------------- Hotfix 2: a new head on the same PR

test("a failure on a new head of the same PR is a new failure: ci-failed after the run, notified again", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "failure");
  await t.watch.tick(); // head h1 failed
  await t.feed(CHAT.id, [started("r1")]);
  t.tick(30_000);
  t.heads.set(CHAT.id, "h2"); // the run pushed a fix; CI fails again on h2
  await t.feed(CHAT.id, [completed("r1")]);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ checks: "failure", head_sha: "h2" });
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "ci-failed" });
  expect(t.messages()).toEqual(["CI failed on PR #7", "CI failed on PR #7"]);
});

test("a new head with no check runs yet, after the PR had checks: pending (held) until its checks report", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "failure");
  await t.watch.tick(); // head h1 failed (notified)
  await t.feed(CHAT.id, [started("r1")]);
  t.tick(30_000);
  t.heads.set(CHAT.id, "h2");
  t.pr(CHAT.id, "open", "none"); // GitHub has not registered h2's check runs yet
  await t.feed(CHAT.id, [completed("r1")]);
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ checks: "pending", head_sha: "h2" });
  expect(t.attention(CHAT.id)).toMatchObject({ section: "working", reason: "pr-checks" });
  t.sweep();
  t.sweep();
  t.tick(MIN);
  await t.watch.tick(); // still none, inside the grace: still pending
  expect(t.watch.pending(CHAT.id)).toBe(true);
  t.pr(CHAT.id, "open", "failure");
  t.tick(MIN);
  await t.watch.tick();
  t.sweep();
  t.sweep();
  expect(t.attention(CHAT.id)).toMatchObject({ section: "needs_you", reason: "ci-failed" });
  expect(t.messages()).toEqual(["CI failed on PR #7", "CI failed on PR #7"]); // no "finished" for the held run
});

test("a new head whose checks never appear is released after PR_CHECKS_GRACE_MS", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "success");
  await t.watch.tick();
  t.heads.set(CHAT.id, "h2");
  t.pr(CHAT.id, "open", "none");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  expect(t.watch.pending(CHAT.id)).toBe(true);
  t.tick(PR_CHECKS_GRACE_MS);
  await t.watch.tick();
  expect(getSessionPr(t.db, CHAT.id)).toMatchObject({ checks: "none", head_sha: "h2" });
  expect(t.logs.some((l) => l.includes("no checks"))).toBe(true);
  t.sweep();
  expect(t.messages()).toEqual(["Claude finished working"]);
});

test("a PR that never had checks is not held on a new head", async () => {
  const t = setup();
  t.pr(CHAT.id, "open", "none");
  await t.watch.tick();
  t.heads.set(CHAT.id, "h2");
  await t.feed(CHAT.id, [started("r1"), completed("r1")]);
  expect(t.watch.pending(CHAT.id)).toBe(false);
});

test("an open PR with settled checks is polled on the next tick once the branch's pushed head moves", async () => {
  const t = setup();
  t.pr(TMUX.id, "open", "success");
  await t.watch.tick();
  t.polled.length = 0;
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.polled).not.toContain(TMUX.id); // settled, head unchanged: 10-min cadence
  t.heads.set(TMUX.id, "h2"); // a tmux agent pushed (no checkNow)
  t.pr(TMUX.id, "open", "pending");
  t.tick(2 * MIN);
  await t.watch.tick();
  expect(t.polled).toContain(TMUX.id);
  expect(t.attention(TMUX.id)).toMatchObject({ section: "working", reason: "pr-checks" });
});

test("a row from before the head column adopts the PR head silently (no second notification)", async () => {
  const t = setup();
  t.pr(TMUX.id, "open", "failure");
  await t.watch.tick();
  t.db.run("UPDATE session_prs SET head_sha=NULL WHERE session_id=?", [TMUX.id]);
  t.tick(PR_SETTLED_POLL_MS);
  await t.watch.tick();
  expect(getSessionPr(t.db, TMUX.id)).toMatchObject({ checks: "failure", head_sha: "h1" });
  expect(t.messages()).toEqual(["CI failed on PR #7"]);
});
