import type { Database } from "bun:sqlite";
import { specFor } from "./agents";
import {
  deleteAgentLiveState, getAgentLiveState, insertNotifyLog, insertWorkInterval, lastMetricTs, logEvent, updateSession,
  upsertAgentLiveState, type AgentName, type NotifyDecision, type SessionRow,
} from "./db";

export interface NotifySession { id: string; project: string; repo: string; agent?: AgentName; name?: string | null }
/** Where a notification leads after a tap when it does not belong to a session: a dashboard
 *  page (Pushover URL) or a screen in the iOS app (APNs `target`/`targetId`). */
export type NotifyTargetKind = "prodWrites" | "sshApprovals" | "schedules" | "subscriptions" | "vault";
export interface NotifyTarget { kind: NotifyTargetKind; id?: string }
/** `blocked`: the alert wants something from a human (approval, unlock) — APNs category
 *  "blocked" regardless of the text (see categoryFor in pushChannel.ts). */
export interface NotifyExtra { sound?: boolean; session?: NotifySession; important?: boolean; target?: NotifyTarget; blocked?: boolean }
export type NotifyFn = (title: string, message: string, extra?: NotifyExtra) => void;

export type AgentEvent =
  | "tool_start" | "tool_complete" | "stop_failure" | "interrupted"
  | "stop" | "user_prompt_submit" | "permission_request" | "notification"
  | "subagent_start" | "subagent_stop" | "teammate_idle" | "task_created" | "task_completed";
export const AGENT_EVENTS: AgentEvent[] = [
  "tool_start", "tool_complete", "stop_failure", "interrupted",
  "stop", "user_prompt_submit", "permission_request", "notification",
  "subagent_start", "subagent_stop", "teammate_idle", "task_created", "task_completed",
];
export type BlockedKind = "permission" | "input";

// `Notification` hook types that REALLY mean "the agent is stopped and waiting for a human".
// The list of all types and the conditions under which they arise were read out of the
// Claude Code 2.1.238 binary (`notificationType:` in mN(...) calls):
//
//   BLOCKING:   permission_prompt / worker_permission_prompt ("needs permission…" —
//               already caught by the substring "permission" above), elicitation_dialog and
//               elicitation_url_dialog ("Claude Code needs your input"),
//               agent_needs_input ("<label> needs your input", band === "blocked"),
//               quota_auto_resume_stale ("Usage limit reset — press enter to continue").
//   INFORMATIONAL: idle_prompt, auth_success, agent_completed, computer_use_enter/_exit,
//               quota_auto_resume_fired/_disabled, push_notification,
//               elicitation_response, elicitation_complete.
//
// `idle_prompt` is the most treacherous item: the text says "Claude is waiting for your
// input", but the condition is purely REPL inactivity (`Date.now() - lastActivity >=
// messageIdleNotifThresholdMs`) and among its terms is `open.length === 0`, i.e.
// "no dialog is open". Real questions (picker, elicitation, permission) therefore
// NEVER trigger idle_prompt — and conversely: work running in the background does not block it,
// so it fires even over a session parked on a background agent. As a blocking signal
// it is therefore useless in both directions.
//
// Allowlist, not denylist: cc keeps ADDING informational types (elicitation_response
// and elicitation_complete are already in the binary, not yet in the type list), so a denylist would
// slowly drift into noise. The cost is the opposite — a new blocking type would be suppressed —
// but not blindly: it is written to notify_log with `reason = non-blocking-type` and the type in
// `detail`, so it can be flagged on /notifications as a missing notification.
const BLOCKING_NOTIFICATIONS = new Set([
  "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input", "quota_auto_resume_stale",
]);

// Optional fields that devd-hook.sh extracts from the hook stdin. `agentSessionId` is the
// session_id of that particular agent loop — that is how a teammate is told from the main agent.
export interface HookMeta {
  notificationType?: string; agentSessionId?: string; agentType?: string;
  taskId?: string; taskSubject?: string; teammateName?: string; teamName?: string;
  // The full prompt text (only on user_prompt_submit). Only the first 200 characters go to notify_log
  // (see detailJson) — the critic however gets this untruncated text directly from api.ts.
  prompt?: string;
  toolName?: string; toolCallId?: string; promptId?: string;
  // The question text (only tool_start of a question tool) — the reason for waiting in the Live Activity.
  question?: string;
  // Number of subagent/cloud session items in `background_tasks` from the Stop payload (devd-hook.sh
  // has already filtered them to running/pending). `teammate` is DELIBERATELY NOT among them — its items
  // in `background_tasks` never disappear (live test 23→24, see spec), so a session with a
  // teammate would never get "finished" again. Teammates are tracked by the `inflight` counter, so
  // the `stop` branch MERGES the signals (busy = backgroundTasks>0 OR inflight>0), does not prioritize.
  // `undefined` = the field is missing in stdin (older Claude Code) — that must stay distinguishable
  // from 0, because it contributes to the union with zero, not with "don't know".
  backgroundTasks?: number;
}

