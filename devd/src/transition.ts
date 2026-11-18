import type { Capabilities, TokenUsage } from "../../shared/thread";
import { buildHandoff, type Handoff } from "./handoff";
import type { ThreadStore } from "./threadStore";

export type Target = { harness: "claude" | "codex" | string; account: string | null; model: string | null };
export type Transition =
  | { kind: "set-model"; model: string }
  | { kind: "restart-resume"; target: Target; nativeThreadId: string }
  | { kind: "resume-with-delta"; target: Target; nativeThreadId: string; handoff: Handoff }
  | { kind: "fresh-with-handoff"; target: Target; handoff: Handoff };

/** What the plan cannot know itself. `window` and `reserve` are tokens of the target model (its context window and
 *  the room kept for its answer); `now` is ms like the store's timestamps. */
export interface PlanOptions {
  window: number;
  reserve: number;
  now: number;
}

/** A native thread last used this long ago is not resumed. */
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function resumeFailedNotice(harness: string): string {
  return `Could not resume the earlier ${harness} thread; started a fresh one with the conversation handed over.`;
}

// Run usage is the run's total, so for a multi-call turn this over-estimates the context: the safe side.
const contextUsed = (u: TokenUsage): number => u.input + u.output + u.cacheCreation + u.cacheRead;

function fresh(target: Target, store: ThreadStore, request: string, o: PlanOptions): Transition {
  const { items, runs } = store.snapshot();
  // A new native thread has used nothing of its window yet.
  const handoff = buildHandoff({ items, runs, request, window: o.window, used: 0, reserve: o.reserve });
  return { kind: "fresh-with-handoff", target, handoff };
}

/** Delta over the runs `harness`'s last thread missed, or null when that thread cannot be resumed (none, stale,
 *  or its last seen run is unknown). */
function delta(target: Target, store: ThreadStore, request: string, o: PlanOptions): Transition | null {
  const prev = store.providerThread(target.harness);
  if (prev === null || prev.coveredThroughRun === null || o.now - prev.lastUsedAt >= STALE_MS) return null;
  const { items, runs } = store.snapshot(); // runs in arrival order
  const last = runs.findIndex((r) => r.runId === prev.coveredThroughRun);
  if (last < 0) return null;
  const coveredRunIds = new Set(runs.slice(0, last + 1).map((r) => r.runId));
  // Unknown usage (the harness reported none) counts as 0, as decided for step 3.
  const latest = runs.findLast((r) => r.nativeThreadId === prev.nativeThreadId && r.usage !== null);
  const used = latest?.usage ? contextUsed(latest.usage) : 0;
  const handoff = buildHandoff({ items, runs, coveredRunIds, request, window: o.window, used, reserve: o.reserve });
  return { kind: "resume-with-delta", target, nativeThreadId: prev.nativeThreadId, handoff };
}

/** `caps` are the target adapter's. A `null` target model means the harness default, which only a restart applies. */
export function planTransition(current: Target & { nativeThreadId: string | null }, target: Target, store: ThreadStore,
  request: string, caps: Capabilities, o: PlanOptions): Transition {
  if (target.harness === current.harness) {
    if (target.account === current.account && caps.liveModelSwitch && target.model !== null) {
      return { kind: "set-model", model: target.model };
    }
    if (caps.resume && current.nativeThreadId !== null) return { kind: "restart-resume", target, nativeThreadId: current.nativeThreadId };
    return fresh(target, store, request, o);
  }
  return (caps.resume ? delta(target, store, request, o) : null) ?? fresh(target, store, request, o);
}

/** The bridge reported `run.failed{error:"resume-failed"}` for a planned resume: start a fresh native thread with
 *  the full handoff and tell the user in the thread. */
export function planAfterResumeFailure(target: Target, store: ThreadStore, request: string, o: PlanOptions): Transition {
  store.addNotice(resumeFailedNotice(target.harness), o.now);
  return fresh(target, store, request, o);
}
