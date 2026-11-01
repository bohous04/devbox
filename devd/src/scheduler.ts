import type { Database } from "bun:sqlite";
import { cronMatch } from "./cron";
import { getSchedule, listSchedules, listSessions, logEvent, setAutoEnd, setImportant, setScheduleLastRun, type ScheduleRow } from "./db";
import type { NotifyFn } from "./agentEvents";

export interface SchedulerDeps {
  db: Database;
  open: (t: { folder: string; project: string; repo: string; cloneUrl: string; prompt: string }) => Promise<{ session: { id: string } }>;
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
    const branch = `auto/${slug(sch.name)}-${stamp(new Date(at))}`;
    try {
      const r = await d.open({ folder: sch.folder, project: sch.project, repo: sch.repo, cloneUrl: sch.clone_url, prompt: scheduledPrompt(sch, branch) });
      setImportant(d.db, r.session.id, sch.important);
      // A scheduled run is one-off work: once the agent finishes its turn, autoEnd.ts ends the
      // session. Set only AFTER open() — for a restarted session open() actually
      // resets the flag, so a manually reopened session does not vanish after its first own turn.
      setAutoEnd(d.db, r.session.id, 1);
      logEvent(d.db, r.session.id, "schedule_run", { schedule: sch.name, branch, at });
      // DELIBERATELY without `important`: emergency (Pushover priority 2) is an alarm that rings
      // every minute for a whole hour until you acknowledge it — and "run started" wants nothing from you.
      // The morning cron used to wake the phone just by starting at all. The `sch.important` flag
      // is carried over to the session above, so only the block/completion of that work stays loud.
      d.notify(`${sch.project}/${sch.repo}`, `Scheduled run "${sch.name}" started`, { session: { id: r.session.id, project: sch.project, repo: sch.repo } });
    } catch (e) {
      logEvent(d.db, id, "schedule_error", { schedule: sch.name, error: (e as Error).message, at });
      d.notify(`${sch.project}/${sch.repo}`, `Scheduled run "${sch.name}" failed: ${(e as Error).message}`, { target: { kind: "schedules" } });
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