// The detail in notify_log shows only the first 200 characters of the prompt, and only on the turn divider
// user_prompt_submit — on other events the prompt is usually not even in meta (devd-hook.sh
// sends it only there), but if it were, it does not belong in the log.
const PROMPT_DETAIL_MAX = 200;

// Cap per interval: a session left open overnight would otherwise turn one prompt into
// a nine-hour shift. Truncated intervals are marked, so one can tell
// how much of the result is measurement and how much is estimate.
const MAX_INTERVAL_MS = 30 * 60_000;

// Agent name in the notification text: comfort parity with Claude means a Codex session
// reports "Codex", not a hardcoded "Claude" (SessionRow.agent carries it since handle()).
// `specFor(...).short`, not `.label` — notifications have an established text ("Claude finished
// working"), see agents.ts. `specFor` itself falls back to claude for an unknown/missing
// value too — `s.agent` comes from the DB as a plain string, so a custom table
// indexed directly by that value (as before) would return `undefined` on an unknown profile
// and send it straight into a sentence the user reads.

// Notification title. With several sessions over one repo "portal/web" is the same twice
// and you cannot tell which one is calling you — so the nickname is appended when the session has one.
export function sessionTitle(s: NotifySession): string {
  return s.name ? `${s.project}/${s.repo} · ${s.name}` : `${s.project}/${s.repo}`;
}

export function doneText(s: NotifySession): { title: string; message: string } {
  return { title: sessionTitle(s), message: `${specFor(s.agent).short} finished working` };
}

export function blockedText(s: NotifySession, kind: BlockedKind): { title: string; message: string } {
  const who = specFor(s.agent).short;
  return {
    title: sessionTitle(s),
    message: kind === "permission" ? `${who} is waiting for permission` : `${who} is waiting for input`,
  };
}

export function stuckText(s: NotifySession): { title: string; message: string } {
  return { title: sessionTitle(s), message: `${specFor(s.agent).short} may be stuck — 20 min of silence while working` };
}

export type LiveAgentStatus = "working" | "waiting" | "done" | "failed" | "unknown" | "stalled";
/** `statusSince` = the last state TRANSITION (not the last hook); `reason` = why it waits, otherwise null. */
export interface AgentLiveSnapshot {
  status: LiveAgentStatus; body: string; reason: string | null;
  startedAt: number; updatedAt: number; statusSince: number;
}

// A working agent from which no hook or metric has arrived for this long is reported in the Live Activity
// as "May be stuck". The "may be stuck" notification (index.ts) stays at STUCK_MS —
// the state may be wrong and correct itself, an emergency push ringing for an hour may not. Both count silence
// the same way: `silentMs`.
// But if an open call or a background task is running, silence is normal: the devbox runs
// agents without asking (skip-permissions), so a long build/tests/monitor sends no
// hooks or metrics (see DEVBOX-3 in index.ts). Then only STUCK_MS applies.
export const STALLED_MS = 180_000;
export const STUCK_MS = 20 * 60_000;
// The `inflight` counter without a single Subagent event for this long = a lost SubagentStop. Previously
// such a turn silenced "finished" until the next prompt; now it is reset after 10 min.
const INFLIGHT_STALE_MS = 10 * 60_000;
const REASON_MAX = 140;
const QUESTION_TOOLS = ["AskUserQuestion", "request_user_input", "request_user_input_async", "ask_user", "ask_user_question", "askUser"];
// Running calls are kept only to distinguish "a concurrent call older than the question" —
// capped, so lost PostToolUse events do not bloat memory.
const OPEN_CALLS_MAX = 64;
const GENERIC_REASON = "Waiting for a reply";

/** Single-line text for `reason`, at most REASON_MAX characters (counted in characters, not UTF-16). */
function clipReason(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= REASON_MAX ? chars.join("") : chars.slice(0, REASON_MAX - 1).join("") + "…";
}

