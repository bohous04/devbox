// Live Activity ContentState v2 (layout B2 + widget). The contract with iOS is the fixture
// ios/DevboxAppTests/Fixtures/agent-live-activity-v2.json — keys and ISO dates exactly like that.
import type { LiveAgentStatus } from "./agentEvents";
import { clipToBytes as clip } from "./textBudget";

// Byte limits of the text fields (UTF-8), sized for the Dynamic Island and lock screen.
const ACTIVITY_TITLE_LIMIT = 70;
const ACTIVITY_LABEL_LIMIT = 40;

export type V2Status = "waiting" | "working" | "done" | "stalled" | "unknown";
export interface V2Session { id: string; title: string; agent: string; project: string; status: V2Status; reason: string | null; since: string }
export interface ActivityStateV2 {
  version: 2;
  counts: Record<V2Status, number>;
  dot: "waiting" | "stalled" | "working" | "idle";
  sessions: V2Session[];
  overflow: number;
  changedAt: string;
  updatedAt: string;
}
/** One RUNNING session; `status` is the state from the hub (ended sessions do not belong here). */
export interface ActivitySessionInput {
  id: string; title: string; agent: string; project: string;
  status: LiveAgentStatus; reason: string | null; since: number;
}

export const MAX_SESSIONS = 8;
// The APNs envelope (aps, timestamp, stale-date, on start attributes with a serverID of up to 128 chars
// and alert) is ~350 B; the rest of the 4096 B limit belongs to content-state.
export const CONTENT_STATE_BUDGET = 4096 - 512;
const REASON_TRIM = 60;
const ORDER: V2Status[] = ["waiting", "stalled", "working", "done", "unknown"];

function v2Status(s: LiveAgentStatus): V2Status {
  return s === "failed" || s === "stalled" ? "stalled" : s;
}
/** A stalled row always has a reason: an agent error differs from mere silence. */
function v2Reason(s: LiveAgentStatus, reason: string | null): string | null {
  if (reason !== null) return reason;
  return s === "failed" ? "Failed with an error" : s === "stalled" ? "May be stuck" : null;
}
function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}
const bytes = (s: ActivityStateV2) => Buffer.byteLength(JSON.stringify(s), "utf8");

export function deriveActivityV2(rows: ActivitySessionInput[], now: number, budget = CONTENT_STATE_BUDGET): ActivityStateV2 {
  const mapped = rows.map((r) => ({ ...r, status: v2Status(r.status), reason: v2Reason(r.status, r.reason) }));
  const counts = { waiting: 0, working: 0, done: 0, stalled: 0, unknown: 0 };
  for (const r of mapped) counts[r.status]++;
  // waiting/stalled/working: longest-running first; finished: most recently finished first.
  mapped.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)
    || (a.status === "done" || a.status === "unknown" ? b.since - a.since : a.since - b.since)
    || a.id.localeCompare(b.id));
  const sessions: V2Session[] = mapped.slice(0, MAX_SESSIONS).map((r) => ({
    id: clip(r.id, 160), title: clip(r.title, ACTIVITY_TITLE_LIMIT), agent: clip(r.agent, ACTIVITY_LABEL_LIMIT),
    project: clip(r.project, ACTIVITY_LABEL_LIMIT), status: r.status, reason: r.reason,
    since: new Date(r.since).toISOString(),
  }));
  const state: ActivityStateV2 = {
    version: 2, counts,
    dot: counts.waiting ? "waiting" : counts.stalled ? "stalled" : counts.working ? "working" : "idle",
    sessions, overflow: mapped.length - sessions.length,
    // Without sessions a fixed value: "now" would change the fingerprint every tick and break the heartbeat.
    changedAt: new Date(mapped.reduce((max, r) => Math.max(max, r.since), 0)).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  return fitBudget(state, budget);
}

/** Trimming for APNs: first reasons to 60 chars, then reasons dropped from the end, then sessions from the end. */
function fitBudget(state: ActivityStateV2, budget: number): ActivityStateV2 {
  if (bytes(state) <= budget) return state;
  for (const s of state.sessions) if (s.reason !== null) s.reason = clipChars(s.reason, REASON_TRIM);
  for (let i = state.sessions.length - 1; i >= 0 && bytes(state) > budget; i--) state.sessions[i].reason = null;
  while (state.sessions.length > 0 && bytes(state) > budget) { state.sessions.pop(); state.overflow++; }
  return state;
}

/** Priority 10 only when the set of waiting or stalled sessions changes.
 *  Accepted limitation: only rows in the payload + counts are compared. When trimming
 *  (more than 8 sessions / 4 KiB) swaps a waiting or stalled session that is not in the
 *  payload and the counts stay the same, priority 10 does not trigger — nothing visible
 *  changes on the card, so there is nothing to deliver urgently. */
export function needsHighPriority(prev: ActivityStateV2 | null, next: ActivityStateV2): boolean {
  const key = (s: ActivityStateV2 | null) => {
    if (!s) return JSON.stringify([0, 0, []]); // nothing sent = nothing was waiting
    const ids = s.sessions.filter((x) => x.status === "waiting" || x.status === "stalled")
      .map((x) => `${x.status}:${x.id}`).sort();
    // Counts also cover sessions that did not fit into the payload.
    return JSON.stringify([s.counts.waiting, s.counts.stalled, ids]);
  };
  return key(prev) !== key(next);
}
