import { CRITIC_MIN_BRIDGE_VERSION, versionAtLeast } from "../../shared/bridgeVersion";
import type { LinkStatus, LoggedEvent, RequestKind, ThreadSnapshot } from "../../shared/thread";
import type { AgentEventHub, HookMeta } from "./agentEvents";
import { lastEndedRun, type LinkState } from "./attention";
import type { Decision } from "./criticGate";
import type { SessionRow } from "./db";

/** The tool name the hub's QUESTION_TOOLS treats as "waiting for input"; questions and plans pose as it. */
const QUESTION_TOOL = "AskUserQuestion";
/** The longest a completion waits for the PR read before the hub gets it (S5-R18). */
export const PR_CHECK_TIMEOUT_MS = 30_000;

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
  /** A user run whose text had not reached the store at its start: the critic gets it with its user message. */
  promptRun: string | null;
  /** Since when the critic reviews the completed run; until a later run event, or the verdict lets it finish. */
  reviewingSince: number | null;
}

/** The standing critic (criticGate.ts) for chat sessions with `critic = 1`. */
export interface ChatCritic {
  gate: { onPrompt(s: SessionRow, task: string): void; onStop(s: SessionRow): Promise<Decision> };
  /** The bridge version of the session's latest handshake; null before one (or for a 1.0.0 bridge). */
  bridgeVersion: (sessionId: string) => string | null;
  /** The user message of a run in the thread store, or null while it has none. */
  userText: (sessionId: string, runId: string) => string | null;
  /** Sends the critic's reason as a `startTurn` with origin `critic`; resolves once the bridge took it. */
  followUp: (sessionId: string, text: string) => Promise<void>;
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
  private criticOffLogged = new Set<string>();
  private log: (msg: string) => void;

  constructor(private d: {
    hub: AgentEventHub;
    session: (id: string) => SessionRow | null;
    /** Reads the session's PR now (PrWatch.checkNow), before the completion goes to the hub: the run often pushed
     *  just before, and the hub holds the "finished" while its CI checks are pending (HubDeps.prChecks). */
    prCheck?: (id: string) => Promise<unknown>;
    /** The session's PR row as the PR watch last wrote it (session_prs): a devd restart re-sends a completion it held. */
    prRow?: (id: string) => { checks: string; since: number } | null;
    /** How long a completion waits for `prCheck` (S5-R18); default PR_CHECK_TIMEOUT_MS. */
    prCheckTimeoutMs?: number;
    /** Reviews a completed run before its `stop` goes to the hub; a block becomes a follow-up run instead. */
    critic?: ChatCritic;
    /** The session's inbox state changed outside a bridge event (the critic's verdict let the run finish). */
    changed?: (id: string) => void;
    now?: () => number;
    log?: (msg: string) => void;
  }) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  private now() { return this.d.now?.() ?? Date.now(); }