interface Wait {
  owner: string | null; tool: string | null; call: string | null; reason: string;
  // Calls that were already running at the moment the agent started waiting: their completion is no
  // proof the agent moved on (a parallel Read finishes while Bash waits for permission).
  before: Set<string>;
}

interface SessionState {
  live: AgentLiveSnapshot;
  waits: Map<string, Wait>;
  openCalls: Set<string>;
  promptId: string | null; completionAllowed: boolean;
  session: NotifySession;
  important: boolean;
  pendingDoneAt: number | null;
  lastBlockedAt: number;
  lastHookAt: number;
  lastStopAt: number;
  lastPromptAt: number;
  inflight: number;              // SubagentStart − SubagentStop in the current turn
  lastSubagentAt: number;        // last sign of life of a subagent/teammate (Subagent event or a hook from another loop)
  stalled: boolean;              // the last silence evaluation gave "stalled" (for statusSince after recovery)
  deferredStopAt: number | null; // stop deferred ONLY because of the inflight counter
  teammates: number;             // open TEAM tasks; only context for the log
  mainAgentSessionId: string | null; // session_id of the main loop from the last prompt
  lastBackgroundTasks: number | undefined; // last value from `stop`; undefined = unknown
}

export interface HubDeps {
  db: Database;
  notify: NotifyFn;
  now?: () => number;
  quietMs?: number;     // silence after Stop before "finished" goes out
  coalesceMs?: number;  // min. spacing of two blocking notifications of the same session
}

// Translates Claude hook events (POST /api/agent-event) into notifications. The state
// machine keeps per-session state only in memory — after a devd restart it starts from zero,
// which at worst means one extra notification, never a lost blocking alert (see tests).
export class AgentEventHub {
  private state = new Map<string, SessionState>();
  private ssh = new Map<string, { label: string; since: number }>();
  constructor(private d: HubDeps) {}

  private now() { return this.d.now?.() ?? Date.now(); }

  lastHookTs(sessionId: string): number | null {
    return this.state.get(sessionId)?.lastHookAt ?? null;
  }

  /** When the agent last finished a turn (the `stop` hook). Used to compute how long
   *  it then waited for the user. 0 = this session has had no stop since the devd restart,
   *  we return null — better not to record the metric than to record a made-up number. */
  lastStopTs(sessionId: string): number | null {
    const at = this.state.get(sessionId)?.lastStopAt ?? 0;
    return at > 0 ? at : null;
  }

  // Current counter values for the given session. Used by callers outside the hub (api.ts when
  // writing a suppressed/critic-block row), so the log carries the real state instead of a hard-coded zero.
  // Without state (the session has not sent any hook yet) it is 0/0 — that is a true value anyway.
  counters(sessionId: string): { inflight: number; teammates: number } {
    const st = this.state.get(sessionId);
    return { inflight: st?.inflight ?? 0, teammates: st?.teammates ?? 0 };
  }

  /** How long the session has been silent: since the last hook OR metric (token generation), whichever
   *  came later. null = no hook since the devd restart (we know nothing about the silence). */
  silentMs(sessionId: string): number | null {
    const st = this.state.get(sessionId);
    if (!st) return null;
    return this.now() - Math.max(st.lastHookAt, lastMetricTs(this.d.db, sessionId) ?? 0);
  }

  /** An unapproved SSH key blocks the agent just like a question. api.ts calls this when the
   *  request is created and with `null` after the decision; expiry is cleaned up by a periodic tick in index.ts.
   *  It overlays the state from hooks, does not change it — `null` restores what applied before. */
  setSshWaiting(sessionId: string, label: string | null): void {
    if (label === null) { this.ssh.delete(sessionId); return; }
    if (this.ssh.get(sessionId)?.label === label) return; // the tick must not move statusSince
    this.ssh.set(sessionId, { label, since: this.now() });
  }

  private freshState(session: NotifySession, important: boolean, live: AgentLiveSnapshot): SessionState {
    return {
      live, waits: new Map(), openCalls: new Set(), promptId: null, completionAllowed: true,
      session, important, pendingDoneAt: null, lastBlockedAt: 0, lastHookAt: 0, lastStopAt: 0, lastPromptAt: 0,
      inflight: 0, lastSubagentAt: 0, stalled: false, deferredStopAt: null, teammates: 0, mainAgentSessionId: null, lastBackgroundTasks: undefined,
    };
  }

