import type { Database } from "bun:sqlite";
import type { Attention } from "../../shared/thread";
import { currentAccount } from "./accountLease";
import { parseLimits } from "./accounts";
import type { UsageLimit } from "./accountUsage";
import { specFor } from "./agents";
import type { CodexView } from "./codexPoller";
import { getAccountUsage, leaseHistory, type SessionAttentionRow, type SessionRow } from "./db";
import { storedRuntime } from "./sessions";
import type { ThreadStore } from "./threadStore";

/** The Settled and Snoozed shelves of the inbox. The state is one `session_attention` row per session; the Inbox
 *  (sessionInbox.ts) writes it and lays it over the attention a session has on its own.
 *  - Settled: by hand, or automatically without activity: after AUTO_SETTLE_SEEN_IDLE_MS when there is nothing left
 *    to see (idle), after AUTO_SETTLE_IDLE_MS otherwise (an unseen completion or failure). A new run, a request or a
 *    failure unsettles.
 *  - Snoozed: until a time, or until the session's active usage limit resets. Only a request or a failure wakes it
 *    early; its completions are silent (AgentEventHub.sweep). */
export const AUTO_SETTLE_IDLE_MS = 7 * 86_400_000;
export const AUTO_SETTLE_SEEN_IDLE_MS = 86_400_000;
export const AUTO_SETTLE_TICK_MS = 10 * 60_000;
/** The most sessions one tick settles (and so ends): an end backs up and removes a container. */
export const AUTO_END_PER_TICK = 2;

/** What the AgentEventHub reports for the shelves: a new run (prompt), a request (question, approval), a failure. */
export type Activity = "run" | "request" | "failure";

/** Settling or snoozing a session that waits for the user would hide the question it asks. */
export const REQUEST_OPEN = "Answer the open request first: a session waiting for you cannot be settled or snoozed";
/** Settling ends the session: one whose agent works or waits for an answer is settled only once the owner confirms. */
export const SETTLE_WORKING = "The agent is still working. End it?";
export const SETTLE_REQUEST_OPEN = "The agent is waiting for your answer. End it?";

/** The AgentEventHub's shelf deps over the inbox. Neither may fail the hook or bridge event it is called from:
 *  - an unsettle/wake that cannot be written is logged; the session stays on its shelf until unsettled (S5-R16),
 *    the hub's own notification still goes out;
 *  - a snooze state that cannot be read counts as not snoozed: the "finished" is sent and the error logged
 *    (S5-R14, fail toward notifying: notifications may not get less reliable). */
export function hubShelfDeps(
  inbox: { activity: (id: string, kind: Activity) => void; snoozed: (id: string) => boolean },
  log: (msg: string) => void,
): { onActivity: (id: string, kind: Activity) => void; snoozed: (id: string) => boolean } {
  return {
    onActivity: (id, kind) => {
      try { inbox.activity(id, kind); }
      catch (e) { log(`inbox shelf of ${id} not updated after ${kind}: ${(e as Error).message}`); }
    },
    snoozed: (id) => {
      try { return inbox.snoozed(id); }
      catch (e) { log(`snooze state of ${id} unreadable, notifying: ${(e as Error).message}`); return false; }
    },
  };
}

export function snoozeActive(row: SessionAttentionRow | null, now: number): boolean {
  return row !== null && row.snooze_until !== null && row.snooze_until > now;
}

/** The session's attention with its shelf laid over it: an active snooze, else settled, else unchanged. */
export function shelve(base: Attention, row: SessionAttentionRow | null, now: number): Attention {
  if (row !== null && snoozeActive(row, now)) return { ...base, section: "snoozed", until: row.snooze_until! };
  if (row?.settled_at != null) return { ...base, section: "settled" };
  return base;
}

/** The owner's last look at a session (`seenAt`, null = never) and whether its idle attention can be trusted
 *  (`stateKnown`): a tmux session's is not without live state (absent or unknown after a devd restart), when a
 *  finish may have been missed. Always true for chat. */
export interface SettleLook { seenAt: number | null; stateKnown: boolean }

/** Auto-settle, which ends the session: nothing has happened for AUTO_SETTLE_SEEN_IDLE_MS when the session is idle,
 *  was seen and its state is known, else for AUTO_SETTLE_IDLE_MS (the attention's own time, the session's last prompt
 *  and creation, the owner's last look and the shelf's last change all count: a session must not drop off the list
 *  right after it was opened), and nothing blocks it: a pending request, an active run or holding work (both
 *  "working"), a snooze, or an end already pending. A session settled before settles ended (settled, no end pending)
 *  is due like any other, its clock starting at the migration that stamped its updated_at. */
export function autoSettleDue(base: Attention, s: SessionRow, row: SessionAttentionRow | null, look: SettleLook, now: number): boolean {
  if (row?.end_at != null || snoozeActive(row, now)) return false;
  if (base.section === "working" || base.reason === "request") return false;
  const seenIdle = base.section === "idle" && look.seenAt !== null && look.stateKnown;
  const quietFor = seenIdle ? AUTO_SETTLE_SEEN_IDLE_MS : AUTO_SETTLE_IDLE_MS;
  const lastActivity = Math.max(base.since, s.last_active_at, s.created_at, ...(look.seenAt === null ? [] : [look.seenAt]), ...(row === null ? [] : [row.updated_at]));
  return now - lastActivity >= quietFor;
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

/** ResetDeps over devd's records. Claude: the session's newest devbox lease, which the bridge launch (account-lease,
 *  client=devbox) and chat switches (ChatSwitch) write as for tmux sessions. Codex: the account the chat thread
 *  recorded; devd does not track a tmux session's (codexSessionAccounts probes the container for it). */
export function resetDeps(d: {
  db: Database;
  threads: (id: string) => ThreadStore;
  codexAccounts: { list(): { accounts: { id: string; usage: CodexView | null }[] } };
}): ResetDeps {
  return {
    claudeAccount: (id) => currentAccount(leaseHistory(d.db, "devbox", id)),
    claudeLimits: (account) => { const u = getAccountUsage(d.db, account); return u ? parseLimits(u.limits_json) : null; },
    codexAccount: (s) => {
      if (storedRuntime(s) !== "chat") return null;
      const n = d.threads(s.id).snapshot({ limit: 0 }).native;
      return n?.harness === "codex" ? n.account : null;
    },
    codexUsage: (account) => d.codexAccounts.list().accounts.find((a) => a.id === account)?.usage ?? null,
  };
}
