import type { LinkStatus, LoggedEvent, RequestKind, ThreadSnapshot } from "../../shared/thread";
import type { AgentEventHub, HookMeta } from "./agentEvents";
import { lastEndedRun, type LinkState } from "./attention";
import type { SessionRow } from "./db";

/** The tool name the hub's QUESTION_TOOLS treats as "waiting for input"; questions and plans pose as it. */
const QUESTION_TOOL = "AskUserQuestion";

interface ChatState {
  /** The run whose `stop` was deferred by holding work or pending PR checks; its `stop` is re-sent once, when both
   *  are over. */
  heldRun: string | null;
  /** The completed run whose PR check (`pr.check`) is still running; a later run event cancels it. */
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
    /** The PR watch (prWatch.ts): pending CI checks of the session's open PR hold a completion like holding work,
     *  so no "done" goes out while CI runs. `check` polls the PR now (a run often ends right after its push);
     *  `pending` is the last known state. Absent = completions are never held for CI. */
    pr?: { pending: (id: string) => boolean; check: (id: string) => Promise<boolean> };
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
    if (!active && last?.status === "completed" && this.holding(sessionId, t) > 0) st.heldRun = last.runId;
    const s = this.d.session(sessionId);
    if (!s) {
      this.log(`chat hub: no session ${sessionId} to restore subagents for`);
      return;
    }
    for (const id of subagentIds(t)) this.subagentStart(s, st, id);
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

  /** What holds a completion: the bridge's holding background work plus the PR's pending checks (one). */
  private holding(sessionId: string, t: ThreadSnapshot): number {
    return holdingCount(t) + (this.d.pr?.pending(sessionId) ? 1 : 0);
  }

  private complete(s: SessionRow, st: ChatState, runId: string, snapshot: () => ThreadSnapshot): void {
    const holding = this.holding(s.id, snapshot());
    st.heldRun = holding > 0 ? runId : null;
    this.d.hub.handle(s, "stop", { promptId: runId, backgroundTasks: holding });
  }

  /** The PR watch saw the session's pending checks end (success, failure, merge, close): a completion they held
   *  goes out once no holding work is left either. */
  prChecksEnded(sessionId: string, snapshot: () => ThreadSnapshot): void {
    const st = this.state.get(sessionId);
    if (!st || st.heldRun === null || this.holding(sessionId, snapshot()) > 0) return;
    const s = this.d.session(sessionId);
    if (!s) { this.log(`chat hub: no session ${sessionId} to release run ${st.heldRun}`); return; }
    const runId = st.heldRun;
    st.heldRun = null;
    this.d.hub.handle(s, "stop", { promptId: runId, backgroundTasks: 0 });
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
        const pr = this.d.pr;
        if (!pr) { this.complete(s, st, ev.runId, snapshot); return; }
        st.completing = ev.runId;
        const runId = ev.runId;
        pr.check(sessionId).catch((err: Error) => {
          // The last known PR state still decides (`pr.pending`); the run is not held forever on an unreadable PR.
          this.log(`chat hub: PR checks of ${sessionId} not read at completion: ${err.message}`);
        }).finally(() => {
          // A newer run event, a stop or a drop of the session overtook the check: this completion is stale.
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
        if (st.heldRun !== null && this.holding(sessionId, t) === 0) {
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