  // index.ts calls this ONCE after start, for `sessions` rows with status='running' — ended
  // sessions are ignored (their row in agent_live_state, if it still exists, is
  // irrelevant). `working`/`waiting` MUST NOT be restored: the whole state machine (waits,
  // counters, openCalls…) from which that state arose was wiped by the devd restart, so the hub would
  // keep pretending a block or work it knows nothing about. `done`/`failed` do not depend on in-memory
  // state (sweep/stop_failure write them as final), so they are restored
  // unchanged. The first real hook after the restart overwrites the state normally — see `handle()`.
  loadPersisted(sessions: SessionRow[]): void {
    const now = this.now();
    for (const s of sessions) {
      if (s.status !== "running" || this.state.has(s.id)) continue;
      const row = getAgentLiveState(this.d.db, s.id);
      if (!row) continue;
      const session: NotifySession = { id: s.id, project: s.project, repo: s.repo, agent: s.agent, name: s.name };
      const live: AgentLiveSnapshot = row.status === "working" || row.status === "waiting"
        ? { status: "unknown", body: "Waiting for agent status", reason: null, startedAt: row.started_at, updatedAt: now, statusSince: now }
        : {
            status: row.status as LiveAgentStatus, body: row.body, reason: row.reason,
            startedAt: row.started_at, updatedAt: row.updated_at, statusSince: row.status_since,
          };
      this.state.set(s.id, this.freshState(session, s.important === 1, live));
    }
  }

  /** No persisted heuristic may resurrect a working state after daemon restart. */
  liveSnapshot(sessionId: string): AgentLiveSnapshot | null {
    const st = this.state.get(sessionId);
    const stalledSince = st ? this.stallCheck(sessionId, st) : null;
    let snap: AgentLiveSnapshot | null = st ? { ...st.live } : null;
    if (snap && stalledSince !== null)
      snap = { ...snap, status: "stalled", body: "May be stuck", reason: null, statusSince: stalledSince };
    const ssh = this.ssh.get(sessionId);
    if (ssh) {
      const base: AgentLiveSnapshot = snap
        ?? { status: "unknown", body: "", reason: null, startedAt: ssh.since, updatedAt: ssh.since, statusSince: ssh.since };
      snap = {
        ...base, status: "waiting", body: "Waiting for SSH key approval",
        reason: clipReason(`Approve SSH key: ${ssh.label}`),
        statusSince: base.status === "waiting" ? base.statusSince : ssh.since,
        updatedAt: Math.max(base.updatedAt, ssh.since),
      };
    }
    return snap;
  }

  /** Silence during work is uncertainty, never a made-up completion. Returns since when the session
   *  "may be stuck", otherwise null. `stalled` is not stored as state (it is computed from time), so
   *  the hub remembers here that it saw it — recovery then moves statusSince to the moment of recovery.
   *  The metric is only read when the hooks are silent too; the snapshot is computed on every tick. */
  private stallCheck(sessionId: string, st: SessionState): number | null {
    const now = this.now();
    let since: number | null = null;
    if (st.live.status === "working") {
      const busy = st.openCalls.size > 0 || (st.lastBackgroundTasks ?? 0) > 0;
      const limit = busy ? STUCK_MS : STALLED_MS;
      if (now - st.lastHookAt > limit) {
        const lastSign = Math.max(st.lastHookAt, lastMetricTs(this.d.db, sessionId) ?? 0);
        if (now - lastSign > limit) since = lastSign + limit;
      }
    }
    if (since !== null) st.stalled = true;
    else if (st.stalled) {
      st.stalled = false;
      if (st.live.status === "working") st.live = { ...st.live, statusSince: now };
    }
    return since;
  }

  // Writes TO THE DB only on a TRANSITION (the status changes) — not on every hook. Reading
  // after a restart (loadPersisted) thus gets exactly what `liveSnapshot` would have returned
  // just before the crash, without having to write on every hook (the live DB has expensive writes).
  private live(st: SessionState, status: LiveAgentStatus, body: string, at: number, reason: string | null = null): void {
    const changed = status !== st.live.status;
    const statusSince = changed ? at : st.live.statusSince;
    st.live = { ...st.live, status, body, reason, updatedAt: at, statusSince };
    if (changed) this.persist(st);
  }

  private persist(st: SessionState): void {
    upsertAgentLiveState(this.d.db, {
      session_id: st.session.id, status: st.live.status, body: st.live.body, reason: st.live.reason,
      started_at: st.live.startedAt, updated_at: st.live.updatedAt, status_since: st.live.statusSince,
    });
  }

