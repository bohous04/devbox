import type { Database } from "bun:sqlite";
import { getSession, logEvent } from "./db";
import { worktreeChanges } from "./git";

export interface AutoEndDeps {
  db: Database;
  end: (id: string, soloAction?: "keep" | "delete", opts?: { keepWorktree?: boolean }) => Promise<void>;
  /** Working tree status; injectable only for tests, production code keeps the default. */
  changes?: (dir: string) => Promise<string[] | null>;
}

// Cleanup after scheduled runs. The input is the ids of sessions that have just been sent
// "finished work" (AgentEventHub.sweep) — when exactly the turn ended is the hub's concern;
// this decides only ONE thing: does the session belong to cron, or is it your work?
//
// It ends, not suspends: a scheduled run should not leave even a row in the list behind.
// `end` also releases the account lease itself.
//
// WHAT SURVIVES DEPENDS ON THE REPO SHAPE:
//  * Session with its own worktree (`worktree != null`): `end` normally DELETES that directory
//    even with uncommitted work. For cron, though, there is no human in the loop to
//    confirm it, so only a CLEAN tree is deleted here. If work remains in it, the directory
//    stays on disk and `auto_end_kept` with the reason goes to the Log. When the state
//    CANNOT be determined, that also counts as "something is left" and the directory stays —
//    a needlessly kept one is a nuisance, silently deleted work is a loss.
//  * Repo in the old shape (`worktree === null`): the workspace is shared and `end` does not
//    delete it at all — it survives as before, nothing to handle.
// The branch is not deleted in any case (see end()), so commits always survive.
export async function endFinishedRuns(d: AutoEndDeps, doneIds: string[]): Promise<string[]> {
  const changes = d.changes ?? worktreeChanges;
  const ended: string[] = [];
  for (const id of doneIds) {
    const s = getSession(d.db, id);
    // The row may have vanished in the meantime (manual End a second earlier) — nothing to clean up.
    if (!s || s.auto_end !== 1) continue;
    // `null` = the state could not be determined. Treated as "something may be left": a needlessly
    // kept directory is a nuisance, silently deleted work is a loss.
    const dirt = s.worktree ? await changes(s.worktree) : [];
    const keepWorktree = s.worktree != null && (dirt === null || dirt.length > 0);
    // Log BEFORE ending: `end` deletes the session row, but events survive, so the Log
    // then shows that cron, not a human, was behind the session's disappearance.
    logEvent(d.db, id, "auto_end", { project: s.project, repo: s.repo, reason: "agent-done" });
    if (keepWorktree) {
      // Without this row a scheduled run would leave behind a directory nobody knows about.
      logEvent(d.db, id, "auto_end_kept", {
        worktree: s.worktree,
        reason: dirt === null ? "status-unknown" : "dirty",
        // A sample of the changes, so the Log shows what it is about; the full listing can be long.
        changes: dirt?.length ?? null, sample: dirt?.slice(0, 10) ?? null,
      });
    }
    try {
      await d.end(id, "keep", { keepWorktree });
      ended.push(id);
    } catch (e) {
      // We deliberately DO NOT CLEAR the flag: the session still belongs to cron and on the next finished
      // turn the cleanup is retried. A stuck docker thus does not cause a permanent session leak.
      logEvent(d.db, id, "auto_end_error", { error: (e as Error).message });
    }
  }
  return ended;
}
