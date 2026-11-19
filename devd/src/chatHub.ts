import type { LinkStatus, LoggedEvent, RequestKind, ThreadSnapshot } from "../../shared/thread";
import type { AgentEventHub, HookMeta } from "./agentEvents";
import { lastEndedRun, type LinkState } from "./attention";
import type { SessionRow } from "./db";

/** The tool name the hub's QUESTION_TOOLS treats as "waiting for input"; questions and plans pose as it. */
const QUESTION_TOOL = "AskUserQuestion";

interface ChatState {
  /** The run whose `stop` was deferred by holding work; its `stop` is re-sent once, when holding drops to 0. */
  heldRun: string | null;
  /** The completed run whose PR read (`prCheck`) is still running; a later run event cancels it. */
  completing: string | null;
  /** Open requests by id, so their resolution can clear the hub's wait for the same call. */
  requests: Map<string, { runId: string; kind: RequestKind }>;
  /** Ids of subagent background work the hub was told about (its `inflight` counter). */
  subagents: Set<string>;
  link: LinkState | null;
  /** The held run and subagents were taken over from the store at the first connect (devd restart). */
  seeded: boolean;
}

const holdingCount = (t: ThreadSnapshot) => t.background.filter((w) => w.holding).length;
const subagentIds = (t: ThreadSnapshot) => new Set(t.background.filter((w) => w.kind === "subagent").map((w) => w.id));

/** Feeds a chat session's bridge events into the AgentEventHub as the hook events a tmux session sends, so
 *  notify_log, Live Activity, stuck detection and notifications keep working. `promptId` is the run id: the hub
 *  then drops events of an older run as stale. State is in memory; what a "done" depends on (a completion held by
 *  background work, running subagents) is taken over from the thread store at the first connect after a restart. */
export class ChatHub {
  private state = new Map<string, ChatState>();
  private unknownLogged = new Set<string>();
  private log: (msg: string) => void;