  forget(sessionId: string): void {
    this.state.delete(sessionId); this.ssh.delete(sessionId);
    deleteAgentLiveState(this.d.db, sessionId);
  }

  // Forgets the state of sessions that are no longer running, so sweep() cannot send a late
  // "finished" after a finished session and the in-memory map does not grow without bound. Called
  // periodically by index.ts with the set of running session ids. Also deletes the persisted row —
  // otherwise an orphaned record of a deleted session would stay in agent_live_state forever.
  retainRunning(runningIds: Set<string>): void {
    for (const id of this.state.keys()) {
      if (runningIds.has(id)) continue;
      this.state.delete(id);
      deleteAgentLiveState(this.d.db, id);
    }
    for (const id of this.ssh.keys()) if (!runningIds.has(id)) this.ssh.delete(id);
  }

  // "Turn in progress" must have ONE definition in the whole class — two different ones caused the original
  // bug. The same union as in the `stop` branch: work is in progress as long as any of the
  // signals claims so. A `cloud session` is never reflected in the counter, so `inflight` alone is not enough here.
  turnInProgress(sessionId: string): boolean {
    const st = this.state.get(sessionId);
    if (!st) return false;
    const bgBusy = st.lastBackgroundTasks !== undefined && st.lastBackgroundTasks > 0;
    return st.lastPromptAt > st.lastStopAt || bgBusy || st.inflight > 0;
  }

