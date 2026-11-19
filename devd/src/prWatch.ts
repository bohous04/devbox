import type { Database } from "bun:sqlite";
import { sessionTitle, type NotifyFn, type NotifySession } from "./agentEvents";
import type { PrHold } from "./attention";
import {
  clearPrWatchSeed, getSessionPr, listSessionPrs, logEvent, prWatchSeedPending, putSessionPr,
  type PrChecks, type PrStatus, type SessionPrRow, type SessionRow, type SettleReason,
} from "./db";
import type { Activity } from "./sessionAttention";
import { workspacePath } from "./tree";
import { baseBranch, findPr, giteaUrlFor, remoteHead, remoteInfo, remoteNames, type Fetcher, type GhRunner } from "./unpushed";

/** How often index.ts runs the PR watch; a PR with pending checks is polled on every tick. */
export const PR_WATCH_TICK_MS = 2 * 60_000;
/** An open PR whose checks are over is polled this often, to see it merged. */
export const PR_SETTLED_POLL_MS = 10 * 60_000;
/** Polling a session that keeps failing backs off from PR_WATCH_TICK_MS, doubling up to this. */
export const PR_ERROR_BACKOFF_MAX_MS = 30 * 60_000;
/** This many failed polls in a row release the hold of pending checks (the row becomes "unknown"). */
export const PR_ERRORS_RELEASE = 3;

export interface PrState { sessionId: string; number: number; url: string; state: PrStatus; checks: PrChecks }
/** One session's poll: its branch head on the remote (null = not pushed, or no branch) and its PR (null = none, or
 *  nothing to watch: other host, the default branch). */
export interface PrPoll { sessionId: string; head: string | null; pr: PrState | null }

/** Polls the given sessions one by one: the remote head of the branch, then, when `want` agrees, the provider's PR.
 *  A session `want` declines is left out of the result; an error is reported through `onError` and the session left
 *  out. */
export async function checkPrs(d: {
  sessions: SessionRow[];
  /** The workspace root: a session without a worktree works in its repo there. */
  root: string;
  /** Absent: the real `gh` and `fetch` (unpushed.ts findPr). */
  gh?: GhRunner;
  fetcher?: Fetcher;
  giteaUrls: string[];
  giteaToken: (host: string) => string | undefined;
  onError: (sessionId: string, e: Error) => void;
  /** Whether to ask the provider, given the branch's remote head. Absent = always. */
  want?: (sessionId: string, head: string) => boolean;
}): Promise<PrPoll[]> {
  const out: PrPoll[] = [];
  for (const s of d.sessions) {
    if (!s.branch) { out.push({ sessionId: s.id, head: null, pr: null }); continue; }
    try {
      const dir = s.worktree ?? workspacePath(d.root, s.folder, s.project, s.repo);
      const remote = await remoteInfo(dir, d.giteaUrls);
      if (!remote) {
        const names = await remoteNames(dir);
        if (names.length) throw new Error(`no remote named origin (has ${names.join(", ")}): the PR watch reads origin only`);
        out.push({ sessionId: s.id, head: null, pr: null });
        continue;
      }
      const head = await remoteHead(dir, s.branch);
      if (head === null) { out.push({ sessionId: s.id, head, pr: null }); continue; }
      if (d.want && !d.want(s.id, head)) continue;
      if (remote.provider === "other" || (await baseBranch(dir)) === s.branch) { out.push({ sessionId: s.id, head, pr: null }); continue; }
      const pr = await findPr({
        dir, branch: s.branch, remote, giteaToken: d.giteaToken(remote.host), giteaUrl: giteaUrlFor(d.giteaUrls, remote),
        ghRun: d.gh, fetcher: d.fetcher,
      });
      out.push({ sessionId: s.id, head, pr: pr ? { sessionId: s.id, ...pr } : null });
    } catch (e) {
      d.onError(s.id, e as Error);
    }
  }
  return out;
}

/** Watches the PR of every session with a pushed branch (step 5 "PR watch"); the state lives in `session_prs`, so a
 *  devd restart neither repeats a notification nor a settle.
 *  - Open PR with pending checks: holding work (attention `pr-checks`; the hub holds a chat run's "finished").
 *  - Checks failed: needs you (`ci-failed`), notified once per failure, wakes a snooze like an agent failure.
 *  - Merged: settles the session, at its next idle moment when a run is active.
 *  Polling: pending checks every tick; an open PR with settled checks every PR_SETTLED_POLL_MS; a session without a
 *  PR when its remote branch head moved or every PR_SETTLED_POLL_MS; after a merged or closed PR only when the head
 *  moved; and every chat run completion (`checkNow`). Errors back off. */
