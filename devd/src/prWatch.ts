import type { Database } from "bun:sqlite";
import { sessionTitle, type NotifyFn, type NotifySession } from "./agentEvents";
import type { PrHold } from "./attention";
import { getSessionPr, listSessionPrs, logEvent, putSessionPr, type PrChecks, type PrStatus, type SessionRow, type SettleReason } from "./db";
import type { Activity } from "./sessionAttention";
import { workspacePath } from "./tree";
import { baseBranch, findPr, giteaUrlFor, pushedBranch, remoteInfo, type Fetcher, type GhRunner } from "./unpushed";

/** How often index.ts polls the PRs of sessions with a pushed branch. */
export const PR_WATCH_TICK_MS = 2 * 60_000;

export interface PrState { sessionId: string; number: number; url: string; state: PrStatus; checks: PrChecks }

/** The PR of each session's branch, when the branch is pushed, its remote is GitHub or a configured Gitea, and it is
 *  not the remote's default branch. Sessions without a PR are left out; an error is reported per session through
 *  `onError` and that session is left out. Sequential: one provider call at a time per tick. */
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
}): Promise<PrState[]> {
  const out: PrState[] = [];
  for (const s of d.sessions) {
    if (!s.branch) continue;
    try {
      const dir = s.worktree ?? workspacePath(d.root, s.folder, s.project, s.repo);
      if (!(await pushedBranch(dir, s.branch))) continue;
      const remote = await remoteInfo(dir, d.giteaUrls);
      if (!remote || remote.provider === "other") continue;
      if ((await baseBranch(dir)) === s.branch) continue;
      const pr = await findPr({
        dir, branch: s.branch, remote, giteaToken: d.giteaToken(remote.host), giteaUrl: giteaUrlFor(d.giteaUrls, remote),
        ghRun: d.gh, fetcher: d.fetcher,
      });
      if (pr) out.push({ sessionId: s.id, ...pr });
    } catch (e) {
      d.onError(s.id, e as Error);
    }
  }
  return out;
}

/** Watches the PR of every session with a pushed branch (step 5 "PR watch"); the state lives in `session_prs`, so a
 *  devd restart neither repeats a notification nor a settle.
 *  - Open PR with pending checks: holding work (attention `pr-checks`; ChatHub holds the run's "done").
 *  - Checks failed: needs you (`ci-failed`), notified once per failure, wakes a snooze like an agent failure.
 *  - Merged: settles the session, at its next idle moment when a run is active. Merged or closed: no more polling. */
export class PrWatch {
  private errorsLogged = new Map<string, string>();
  private log: (msg: string) => void;

  constructor(private d: {
    db: Database;
    sessions: () => SessionRow[];
    session: (id: string) => SessionRow | null;
    /** checkPrs over the given sessions (tests pass a fake). */
    check: (sessions: SessionRow[], onError: (sessionId: string, e: Error) => void) => Promise<PrState[]>;
    inbox: {
      changedSafe: (id: string) => void;
      settleWhenIdle: (id: string, reason: SettleReason) => boolean;
      activity: (id: string, kind: Activity) => void;
    };
    /** Pending checks ended: ChatHub releases a completion they held. */
    checksEnded: (id: string) => void;
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
  private watched(s: SessionRow): boolean {
    if (!s.branch || s.host !== "vps") return false;
    const r = getSessionPr(this.d.db, s.id);
    return r === null || r.state === "open";
  }

  async tick(): Promise<void> {
    const due = this.d.sessions().filter((s) => this.watched(s));
    if (due.length) await this.poll(due);
    // Merges that waited for the session's next idle moment.
    for (const r of listSessionPrs(this.d.db)) {
      if (r.state === "merged" && r.merge_settled_at === null) this.guard(r.session_id, () => this.settleMerged(r.session_id));
    }
  }

  /** Polls one session now (ChatHub, when a run completes: it often pushed just before); returns whether its PR's
   *  checks are pending, by the newest state devd has. */
  async checkNow(sessionId: string): Promise<boolean> {
    const s = this.d.session(sessionId);
    if (s && this.watched(s)) await this.poll([s]);
    return this.pending(sessionId);
  }

  private async poll(sessions: SessionRow[]): Promise<void> {
    const failed = new Set<string>();
    const prs = await this.d.check(sessions, (id, e) => {
      failed.add(id);
      // Once per distinct message: a provider outage would otherwise log every session every tick.
      if (this.errorsLogged.get(id) === e.message) return;
      this.errorsLogged.set(id, e.message);
      this.log(`pr watch: PR of ${id} not read: ${e.message}`);
    });
    for (const s of sessions) if (!failed.has(s.id)) this.errorsLogged.delete(s.id);
    for (const pr of prs) {
      const s = this.d.session(pr.sessionId);
      if (s) this.guard(s.id, () => this.apply(s, pr));
    }
  }

  /** One session's failure must not stop the others in the tick. */
  private guard(id: string, fn: () => void) {
    try { fn(); }
    catch (e) { this.log(`pr watch: ${id}: ${(e as Error).message}`); }
  }

  private apply(s: SessionRow, pr: PrState): void {
    const prev = getSessionPr(this.d.db, s.id);
    if (prev && prev.number === pr.number && prev.state === pr.state && prev.checks === pr.checks) return;
    const now = this.now();
    putSessionPr(this.d.db, {
      session_id: s.id, number: pr.number, url: pr.url, state: pr.state, checks: pr.checks, since: now,
      merge_settled_at: prev?.number === pr.number ? prev.merge_settled_at : null, updated_at: now,
    });
    const wasPending = prev?.state === "open" && prev.checks === "pending";
    const open = pr.state === "open";
    if (open && pr.checks === "failure") this.ciFailed(s, pr);
    if (wasPending && !(open && pr.checks === "pending")) this.d.checksEnded(s.id);
    if (pr.state === "merged") this.settleMerged(s.id);
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