  handle(s: SessionRow, event: AgentEvent, meta: HookMeta = {}): void {
    const now = this.now();
    const session = { id: s.id, project: s.project, repo: s.repo, agent: s.agent, name: s.name };
    let st = this.state.get(s.id);
    if (!st) {
      st = this.freshState(session, s.important === 1,
        { status: "unknown", body: "Waiting for agent status", reason: null, startedAt: now, updatedAt: now, statusSince: now });
      this.state.set(s.id, st);
    }
    st.session = session;
    st.important = s.important === 1; // reflects the current flag (it may have been toggled from the dashboard)
    this.stallCheck(s.id, st); // still with the old lastHookAt: a hook after silence = recovery
    st.lastHookAt = now;

    const log = (decision: NotifyDecision, reason?: string) => {
      insertNotifyLog(this.d.db, {
        ts: now, session_id: s.id, event, decision, reason: reason ?? null,
        inflight: st!.inflight, teammates: st!.teammates,
        agent_session_id: meta.agentSessionId ?? null, detail: detailJson(meta, event),
      });
    };

    const foreign = st.mainAgentSessionId !== null && meta.agentSessionId !== undefined
      && meta.agentSessionId !== st.mainAgentSessionId;
    // A teammate/subagent sends tool hooks under its own session_id even long without a Subagent
    // event — that too is proof the `inflight` counter is not stuck.
    if (foreign) st.lastSubagentAt = now;
    if (!foreign && event !== "user_prompt_submit" && st.promptId && meta.promptId && st.promptId !== meta.promptId) {
      log("suppressed", "stale-prompt");
      return;
    }
    const tool = (meta.toolName ?? "").split(/__|[.:/]/).at(-1) ?? "";
    const ownsWait = (wait: { owner: string | null }) =>
      (!foreign && wait.owner === null) || (meta.agentSessionId !== undefined && wait.owner === meta.agentSessionId);
    const wait = (reason: string) => {
      const owner = meta.agentSessionId ?? null;
      const call = meta.toolCallId ?? null;
      const key = JSON.stringify([owner, call ?? (tool || null)]);
      // A generic reason from a later Notification does not overwrite the specific reason of the same wait.
      const prev = st!.waits.get(key)?.reason;
      if (prev && prev !== GENERIC_REASON && reason === GENERIC_REASON) reason = prev;
      st!.waits.set(key, { owner, tool: tool || null, call, reason, before: new Set(st!.openCalls) });
      st!.completionAllowed = true;
    };
    const resume = () => {
      st!.pendingDoneAt = null;
      st!.waits.clear();
      st!.completionAllowed = true;
      this.live(st!, "working", "Agent is working", now);
    };
    // The hook concerns THE SAME call that is being waited on (without a call id the tool name decides).
    const sameCall = (w: Wait) => w.call !== null ? w.call === meta.toolCallId
      : (!w.tool || w.tool === tool) && !meta.toolCallId;
    // The hook carries a different, NEWER call than the waiting one → the agent moved on, it is
    // no longer waiting for a human. Without a call id and tool name this cannot be told.
    const laterCall = (w: Wait) => {
      if (meta.toolCallId) return !sameCall(w) && !w.before.has(meta.toolCallId);
      return tool !== "" && w.tool !== null && w.tool !== tool;
    };
    const settle = (wasWaiting: boolean) => {
      // Each blocked child/tool has to resume independently; unrelated progress never wins.
      if (st!.waits.size === 0) { if (wasWaiting || !foreign) resume(); return; }
      st!.live = { ...st!.live, reason: waitReason(st!) };
    };
    const resolveWait = (notification = false) => {
      const wasWaiting = st!.waits.size > 0;
      for (const [key, value] of st!.waits) {
        if (!ownsWait(value)) continue;
        if (notification || laterCall(value)) { st!.waits.delete(key); continue; }
        // Async question completion only acknowledges display, not the user's answer.
        if (value.tool === "request_user_input_async") continue;
        if ((!value.tool || value.tool === tool) && (!value.call || value.call === meta.toolCallId)) st!.waits.delete(key);
      }
      settle(wasWaiting);
    };
    switch (event) {
      case "tool_start": {
        if (QUESTION_TOOLS.includes(tool)) {
          const q = meta.question?.trim();
          wait(q ? clipReason(q) : GENERIC_REASON);
          this.blocked(st, "input", now, log);
          return;
        }
        if (meta.toolCallId) {
          st.openCalls.add(meta.toolCallId);
          if (st.openCalls.size > OPEN_CALLS_MAX) st.openCalls.delete(st.openCalls.values().next().value!);
        }
        if (st.waits.size > 0) {
          // The agent started another call — it is no longer waiting for an answer. Exception: a permission
          // for THIS call (Codex may send PermissionRequest before PreToolUse).
          for (const [key, value] of st.waits) if (ownsWait(value) && !sameCall(value)) st.waits.delete(key);
          settle(true);
        } else if (!foreign && st.live.status !== "waiting") resume();
        log("none");
        return;
      }
      case "tool_complete":
        if (meta.toolCallId) st.openCalls.delete(meta.toolCallId);
        // A child's progress cannot clear a human wait owned by another loop.
        if (st.completionAllowed) resolveWait();
        log("none");
        return;
      case "stop_failure":
      case "interrupted":
        // A leaked call (tool_complete missing) must not hold the STUCK_MS threshold until the end of the turn.
        if (!foreign) st.openCalls.clear();
        if (!foreign && !(event === "interrupted" && ["done", "failed"].includes(st.live.status))) {
          st.pendingDoneAt = null;
          st.deferredStopAt = null;
          st.waits.clear();
          st.completionAllowed = false;
          this.live(st, event === "stop_failure" ? "failed" : "unknown",
            event === "stop_failure" ? "Agent failed" : "Work was interrupted", now);
        }
        log("none");
        return;
      case "user_prompt_submit": {
        const coalesced = st.pendingDoneAt !== null;
        st.live.startedAt = now;
        st.promptId = meta.promptId ?? null;
        resume();
        st.lastPromptAt = now;
        st.pendingDoneAt = null;
        // A new turn = a clean slate: a lost SubagentStop must not silence notifications forever.
        st.inflight = 0;
        st.deferredStopAt = null;
        st.openCalls.clear();
        st.teammates = 0;
        st.lastBackgroundTasks = undefined;
        if (meta.agentSessionId) st.mainAgentSessionId = meta.agentSessionId;
        updateSession(this.d.db, s.id, { last_active_at: now });
        log("none", coalesced ? "coalesced" : undefined);
        return;
      }
      case "subagent_start":
        st.inflight += 1;
        st.lastSubagentAt = now;
        st.pendingDoneAt = null;
        if (st.live.status !== "waiting") this.live(st, "working", "A subagent is working too", now);
        log("none");
        return;
      case "subagent_stop": {
        const underflow = st.inflight === 0;
        st.inflight = Math.max(0, st.inflight - 1);
        st.lastSubagentAt = now;
        log("none", underflow ? "counter-underflow" : undefined);
        return;
      }
      case "task_created":
        if (meta.teammateName) st.teammates += 1;
        log("none");
        return;
      case "task_completed":
        if (meta.teammateName) st.teammates = Math.max(0, st.teammates - 1);
        log("none");
        return;
      case "teammate_idle":
        log("none");
        return;
      case "stop": {
        // Another loop (teammate/subagent) MUST NOT end the main agent's turn — otherwise
        // "finished" would be armed in the middle of work and `turnInProgress` would report calm.
        if (st.mainAgentSessionId !== null && meta.agentSessionId !== undefined
            && meta.agentSessionId !== st.mainAgentSessionId) {
          log("deferred", "foreign-session");
          return;
        }
        // A stop is not an answer to an explicit permission/input request.
        if (st.live.status === "waiting") { log("deferred", "waiting-for-user"); return; }
        st.completionAllowed = false;
        st.openCalls.clear(); // end of the turn: no call is running anymore
        this.live(st, "working", "Finishing and verifying the result", now);
        st.lastStopAt = now;
        st.lastBackgroundTasks = meta.backgroundTasks;
        st.deferredStopAt = null;
        this.dropStaleInflight(st, now, "stop", meta.agentSessionId ?? null);

        // `background_tasks` (subagent/cloud session only) and the `inflight` counter (subagent/
        // teammate) are TWO INCOMPLETE signals, neither is enough on its own: `backgroundTasks`
        // does not see teammates (their items in the array never disappear, see spec, "Verified
        // by experiment"), the counter in turn does not see cloud sessions. Busy is therefore the UNION —
        // calm requires calm from both — not one signal overriding the other. The cost: a lost
        // SubagentStop can silence a turn just as before (see spec, "Accepted cost");
        // we take that as a better compromise than a missing notification for every teammate session.
        const bg = meta.backgroundTasks;
        const bgBusy = bg !== undefined && bg > 0;
        const counterBusy = st.inflight > 0;
        if (bg !== undefined && bgBusy !== counterBusy) {
          // Disagreement of two independent signals — write a SEPARATE row so it can be
          // filtered in the dashboard, and right BEFORE the decision row (id grows, the time is the same).
          insertNotifyLog(this.d.db, {
            ts: now, session_id: s.id, event, decision: "none", reason: "counter-mismatch",
            inflight: st.inflight, teammates: st.teammates,
            agent_session_id: meta.agentSessionId ?? null,
            detail: JSON.stringify({ backgroundTasks: bg, inflight: st.inflight }),
          });
        }
        if (bgBusy || counterBusy) {
          // Only the counter holds the turn → sweep finishes it if the SubagentStop got lost.
          if (!bgBusy) st.deferredStopAt = now;
          log("deferred", bgBusy ? "busy-background-tasks" : "busy-subagents");
          return;
        }
        this.finishTurn(st, now, now);
        log("armed", st.mainAgentSessionId === null ? "unknown-main-id" : undefined);
        return;
      }
      case "permission_request":
        wait(tool ? `Allow: ${tool}` : GENERIC_REASON);
        this.blocked(st, "permission", now, log);
        return;
      case "notification": {
        const nt = meta.notificationType ?? "";
        if (["elicitation_response", "elicitation_complete", "quota_auto_resume_fired"].includes(nt)) {
          resolveWait(true);
          log("none");
          return;
        }
        if (nt.includes("permission")) {
          wait(tool ? `Allow: ${tool}` : GENERIC_REASON);
          this.blocked(st, "permission", now, log);
          return;
        }
        // The TYPE decides, not the timing. Previously every type without "permission"
        // in its name was notified and blocking was guessed from whether the last Stop came after
        // the prompt — but that is a guess over a signal that does not carry blocking at all.
        if (!BLOCKING_NOTIFICATIONS.has(nt)) { log("suppressed", "non-blocking-type"); return; }
        wait(GENERIC_REASON);
        this.blocked(st, "input", now, log);
        return;
      }
    }
  }

