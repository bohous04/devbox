import type { BridgeEvent, LinkStatus, LoggedEvent, RequestKind, ThreadSnapshot } from "../../shared/thread";
import type { AgentEventHub, HookMeta } from "./agentEvents";
import type { LinkState } from "./attention";
import type { SessionRow } from "./db";

/** The tool name the hub's QUESTION_TOOLS treats as "waiting for input"; questions and plans pose as it. */
const QUESTION_TOOL = "AskUserQuestion";

/** Bridge events with nothing to tell the hub (the thread store keeps them). */
const NOT_FOR_HUB = new Set<BridgeEvent["type"]>(["thread.native", "run.queued", "message.delta", "message.final", "bridge.started"]);

interface ChatState {
  /** The run whose `stop` was deferred by holding work; its `stop` is re-sent once, when holding drops to 0. */
  heldRun: string | null;
  /** Open requests by id, so their resolution can clear the hub's wait for the same call. */
  requests: Map<string, { runId: string; kind: RequestKind }>;
  link: LinkState | null;
}

/** Feeds a chat session's bridge events into the AgentEventHub as the hook events a tmux session sends, so
 *  notify_log, Live Activity, stuck detection and notifications keep working. `promptId` is the run id: the hub
 *  then drops events of an older run as stale. State is in memory: after a devd restart the hub starts from zero
 *  as well. */
export class ChatHub {
  private state = new Map<string, ChatState>();
  private unknownLogged = new Set<string>();
  private log: (msg: string) => void;

  constructor(private d: {
    hub: AgentEventHub;
    session: (id: string) => SessionRow | null;
    now?: () => number;
    log?: (msg: string) => void;
  }) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  private stateOf(sessionId: string): ChatState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { heldRun: null, requests: new Map(), link: null };
      this.state.set(sessionId, st);
    }
    return st;
  }

  onStatus(sessionId: string, status: LinkStatus): void {
    this.stateOf(sessionId).link = { status, since: this.now() };
  }

  /** The link while the session runs; null when it does not (devd dropped the link on purpose) or before the
   *  link reported any status. */
  link(sessionId: string): LinkState | null {
    if (this.d.session(sessionId)?.status !== "running") return null;
    return this.state.get(sessionId)?.link ?? null;
  }

  /** `t` is the store's snapshot after `e` was applied; only `background` is read. */
  onEvent(sessionId: string, e: LoggedEvent, t: ThreadSnapshot): void {
    const ev = e.event;
    if (NOT_FOR_HUB.has(ev.type)) return;
    const s = this.d.session(sessionId);
    if (!s) {
      this.log(`chat hub: no session ${sessionId} for event ${ev.type} (seq ${e.seq})`);
      return;
    }
    const st = this.stateOf(sessionId);
    const hub = this.d.hub;
    const holding = t.background.filter((w) => w.holding).length;
    switch (ev.type) {
      case "run.started":
        st.heldRun = null;
        hub.handle(s, "user_prompt_submit", { promptId: ev.runId });
        return;
      case "tool.started":
        hub.handle(s, "tool_start", { promptId: ev.runId, toolName: ev.tool, toolCallId: ev.itemId });
        return;
      case "tool.finished":
        hub.handle(s, "tool_complete", { promptId: ev.runId, toolCallId: ev.itemId });
        return;
      case "request.opened": {
        st.requests.set(ev.requestId, { runId: ev.runId, kind: ev.kind });
        const meta: HookMeta = { promptId: ev.runId, toolCallId: ev.requestId };
        if (ev.kind === "approval") hub.handle(s, "permission_request", meta);
        else hub.handle(s, "tool_start", { ...meta, toolName: QUESTION_TOOL, question: ev.prompt });
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
      case "run.completed":
        st.heldRun = holding > 0 ? ev.runId : null;
        hub.handle(s, "stop", { promptId: ev.runId, backgroundTasks: holding });
        return;
      case "background.changed":
        if (st.heldRun !== null && holding === 0) {
          const runId = st.heldRun;
          st.heldRun = null;
          hub.handle(s, "stop", { promptId: runId, backgroundTasks: 0 });
        }
        return;
      case "run.failed":
        st.heldRun = null;
        hub.handle(s, "stop_failure", { promptId: ev.runId });
        return;
      case "run.interrupted":
        st.heldRun = null;
        hub.handle(s, "interrupted", { promptId: ev.runId });
        return;
      default: {
        const type = String((ev as { type?: unknown }).type);
        if (this.unknownLogged.has(type)) return;
        this.unknownLogged.add(type);
        this.log(`chat hub: ignoring unknown event type ${type}`);
      }
    }
  }
}
