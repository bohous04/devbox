import type { Attention, LinkStatus, RunRow, ThreadSnapshot } from "../../shared/thread";
import type { AgentLiveSnapshot } from "./agentEvents";

/** A run that ended this recently still counts as working, so a run that is about to continue does not flicker. */
export const WORKING_GRACE_MS = 2000;

/** devd's link to a running chat session's bridge and since when it has that status; `behindSince` when the
 *  bridge's log is behind the thread store (BridgeLinks.behind). */
export interface LinkState { status: LinkStatus; since: number; behindSince?: number }

/** The run that ended last (highest `endedSeq`). Not the last row: a continuation run is inserted after a run that
 *  was queued before the restart, but runs and ends first. */
export function lastEndedRun(t: ThreadSnapshot): RunRow | undefined {
  let last: RunRow | undefined;
  for (const r of t.runs) if (r.endedSeq !== null && (last === undefined || r.endedSeq > last.endedSeq!)) last = r;
  return last;
}

function required(v: number | null, what: string, run: RunRow): number {
  if (v === null) throw new Error(`run ${run.runId} (${run.status}) has no ${what}`);
  return v;
}

/** `t` must be a full snapshot (no `afterSeq`): runs filtered by seq would hide the last run. Items are not read.
 *  `link` is null when devd keeps no link to the bridge (the session is not running): then a lost connection
 *  is expected, not something the user has to look at. */
export function chatAttention(t: ThreadSnapshot, link: LinkState | null, now: number): Attention {
  if (t.pending.length > 0) {
    return { section: "needs_you", reason: "request", since: Math.min(...t.pending.map((p) => p.openedAt)) };
  }
  // Before "working": a run the store still calls running may be dead with the bridge.
  if (link?.status === "disconnected") return { section: "needs_you", reason: "disconnected", since: link.since };
  // New events may be dropped as duplicates: nothing below can be trusted to be current.
  if (link?.behindSince !== undefined) return { section: "needs_you", reason: "bridge-behind", since: link.behindSince };
  // No link = the session is not running: a run the store still calls running or queued, and background work,
  // died with the container (the bridge resolves them on its next start), so none of it is work in progress.
  const live = link !== null;
  const running = t.runs.find((r) => r.status === "running");
  const queued = t.runs.find((r) => r.status === "queued");
  if (running) {
    const since = required(running.startedAt, "startedAt", running);
    return live ? { section: "working", reason: "running", since } : { section: "idle", reason: null, since };
  }
  if (queued) {
    const since = required(queued.queuedAt, "queuedAt", queued);
    return live ? { section: "working", reason: "queued", since } : { section: "idle", reason: null, since };
  }

  // Every run has ended here (running and queued returned above).
  const last = lastEndedRun(t);
  const holding = live && t.background.some((w) => w.holding);
  if (!last) {
    if (holding) throw new Error("holding background work without any run: is the snapshot partial?");
    return { section: "idle", reason: null, since: 0 };
  }
  const endedAt = required(last.endedAt, "endedAt", last);
  const unseen = t.seenSeq < required(last.endedSeq, "endedSeq", last);
  if (last.status === "failed" && unseen) return { section: "needs_you", reason: last.failureReason ?? "failed", since: endedAt };
  if (holding) return { section: "working", reason: "background", since: endedAt };
  if (now - endedAt < WORKING_GRACE_MS) return { section: "working", reason: "running", since: endedAt };
  if (last.status === "completed" && unseen) {
    return { section: "needs_you", reason: "completed", since: endedAt };
  }
  return { section: "idle", reason: null, since: endedAt };
}

/** ccUpkeep must not restart the agent: it is working, or an open request (question, approval) would die with it. */
export function chatBusy(t: ThreadSnapshot, a: Attention): boolean {
  return a.section === "working" || t.pending.length > 0;
}

/** The hub's live state of a tmux session. `done` stays needs_you until the next prompt: tmux has no seen marker. */
export function tmuxAttention(live: AgentLiveSnapshot | null): Attention {
  if (!live) return { section: "idle", reason: null, since: 0 };
  const since = live.statusSince;
  switch (live.status) {
    case "waiting": return { section: "needs_you", reason: "request", since };
    case "failed": return { section: "needs_you", reason: "failed", since };
    case "done": return { section: "needs_you", reason: "completed", since };
    case "working":
    case "stalled": return { section: "working", reason: "running", since };
    case "unknown": return { section: "idle", reason: null, since };
  }
}