  // index.ts calls this every ~5 s: fires "finished" once the quiet window has elapsed.
  // Returns the ids of sessions for which "finished" went out in this tick — the auto-end of
  // scheduled runs (autoEnd.ts) hooks onto that moment. The hub thus stays without a dependency
  // on SessionManager and the caller does not have to handle the quiet window, other loops or
  // turns deferred because of running subagents again; all of that is already resolved in `handle`.
  sweep(): string[] {
    const now = this.now();
    const done: string[] = [];
    for (const [id, st] of this.state) {
      // A stop deferred because of a subagent whose SubagentStop got lost: after INFLIGHT_STALE_MS
      // without a Subagent event, finish the turn, otherwise "finished" would wait for the next prompt.
      if (st.deferredStopAt !== null && st.live.status !== "waiting"
          && this.dropStaleInflight(st, now, "sweep_stale_inflight", null)) {
        this.finishTurn(st, st.deferredStopAt, now);
        insertNotifyLog(this.d.db, {
          ts: now, session_id: id, event: "sweep_stale_inflight", decision: "armed", reason: null,
          inflight: st.inflight, teammates: st.teammates, agent_session_id: null, detail: null,
        });
      }
      if (st.pendingDoneAt === null || now < st.pendingDoneAt) continue;
      st.pendingDoneAt = null;
      this.live(st, "done", "Work finished", now);
      done.push(id);
      const t = doneText(st.session);
      this.d.notify(t.title, t.message, { session: st.session, important: st.important });
      logEvent(this.d.db, id, "agent_done", { project: st.session.project, repo: st.session.repo, at: now, via: "hook" });
      insertNotifyLog(this.d.db, {
        ts: now, session_id: id, event: "sweep_done", decision: "sent", reason: null,
        inflight: st.inflight, teammates: st.teammates, agent_session_id: null, detail: null,
      });
    }
    return done;
  }