export class PrWatch {
  private errorsLogged = new Map<string, string>();
  private errors = new Map<string, { count: number; nextAt: number }>();
  private lastHead = new Map<string, string | null>();
  private lastPoll = new Map<string, number>();
  /** The poll running per session: polls of one session run one after another. */
  private chains = new Map<string, Promise<void>>();
  private log: (msg: string) => void;

  constructor(private d: {
    db: Database;
    sessions: () => SessionRow[];
    session: (id: string) => SessionRow | null;
    /** checkPrs over the given sessions (tests pass a fake). */
    check: (sessions: SessionRow[], onError: (sessionId: string, e: Error) => void, want?: (sessionId: string, head: string) => boolean) => Promise<PrPoll[]>;
    inbox: {
      changedSafe: (id: string) => void;
      settleWhenIdle: (id: string, reason: SettleReason) => boolean;
      activity: (id: string, kind: Activity) => void;
    };
    notify: NotifyFn;
    now?: () => number;
    log?: (msg: string) => void;
  }) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  /** The inbox's view of the session's open PR (null when it has none, or its checks need nothing). */
  hold(sessionId: string): PrHold | null {
    const r = getSessionPr(this.d.db, sessionId);
    if (!r || r.state !== "open") return null;
    return r.checks === "pending" || r.checks === "failure" ? { checks: r.checks, since: r.since } : null;
  }

  pending(sessionId: string): boolean { return this.hold(sessionId)?.checks === "pending"; }

  /** InstaBox sessions are left out: their worktree lives in the VM, not on this host. */
  private watchable(s: SessionRow): boolean { return !!s.branch && s.host === "vps"; }

  async tick(): Promise<void> {
    const seeding = prWatchSeedPending(this.d.db);
    const now = this.now();
    for (const s of this.d.sessions()) {
      const row = getSessionPr(this.d.db, s.id);
      if (!this.watchable(s)) {
        if (row?.state === "open" && row.checks === "pending") this.release(s.id, row, "none", "the session is no longer watched");
        continue;
      }
      const err = this.errors.get(s.id);
      if (err && now < err.nextAt) continue;
      if (row?.state === "open") {
        const settled = row.checks !== "pending" && row.checks !== "unknown";
        if (settled && now - (this.lastPoll.get(s.id) ?? 0) < PR_SETTLED_POLL_MS) continue;
        await this.serial(s, undefined, seeding);
      } else {
        // Without a row also every PR_SETTLED_POLL_MS: the PR may be opened after the push (a merged or closed PR
        // is not polled again until the branch moves; checkNow covers a chat run's completion).
        const due = row === null && now - (this.lastPoll.get(s.id) ?? 0) >= PR_SETTLED_POLL_MS;
        await this.serial(s, (id, head) => due || this.lastHead.get(id) !== head, seeding);
      }
    }
    if (seeding) clearPrWatchSeed(this.d.db);
    // Merges that waited for the session's next idle moment.
    for (const r of listSessionPrs(this.d.db)) {
      if (r.state === "merged" && r.merge_settled_at === null) this.guard(r.session_id, () => this.settleMerged(r.session_id));
    }
  }

  /** Polls one session now, whatever its PR's state (a run completion: it often pushed, maybe for a new PR); returns
   *  whether its PR's checks are pending, by the newest state devd has. */
  async checkNow(sessionId: string): Promise<boolean> {
    const s = this.d.session(sessionId);
    if (s && this.watchable(s)) await this.serial(s, undefined, prWatchSeedPending(this.d.db));
    return this.pending(sessionId);
  }

  private serial(s: SessionRow, want: ((id: string, head: string) => boolean) | undefined, seeding: boolean): Promise<void> {
    const prev = this.chains.get(s.id) ?? Promise.resolve();
    const run = prev.then(async () => {
      try { await this.pollOne(s, want, seeding); }
      catch (e) { this.log(`pr watch: ${s.id}: ${(e as Error).message}`); }
    });
    this.chains.set(s.id, run);
    void run.then(() => { if (this.chains.get(s.id) === run) this.chains.delete(s.id); });
    return run;
  }

