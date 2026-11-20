import type { Database } from "bun:sqlite";
import { cronMatch } from "./cron";
import { getSchedule, getSession, listSchedules, listSessions, logEvent, setAutoEnd, setImportant, setScheduleLastRun, type ScheduleRow, type SessionRow } from "./db";
import type { NotifyFn, NotifySession } from "./agentEvents";
import type { AgentName, SessionRuntime } from "./db";
import { chatRuntimeBlock } from "./agents";
import { resolveAgent, storedRuntime } from "./sessions";
import { endSessionKeepingWork, type AutoEndDeps } from "./autoEnd";
import { CommandTimeout, FirstTurnPending } from "./bridgeLink";

/** How long a chat schedule waits for the new session's bridge before it fails visibly. */
export const BRIDGE_WAIT_MS = 120_000;

export interface SchedulerDeps {
  db: Database;
  open: (t: { folder: string; project: string; repo: string; cloneUrl: string; prompt?: string; runtime?: SessionRuntime; agent?: AgentName }) => Promise<{ session: { id: string }; claudePrompt?: string }>;
  /** The bridge links of chat sessions; required for a chat schedule. */
  links?: {
    ensure: (id: string) => void;
    startTurnWhenConnected: (id: string, text: string, onDone: (err: Error | null) => void, tag: string) => void;
    discardFirstTurn: (id: string) => boolean;
  };
  /** Ends a session this schedule opened but could not start. */
  end?: AutoEndDeps["end"];
  /** Working tree status for the end's dirty-tree guard (autoEnd.ts); tests only. */
  changes?: AutoEndDeps["changes"];
  /** The repo's remembered agent, used when a chat schedule names none. */
  repoAgent?: (t: { folder: string; project: string; repo: string }) => AgentName | null;
  bridgeWaitMs?: number;
  containerRunning: (id: string) => Promise<boolean>;
  notify: NotifyFn;
  now?: () => number;
}

// Slug for a branch name: anything outside [a-z0-9] (including diacritics and spaces) → '-'.
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "run";
}
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
export function scheduledPrompt(sch: ScheduleRow, branch: string): string {
  return `Automated scheduled run "${sch.name}".\n\n`
    + `First create and switch to a new git branch \`${branch}\` (from the current default branch). Then the task:\n\n`
    + `${sch.prompt}\n\n`
    + `When you are done: commit, push the branch and open a pull request via \`gh\` with a summary. Do not merge. `
    + `If the task requires no change, do not commit anything and explain why.`;
}

export function dueSchedules(db: Database, now: Date): ScheduleRow[] {
  const minute = Math.floor(now.getTime() / 60000);
  return listSchedules(db).filter((s) =>
    s.enabled === 1 && cronMatch(s.cron, now) &&
    (s.last_run_at === null || Math.floor(s.last_run_at / 60000) !== minute));
}