  /** Resets the `inflight` counter when INFLIGHT_STALE_MS has passed since the last Subagent event
   *  (a lost SubagentStop). Writes it to notify_log; returns whether the reset happened. */
  private dropStaleInflight(st: SessionState, now: number, event: string, agentSessionId: string | null): boolean {
    if (st.inflight === 0 || now - st.lastSubagentAt < INFLIGHT_STALE_MS) return false;
    insertNotifyLog(this.d.db, {
      ts: now, session_id: st.session.id, event, decision: "none", reason: "inflight-stale",
      inflight: st.inflight, teammates: st.teammates, agent_session_id: agentSessionId,
      detail: JSON.stringify({ lastSubagentAt: st.lastSubagentAt }),
    });
    st.inflight = 0;
    return true;
  }

  // The turn ended (`endedAt`) → record the worked interval and arm "finished". The interval
  // is not written in sweep() after the quiet window — it would be inflated by that delay.
  private finishTurn(st: SessionState, endedAt: number, now: number): void {
    st.deferredStopAt = null;
    if (st.lastPromptAt > 0) {
      const raw = endedAt - st.lastPromptAt;
      insertWorkInterval(this.d.db, {
        session_id: st.session.id, project: st.session.project, repo: st.session.repo,
        started_at: st.lastPromptAt, ended_at: endedAt,
        seconds: Math.round(Math.min(raw, MAX_INTERVAL_MS) / 1000),
        capped: raw > MAX_INTERVAL_MS ? 1 : 0,
      });
    }
    st.pendingDoneAt = now + (this.d.quietMs ?? 20_000);
  }

  private blocked(st: SessionState, kind: BlockedKind, now: number, log: (d: NotifyDecision, r?: string) => void): void {
    st.pendingDoneAt = null;
    this.live(st, "waiting", kind === "permission" ? "Waiting for permission" : "Waiting for a reply", now, waitReason(st));
    if (now - st.lastBlockedAt < (this.d.coalesceMs ?? 30_000)) { log("suppressed", "coalesced"); return; }
    st.lastBlockedAt = now;
    const t = blockedText(st.session, kind);
    this.d.notify(t.title, t.message, { sound: true, session: st.session, important: st.important });
    logEvent(this.d.db, st.session.id, "agent_blocked", { kind, at: now });
    log("sent");
  }
}

// The reason for waiting in the Live Activity: the first specific one (a question, "Allow: …") among the open
// waits; a generic one only when there is no other — a later Notification must not override it.
function waitReason(st: SessionState): string {
  for (const w of st.waits.values()) if (w.reason !== GENERIC_REASON) return w.reason;
  return GENERIC_REASON;
}

// Only what has diagnostic value goes to the log — no empty keys, so the
// rows can be read by eye. `prompt` gets special treatment: truncated and only on the prompt
// itself, so the timeline shows what the turn was about without storing the long text.
function detailJson(meta: HookMeta, event: AgentEvent): string | null {
  const d: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(meta)) {
    // The question text lives only in memory (Live Activity) — it does not belong in the DB, just like the prompt.
    if (k === "prompt" || k === "question") continue;
    if (typeof v === "string" && v !== "") d[k] = v;
    // backgroundTasks is a number (not a string) — it goes into the detail whenever present, so
    // the two numbers (against the `inflight` column) can be compared at a glance (see the `stop` branch).
    else if (k === "backgroundTasks" && typeof v === "number") d[k] = v;
  }
  if (event === "user_prompt_submit" && meta.prompt) d.prompt = meta.prompt.slice(0, PROMPT_DETAIL_MAX);
  return Object.keys(d).length ? JSON.stringify(d) : null;
}