  private stateOf(sessionId: string): ChatState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = {
        heldRun: null, completing: null, requests: new Map(), subagents: new Set(), link: null, seeded: false,
        promptRun: null, reviewingSince: null,
      };
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
    if (active || last?.status !== "completed" || holdingCount(t) > 0
        || last.endedSeq === null || last.endedAt === null || t.seenSeq >= last.endedSeq) return;
    // A completion whose critic verdict the old devd was still waiting for (notify_log: deferred for critic-review,
    // never sent, silenced or blocked since): send it now. The restarted gate has no turn for it, so it is not
    // reviewed (fail-open); the PR hold applies as for any completion.
    if (this.d.hub.heldFor(sessionId, last.endedAt, "critic-review")) {
      this.d.hub.handle(s, "stop", { promptId: last.runId, backgroundTasks: 0 });
      return;
    }
    // A "finished" the hub held for CI died with the old devd (its quiet window is in memory). Unseen, still held by
    // notify_log's record (deferred for pr-checks, never sent or silenced since) and its PR still pending or changed
    // since the run ended: send the completion again, marked as held, so the sweep holds, releases or silences it.
    if (this.d.prRow && this.d.hub.heldFor(sessionId, last.endedAt, "pr-checks")) {
      const row = this.d.prRow(sessionId);
      if (row && (row.checks === "pending" || row.since >= last.endedAt)) {
        this.d.hub.handle(s, "stop", { promptId: last.runId, backgroundTasks: 0 });
        this.d.hub.resumePrHold(sessionId);
      }
    }
  }

  /** The link while the session runs; null when it does not (devd dropped the link on purpose) or before the
   *  link reported any status. Carries `reviewingSince` while the critic reviews. */
  link(sessionId: string): LinkState | null {
    if (this.d.session(sessionId)?.status !== "running") return null;
    const st = this.state.get(sessionId);
    if (!st?.link) return null;
    return st.reviewingSince === null ? st.link : { ...st.link, reviewingSince: st.reviewingSince };
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

  /** The critic reviews this completion: it is on for the session, nothing holds the turn open (the run that ends
   *  the holding work is reviewed instead) and the bridge can tell a critic follow-up from the user's turn. */
  private criticReviews(s: SessionRow, snapshot: () => ThreadSnapshot): boolean {
    const c = this.d.critic;
    if (!c || s.critic !== 1 || holdingCount(snapshot()) > 0) return false;
    const version = c.bridgeVersion(s.id);
    if (version !== null && versionAtLeast(version, CRITIC_MIN_BRIDGE_VERSION)) return true;
    // An older bridge would run the follow-up as the user's turn, which restarts the critic's rounds (S5-R8).
    const key = `${s.id}:${version}`;
    if (!this.criticOffLogged.has(key)) {
      this.criticOffLogged.add(key);
      this.log(`chat hub: critic disabled for ${s.id}: bridge ${version ?? "without a version"} is older than ${CRITIC_MIN_BRIDGE_VERSION}`);
    }
    return false;
  }

  /** The critic's verdict, then the PR read, then the completion goes to the hub. Each step first checks that no
   *  newer run event or drop of the session overtook this completion. */
  private async finish(sessionId: string, s: SessionRow, st: ChatState, runId: string, review: boolean, snapshot: () => ThreadSnapshot): Promise<void> {
    const stale = () => this.state.get(sessionId) !== st || st.completing !== runId;
    if (review) {
      const c = this.d.critic!;
      let decision: Decision;
      // FAIL-OPEN like the Stop hook: the gate records its own failures (critic_error); anything it throws lets
      // the run finish unreviewed.
      try { decision = await c.gate.onStop(s); }
      catch (err) {
        this.log(`chat hub: critic of ${sessionId} failed, run ${runId} finishes unreviewed: ${(err as Error).message}`);
        decision = { block: false };
      }
      if (stale()) return;
      if (decision.block) {
        try {
          await c.followUp(sessionId, decision.reason);
          this.d.hub.criticBlocked(s, runId);
          return; // the follow-up run carries the turn on; its run.started ends the review
        } catch (err) {
          this.log(`chat hub: critic follow-up for ${sessionId} not sent, run ${runId} finishes: ${(err as Error).message}`);
        }
        if (stale()) return;
      }
    }
    if (this.d.prCheck) {
      const ms = this.d.prCheckTimeoutMs ?? PR_CHECK_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_res, rej) => { timer = setTimeout(() => rej(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms); });
      await Promise.race([this.d.prCheck(sessionId), timeout]).catch((err: Error) => {
        // S5-R18 (approved fallback): the PR is read once (≤ 30 s); when that fails or hangs, the last known PR state
        // decides the hold, and the failure is logged.
        this.log(`chat hub: PR of ${sessionId} not read at completion, using its last known state: ${err.message}`);
      }).finally(() => clearTimeout(timer));
      if (stale()) return;
    }
    st.completing = null;
    st.reviewingSince = null;
    const cur = this.d.session(sessionId);
    if (!cur) { this.log(`chat hub: no session ${sessionId} to complete run ${runId}`); return; }
    try { this.complete(cur, st, runId, snapshot); }
    catch (err) { this.log(`chat hub: completion of ${sessionId} run ${runId} failed: ${(err as Error).message}`); }
    if (review) this.d.changed?.(sessionId);
  }

  /** `snapshot` returns the store's state after `e` was applied; it is read only for events the hub uses. */
  onEvent(sessionId: string, e: LoggedEvent, snapshot: () => ThreadSnapshot): void {
    const ev = e.event;
    switch (ev.type) {
      case "thread.native":
      case "run.queued":
      case "message.delta":
      case "bridge.started":
        return; // nothing for the hub; the thread store keeps them
      case "message.final":
        if (ev.role !== "user" || this.state.get(sessionId)?.promptRun !== ev.runId) return;
        break; // the critic's task
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
      case "run.started": {
        st.heldRun = null;
        st.completing = null;
        st.reviewingSince = null;
        st.promptRun = null;
        hub.handle(s, "user_prompt_submit", { promptId: ev.runId });
        // A new turn resets the hub's subagent counter; subagents still running keep counting.
        for (let i = 0; i < st.subagents.size; i++) hub.handle(s, "subagent_start");
        // Only the user's run starts a task (baseline + rounds); a critic follow-up must not reset its rounds.
        if (ev.origin === "user" && this.d.critic) {
          const text = this.d.critic.userText(sessionId, ev.runId);
          if (text === null) st.promptRun = ev.runId; // not queued: its text comes as its user message, next
          else this.d.critic.gate.onPrompt(s, text);
        }
        return;
      }
      case "message.final":
        st.promptRun = null;
        this.d.critic!.gate.onPrompt(s, ev.text);
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
        st.promptRun = null;
        const review = this.criticReviews(s, snapshot);
        if (!review && !this.d.prCheck) { this.complete(s, st, ev.runId, snapshot); return; }
        // The hub gets no `stop` until the critic and the PR read are through: no early done, no early autoEnd.
        st.completing = ev.runId;
        if (review) {
          st.reviewingSince = this.now();
          hub.holdForCritic(s, ev.runId);
        }
        this.finish(sessionId, s, st, ev.runId, review, snapshot)
          .catch((err: Error) => this.log(`chat hub: completion of ${sessionId} run ${ev.runId} failed: ${err.message}`));
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
        // The critic reviews only a completion with nothing holding: a held run released here (its work ended
        // without a new run) goes out unreviewed. By design (fail-open): the run that ends holding work, e.g. a
        // wakeup's agent run, is the one reviewed.
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
        st.reviewingSince = null;
        st.promptRun = null;
        hub.handle(s, "stop_failure", { promptId: ev.runId });
        return;
      case "run.interrupted":
        st.heldRun = null;
        st.completing = null;
        st.reviewingSince = null;
        st.promptRun = null;
        hub.handle(s, "interrupted", { promptId: ev.runId });
        return;
    }
  }
}