  private async pollOne(s: SessionRow, want: ((id: string, head: string) => boolean) | undefined, seeding: boolean): Promise<void> {
    let error: Error | null = null;
    const polls = await this.d.check([s], (_id, e) => { error = e; }, want);
    if (error) { this.pollFailed(s.id, error); return; }
    this.errors.delete(s.id);
    this.errorsLogged.delete(s.id);
    const p = polls.find((x) => x.sessionId === s.id);
    if (!p) return; // `want` declined: nothing moved
    this.lastHead.set(s.id, p.head);
    this.lastPoll.set(s.id, this.now());
    const cur = this.d.session(s.id) ?? s;
    if (p.pr) { this.apply(cur, p.pr, seeding); return; }
    const row = getSessionPr(this.d.db, s.id);
    if (row?.state === "open" && row.checks === "pending") this.release(s.id, row, "none", "its PR is no longer found");
  }

  private pollFailed(id: string, e: Error): void {
    const count = (this.errors.get(id)?.count ?? 0) + 1;
    this.errors.set(id, { count, nextAt: this.now() + Math.min(PR_WATCH_TICK_MS * 2 ** (count - 1), PR_ERROR_BACKOFF_MAX_MS) });
    // Once per distinct message: a provider outage would otherwise log every session every tick.
    if (this.errorsLogged.get(id) !== e.message) {
      this.errorsLogged.set(id, e.message);
      this.log(`pr watch: PR of ${id} not read: ${e.message}`);
    }
    const row = getSessionPr(this.d.db, id);
    if (count >= PR_ERRORS_RELEASE && row?.state === "open" && row.checks === "pending") {
      this.release(id, row, "unknown", `its PR could not be read ${PR_ERRORS_RELEASE} times in a row`);
    }
  }

  /** Pending checks that devd can no longer follow stop holding the session. */
  private release(id: string, row: SessionPrRow, checks: "none" | "unknown", why: string): void {
    const now = this.now();
    putSessionPr(this.d.db, { ...row, checks, since: now, updated_at: now });
    this.log(`pr watch: releasing the CI hold of ${id}: ${why}`);
    this.d.inbox.changedSafe(id);
  }

  /** One session's failure must not stop the others in the tick. */
  private guard(id: string, fn: () => void) {
    try { fn(); }
    catch (e) { this.log(`pr watch: ${id}: ${(e as Error).message}`); }
  }

  /** `seeding`: the first-deploy pass records what is there, without notifying or settling. */
  private apply(s: SessionRow, pr: PrState, seeding: boolean): void {
    const prev = getSessionPr(this.d.db, s.id);
    if (prev && prev.number === pr.number && prev.state === pr.state && prev.checks === pr.checks) return;
    const now = this.now();
    const sameMerge = prev?.number === pr.number ? prev.merge_settled_at : null;
    putSessionPr(this.d.db, {
      session_id: s.id, number: pr.number, url: pr.url, state: pr.state, checks: pr.checks, since: now,
      merge_settled_at: seeding && pr.state === "merged" ? now : sameMerge, updated_at: now,
    });
    if (!seeding) {
      if (pr.state === "open" && pr.checks === "failure") this.ciFailed(s, pr);
      if (pr.state === "merged") this.settleMerged(s.id);
    }
    this.d.inbox.changedSafe(s.id);
  }

  private ciFailed(s: SessionRow, pr: PrState): void {
    // A failure wakes a snooze and unsettles, as an agent failure does; the notification goes out either way.
    try { this.d.inbox.activity(s.id, "failure"); }
    catch (e) { this.log(`pr watch: inbox shelf of ${s.id} not updated after a CI failure: ${(e as Error).message}`); }
    const session: NotifySession = { id: s.id, project: s.project, repo: s.repo, agent: s.agent, name: s.name, runtime: s.runtime };
    this.d.notify(sessionTitle(session), `CI failed on PR #${pr.number}`, { sound: true, session, important: s.important === 1 });
    logEvent(this.d.db, s.id, "ci_failed", { number: pr.number, url: pr.url });
  }

  private settleMerged(sessionId: string): void {
    const r = getSessionPr(this.d.db, sessionId);
    if (!r || r.state !== "merged" || r.merge_settled_at !== null) return;
    if (!this.d.inbox.settleWhenIdle(sessionId, "merged")) return;
    const now = this.now();
    putSessionPr(this.d.db, { ...r, merge_settled_at: now, updated_at: now });
    logEvent(this.d.db, sessionId, "pr_merged_settled", { number: r.number });
  }
}