export function createScheduler(d: SchedulerDeps) {
  const now = () => d.now?.() ?? Date.now();

  async function fireSchedule(sch: ScheduleRow): Promise<void> {
    const id = `dev-${sch.project}-${sch.repo}`;
    const at = now();
    // Skipped when ANY session of that repo is running, not just the one with the base id:
    // `open()` without `fresh` attaches to any running session of the repo (existingSessionId)
    // and its "exists and running" shortcut returns BEFORE `syncPromptFile` writes
    // the prompt. If we only asked about the base id, the run would be logged, a "started"
    // notification would go out — and the scheduled work would silently never get done.
    // `fresh: true` is NOT the solution: every nightly run would create another session instead of
    // today's reuse of the stopped one.
    // We still ask docker (`containerRunning`), not the `status` column — the row may claim
    // something other than what is actually running. The DB supplies only CANDIDATES, not the answer; that is why
    // `existingSessionId`, which relies on exactly that column, does not fit here.
    const candidates = new Set([id, ...listSessions(d.db)
      .filter((s) => s.project === sch.project && s.repo === sch.repo).map((s) => s.id)]);
    for (const candidate of candidates) {
      if (!(await d.containerRunning(candidate))) continue;
      const session = { id: candidate, project: sch.project, repo: sch.repo };
      logEvent(d.db, candidate, "schedule_skip", { schedule: sch.name, at });
      d.notify(`${sch.project}/${sch.repo}`, `Scheduled run "${sch.name}" skipped — session is running`, { session });
      return;
    }
    let openedId: string | null = null;
    const branch = `auto/${slug(sch.name)}-${stamp(new Date(at))}`;
    try {
      const chat = sch.runtime === "chat";
      if (chat && (!d.links || !d.end || !d.repoAgent)) throw new Error("chat schedules need the bridge links, which are not available");
      if (chat) {
        // The agent open() will use: the schedule's own, else the repo's remembered one. Checked before open() so a
        // schedule that cannot run in chat creates no container.
        const blocked = chatRuntimeBlock(resolveAgent(sch.agent ?? undefined, d.repoAgent!(sch)), "vps");
        if (blocked) throw new Error(blocked);
      }
      // A chat session has no prompt file: the prompt is the first turn, sent through the bridge below.
      const r = await d.open({
        folder: sch.folder, project: sch.project, repo: sch.repo, cloneUrl: sch.clone_url,
        ...(chat ? { runtime: "chat" as const } : { prompt: scheduledPrompt(sch, branch) }),
        ...(sch.agent ? { agent: sch.agent } : {}),
      });
      openedId = chat ? r.session.id : null;
      setImportant(d.db, r.session.id, sch.important);
      // A scheduled run is one-off work: once the agent finishes its turn, autoEnd.ts ends the
      // session. Set only AFTER open() — for a restarted session open() actually
      // resets the flag, so a manually reopened session does not vanish after its first own turn.
      setAutoEnd(d.db, r.session.id, 1);
      if (chat) {
        const text = scheduledPrompt(sch, branch);
        // devd's own message about a pull conflict goes first, in the same turn: one first message per session.
        const links = d.links!;
        links.ensure(r.session.id);
        // Persisted until the bridge confirms, so a devd restart while waiting still delivers it.
        const accepted = new Promise<Error | null>((resolve) =>
          links.startTurnWhenConnected(r.session.id, r.claudePrompt ? `${r.claudePrompt}\n\n${text}` : text, resolve, sch.name));
        const waitMs = d.bridgeWaitMs ?? BRIDGE_WAIT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([accepted, new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), waitMs); })]);
        clearTimeout(timer);
        let failure: Error | null;
        if (outcome !== "timeout") failure = outcome;
        // discardFirstTurn is false when the turn went out meanwhile: then its own outcome decides, not the clock.
        else failure = links.discardFirstTurn(r.session.id)
          ? new Error(`the agent bridge of ${r.session.id} did not connect within ${Math.round(waitMs / 1000)} s`)
          : await accepted;
        if (failure) throw failure;
      }
      logEvent(d.db, r.session.id, "schedule_run", { schedule: sch.name, branch, at });
      // DELIBERATELY without `important`: emergency (Pushover priority 2) is an alarm that rings
      // every minute for a whole hour until you acknowledge it — and "run started" wants nothing from you.
      // The morning cron used to wake the phone just by starting at all. The `sch.important` flag
      // is carried over to the session above, so only the block/completion of that work stays loud.
      // With the runtime: a click on the Mac (listener) opens a chat session's thread, a tmux session's terminal.
      d.notify(`${sch.project}/${sch.repo}`, `Scheduled run "${sch.name}" started`, { session: { id: r.session.id, project: sch.project, repo: sch.repo, runtime: sch.runtime } });
    } catch (e) {
      // A chat session this run opened has no prompt and is marked auto_end: left running it would make every later
      // run of the repo skip. End it (keeping a dirty worktree, as autoEnd does), and say whether that worked.
      // Not when the first turn's outcome is unknown (the bridge did not answer): the agent may be working.
      let error = (e as Error).message;
      if (openedId && e instanceof CommandTimeout) error = `first turn outcome unknown (${error}); check the session ${openedId}`;
      // The session holds someone else's first message (a user's prompt): it is theirs, so it is not ended.
      else if (openedId && e instanceof FirstTurnPending) error += "; the session is left as it is";
      else if (openedId) {
        try {
          const s = getSession(d.db, openedId);
          if (s) { await endSessionKeepingWork({ db: d.db, end: d.end!, changes: d.changes }, s, "schedule-failed"); error += `; session ${openedId} ended`; }
        } catch (endErr) { error += `; ending session ${openedId} failed: ${(endErr as Error).message}`; }
      }
      logEvent(d.db, openedId ?? id, "schedule_error", { schedule: sch.name, error, at });
      d.notify(`${sch.project}/${sch.repo}`, `Scheduled run "${sch.name}" failed: ${error}`, { target: { kind: "schedules" } });
    }
  }

  async function tick(when: Date): Promise<void> {
    for (const sch of dueSchedules(d.db, when)) {
      setScheduleLastRun(d.db, sch.id, when.getTime());  // set the guard BEFORE fire (no double run)
      await fireSchedule(sch);
    }
  }

  async function fireNow(id: string): Promise<boolean> {
    const sch = getSchedule(d.db, id);
    if (!sch) return false;
    setScheduleLastRun(d.db, sch.id, now());
    await fireSchedule(sch);
    return true;
  }

  return { tick, fireNow, fireSchedule };
}

/** The notification target of a scheduled run's session, with its runtime (index.ts onRestoredTurnDone). */
export function scheduledNotifySession(s: SessionRow): NotifySession {
  return { id: s.id, project: s.project, repo: s.repo, runtime: storedRuntime(s) };
}