  constructor(private d: {
    hub: AgentEventHub;
    session: (id: string) => SessionRow | null;
    /** Reads the session's PR now (PrWatch.checkNow), before the completion goes to the hub: the run often pushed
     *  just before, and the hub holds the "finished" while its CI checks are pending (HubDeps.prChecks). */
    prCheck?: (id: string) => Promise<unknown>;
    /** The session's PR row as the PR watch last wrote it (session_prs): a devd restart re-sends a completion it held. */
    prRow?: (id: string) => { checks: string; since: number } | null;
    now?: () => number;
    log?: (msg: string) => void;
  }) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  private stateOf(sessionId: string): ChatState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { heldRun: null, completing: null, requests: new Map(), subagents: new Set(), link: null, seeded: false };
      this.state.set(sessionId, st);
    }
    return st;
  }

  /** `snapshot` is read only at the first `connected` of a session: before the bridge replays what devd missed. */
  onStatus(sessionId: string, status: LinkStatus, snapshot: () => ThreadSnapshot): void {
    const st = this.stateOf(sessionId);
    st.link = { status, since: this.now() };
    if (status !== "connected" || st.seeded) return;
    const t = snapshot(); // a throw leaves the state unseeded, so the next connect tries again
    st.seeded = true;
    const last = lastEndedRun(t);
    const active = t.runs.some((r) => r.endedSeq === null);
    if (!active && last?.status === "completed" && holdingCount(t) > 0) st.heldRun = last.runId;
    const s = this.d.session(sessionId);
    if (!s) {
      this.log(`chat hub: no session ${sessionId} to restore subagents for`);
      return;
    }
    for (const id of subagentIds(t)) this.subagentStart(s, st, id);
    // A "finished" the hub held for CI died with the old devd (its quiet window is in memory). Unseen, still held by
    // notify_log's record (deferred for pr-checks, never sent or silenced since) and its PR still pending or changed
    // since the run ended: send the completion again, marked as held, so the sweep holds, releases or silences it.
    if (!active && last?.status === "completed" && holdingCount(t) === 0 && this.d.prRow
        && last.endedSeq !== null && last.endedAt !== null && t.seenSeq < last.endedSeq
        && this.d.hub.heldForPr(sessionId, last.endedAt)) {
      const row = this.d.prRow(sessionId);
      if (row && (row.checks === "pending" || row.since >= last.endedAt)) {
        this.d.hub.handle(s, "stop", { promptId: last.runId, backgroundTasks: 0 });
        this.d.hub.resumePrHold(sessionId);
      }
    }
  }

  /** The link while the session runs; null when it does not (devd dropped the link on purpose) or before the
   *  link reported any status. */
  link(sessionId: string): LinkState | null {
    if (this.d.session(sessionId)?.status !== "running") return null;
    return this.state.get(sessionId)?.link ?? null;
  }

  /** The session stopped or ended: its next link starts from the store again. */
  drop(sessionId: string): void {
    this.state.delete(sessionId);
  }

  private subagentStart(s: SessionRow, st: ChatState, id: string) {
    st.subagents.add(id);
    this.d.hub.handle(s, "subagent_start");
  }

  private complete(s: SessionRow, st: ChatState, runId: string, snapshot: () => ThreadSnapshot): void {
    const holding = holdingCount(snapshot());
    st.heldRun = holding > 0 ? runId : null;
    this.d.hub.handle(s, "stop", { promptId: runId, backgroundTasks: holding });
  }

  /** `snapshot` returns the store's state after `e` was applied; it is read only for events the hub uses. */
  onEvent(sessionId: string, e: LoggedEvent, snapshot: () => ThreadSnapshot): void {
    const ev = e.event;
    switch (ev.type) {
      case "thread.native":
      case "run.queued":
      case "message.delta":
      case "message.final":
      case "bridge.started":
        return; // nothing for the hub; the thread store keeps them
      case "run.started":
      case "tool.started":
      case "tool.finished":
      case "request.opened":
      case "request.resolved":
      case "run.completed":
      case "background.changed":
      case "run.failed":
      case "run.interrupted":
        break;
      default: {
        const unknown: never = ev;
        const type = String((unknown as { type?: unknown }).type);
        if (this.unknownLogged.has(type)) return;
        this.unknownLogged.add(type);
        this.log(`chat hub: ignoring unknown event type ${type}`);
        return;
      }
    }
    const s = this.d.session(sessionId);
    if (!s) {
      this.log(`chat hub: no session ${sessionId} for event ${ev.type} (seq ${e.seq})`);
      return;
    }
    const st = this.stateOf(sessionId);
    const hub = this.d.hub;
    switch (ev.type) {
      case "run.started":
        st.heldRun = null;
        st.completing = null;
        hub.handle(s, "user_prompt_submit", { promptId: ev.runId });
        // A new turn resets the hub's subagent counter; subagents still running keep counting.
        for (let i = 0; i < st.subagents.size; i++) hub.handle(s, "subagent_start");
        return;
      case "tool.started":
        hub.handle(s, "tool_start", { promptId: ev.runId, toolName: ev.tool, toolCallId: ev.itemId });
        return;
      case "tool.finished":
        hub.handle(s, "tool_complete", { promptId: ev.runId, toolCallId: ev.itemId });
        return;
      case "request.opened": {
        st.requests.set(ev.requestId, { runId: ev.runId, kind: ev.kind });
        // The hub turns `question` into the Live Activity reason ("Allow: …" for a permission).
        const meta: HookMeta = { promptId: ev.runId, toolCallId: ev.requestId, question: ev.prompt };
        if (ev.kind === "approval") hub.handle(s, "permission_request", meta);
        else hub.handle(s, "tool_start", { ...meta, toolName: QUESTION_TOOL });
        return;
      }
      case "request.resolved": {
        // Answered or expired, the run is no longer waiting on it: complete the call the hub is waiting for.
        const r = st.requests.get(ev.requestId);
        if (!r) return; // opened before a devd restart: the hub (also restarted) holds no wait for it
        st.requests.delete(ev.requestId);
        const meta: HookMeta = { promptId: r.runId, toolCallId: ev.requestId };
        hub.handle(s, "tool_complete", r.kind === "approval" ? meta : { ...meta, toolName: QUESTION_TOOL });
        return;
      }
      case "run.completed": {
        if (!this.d.prCheck) { this.complete(s, st, ev.runId, snapshot); return; }
        const runId = ev.runId;
        st.completing = runId;
        this.d.prCheck(sessionId).catch((err: Error) => {
          // S5-R18 (approved fallback): the PR is read once (≤ 30 s); when that fails, the last known PR state decides
          // the hold, and the failure is logged.
          this.log(`chat hub: PR of ${sessionId} not read at completion, using its last known state: ${err.message}`);
        }).finally(() => {
          // A newer run event or a drop of the session overtook the read: this completion is stale.
          if (this.state.get(sessionId) !== st || st.completing !== runId) return;
          st.completing = null;
          const cur = this.d.session(sessionId);
          if (!cur) { this.log(`chat hub: no session ${sessionId} to complete run ${runId}`); return; }
          try { this.complete(cur, st, runId, snapshot); }
          catch (err) { this.log(`chat hub: completion of ${sessionId} run ${runId} failed: ${(err as Error).message}`); }
        });
        return;
      }
      case "background.changed": {
        const t = snapshot();
        const now = subagentIds(t);
        for (const id of now) if (!st.subagents.has(id)) this.subagentStart(s, st, id);
        for (const id of st.subagents) {
          if (now.has(id)) continue;
          st.subagents.delete(id);
          hub.handle(s, "subagent_stop");
        }
        if (st.heldRun !== null && holdingCount(t) === 0) {
          const runId = st.heldRun;
          st.heldRun = null;
          hub.handle(s, "stop", { promptId: runId, backgroundTasks: 0 });
        }
        return;
      }
      case "run.failed":
        st.heldRun = null;
        st.completing = null;
        hub.handle(s, "stop_failure", { promptId: ev.runId });
        return;
      case "run.interrupted":
        st.heldRun = null;
        st.completing = null;
        hub.handle(s, "interrupted", { promptId: ev.runId });
        return;
    }
  }
}
