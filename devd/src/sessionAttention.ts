import type { Attention } from "../../shared/thread";
import type { UsageLimit } from "./accountUsage";
import { specFor } from "./agents";
import type { CodexView } from "./codexPoller";
import type { SessionAttentionRow, SessionRow } from "./db";

/** The Settled and Snoozed shelves of the inbox. The state is one `session_attention` row per session; the Inbox
 *  (sessionInbox.ts) writes it and lays it over the attention a session has on its own.
 *  - Settled: by hand, or automatically after AUTO_SETTLE_IDLE_MS without activity. A new run, a request or a
 *    failure unsettles.
 *  - Snoozed: until a time, or until the session's active usage limit resets. Only a request or a failure wakes it
 *    early; its completions are silent (AgentEventHub.sweep). */
export const AUTO_SETTLE_IDLE_MS = 7 * 86_400_000;
export const AUTO_SETTLE_TICK_MS = 10 * 60_000;

/** What the AgentEventHub reports for the shelves: a new run (prompt), a request (question, approval), a failure. */
export type Activity = "run" | "request" | "failure";

export function snoozeActive(row: SessionAttentionRow | null, now: number): boolean {
  return row !== null && row.snooze_until !== null && row.snooze_until > now;
}

/** The session's attention with its shelf laid over it: an active snooze, else settled, else unchanged. */
export function shelve(base: Attention, row: SessionAttentionRow | null, now: number): Attention {
  if (row !== null && snoozeActive(row, now)) return { ...base, section: "snoozed", until: row.snooze_until! };
  if (row?.settled_at != null) return { ...base, section: "settled" };
  return base;
}

/** Auto-settle: nothing has happened for AUTO_SETTLE_IDLE_MS (the attention's own time and the session's last
 *  prompt and creation all count), and nothing blocks it: a pending request, an active run or holding work (both
 *  "working"), a snooze, or a settle already in place. */
export function autoSettleDue(base: Attention, s: SessionRow, row: SessionAttentionRow | null, now: number): boolean {
  if (row?.settled_at != null || snoozeActive(row, now)) return false;
  if (base.section === "working" || base.reason === "request") return false;
  return now - Math.max(base.since, s.last_active_at, s.created_at) >= AUTO_SETTLE_IDLE_MS;
}

/** When "snooze until the limit resets" would end, or why it is not possible. */
export type ResetTarget = { resetsAt: number } | { reason: string };

export interface ResetDeps {
  /** The Anthropic account the session runs on (its newest lease); null when unknown. */
  claudeAccount: (sessionId: string) => string | null;
  /** The account's last measured limits; null when it was never measured. */
  claudeLimits: (accountId: string) => UsageLimit[] | null;
  /** The Codex account the session runs on; null when devd does not know it. */
  codexAccount: (s: SessionRow) => string | null;
  /** The account's last measured usage; null when it was never measured. */
  codexUsage: (accountId: string) => CodexView | null;
}

const NO_ACTIVE_LIMIT = "No usage limit is active on this account";

/** The reset of the session's active usage limit, per harness. Claude: the limits the API marks `isActive`.
 *  Codex: the windows at 100 %. With more than one, the latest reset: the account stays blocked until then.
 *  ACP agents and proxy profiles have no meter devbox reads. */
export function untilReset(s: SessionRow, d: ResetDeps, now: number): ResetTarget {
  const spec = specFor(s.agent);
  let resets: (number | null)[];
  if (spec.runtime === "claude" && spec.anthropicAccount) {
    const account = d.claudeAccount(s.id);
    if (account === null) return { reason: "The account of this session is not known" };
    const limits = d.claudeLimits(account);
    if (limits === null) return { reason: "The usage of this account has not been measured yet" };
    resets = limits.filter((l) => l.isActive).map((l) => l.resetsAt);
  } else if (spec.runtime === "codex") {
    const account = d.codexAccount(s);
    if (account === null) return { reason: "The account of this session is not known" };
    const usage = d.codexUsage(account);
    if (usage === null) return { reason: "The usage of this account has not been measured yet" };
    resets = usage.windows.filter((w) => w.usedPct !== null && w.usedPct >= 100).map((w) => w.resetsAt);
  } else {
    return { reason: `${spec.label} has no usage limit devbox can read` };
  }
  const future = resets.filter((r): r is number => r !== null && r > now);
  if (future.length) return { resetsAt: Math.max(...future) };
  return { reason: resets.includes(null) ? "The active limit has no known reset time" : NO_ACTIVE_LIMIT };
}
