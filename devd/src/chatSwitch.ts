// Switching a chat session's model, account or harness (incl. the Claude proxy profiles) — the chat-runtime
// counterpart of accountSwitch.ts / agentSwitch.ts. devd plans the transition (transition.ts) and sends the
// agent bridge one command (`setModel` or `switchTarget`); the bridge applies it between turns.
//
// The handoff request: the plan needs the user's next message, which is unknown at switch time. The plan is made
// with an empty request; the bridge holds the preamble and prepends it (deliverInline's format) to the next user
// message only, which it sends whole. So the user's request is never shortened; what the empty request does not
// budget is the next message's own size (a message larger than the room left after the preamble would exceed the
// target's window — with the 16k-token preamble cap that needs a message of window − 16k − reserve tokens).
//
// The DB follows the bridge: leases, `sessions.agent` and `repo_prefs` are written only after the bridge confirmed
// the command (the accountSwitch / agentSwitch rule).

import type { Database } from "bun:sqlite";
import type { BridgeCommand, HandoffDelivery, SwitchTarget } from "../../image/agent-bridge/src/protocol";
import { isProxyProfile, proxyProfileEnv, type ProxyProfile } from "../../image/agent-bridge/src/proxyProfile";
import type { Capabilities, LoggedEvent } from "../../shared/thread";
import { currentAccount, lastSwitchAt } from "./accountLease";
import { chooseAccount, isExhausted } from "./accountPolicy";
import { toCandidates } from "./accounts";
import { agentNameFor, chatRuntimeBlock, isAgentName, specFor, type AgentName } from "./agents";
import { codexAccountUsable, codexLimitLive, type CodexAccountView } from "./codexAccounts";
import type { AccountPoolSettings } from "./config";
import { getSession, insertLease, leaseHistory, logEvent, releaseLeasesForSession, setRepoAgent, setSessionAgent, type SessionRow } from "./db";
import type { Handoff } from "./handoff";
import { historyOmittedNotice, planAfterResumeFailure, planTransition, type Target, type Transition } from "./transition";
import type { ThreadStore } from "./threadStore";

type Harness = SwitchTarget["harness"];

/** Context windows (tokens) of the models a chat session can be switched to. A model outside this table is refused
 *  (400), never planned with a guessed window. Conservative values: a smaller window only shrinks a handoff. */
export const CHAT_MODEL_WINDOWS: Record<Harness, Readonly<Record<string, number>>> = {
  claude: { "claude-opus-5-5": 200_000, "claude-sonnet-5-5": 200_000 },
  codex: {
    "gpt-6.1-sol": 272_000, "gpt-6-sol": 272_000, "gpt-5.6-sol": 272_000, "gpt-5.6-terra": 272_000,
    "gpt-5.6-luna": 272_000, "gpt-5.5": 272_000, "gpt-5.4-mini": 272_000, "gpt-5.3-codex": 272_000,
  },
};
/** Tokens kept free for the target model's answer when budgeting a handoff. */
export const RESERVE_TOKENS = 32_000;
/** A switch closes one harness and opens another (CLI start, resume check, app-server start). */
export const SWITCH_TIMEOUT_MS = 90_000;
const CLAUDE_HOME = "/home/dev/.claude";
const CLAUDE_ACCOUNTS_ROOT = "/home/dev/.claude-accounts";
/** Plan input when the target harness never announced its capabilities in this session: nothing is assumed, so
 *  the plan is a fresh thread with a handoff (the one transition that needs no capability). */
const NO_CAPS: Capabilities = { resume: false, injectItems: false, liveModelSwitch: false, questions: false, images: false, backgroundVisibility: false };

/** Refused before anything was sent to the bridge; `code` is the API's `error`. */
export class SwitchRefused extends Error {
  constructor(readonly status: 400 | 409, readonly code: string, readonly detail?: string) { super(detail ?? code); }
}

export type SwitchRequest = { kind: "model"; model: string } | { kind: "account"; accountId?: string } | { kind: "harness"; agent: string };
export interface SwitchResult { kind: Transition["kind"]; unchanged?: true }

export interface ChatSwitchDeps {
  db: Database;
  links: { send(sessionId: string, cmd: BridgeCommand, timeoutMs?: number): Promise<void> };
  threads: (sessionId: string) => ThreadStore;
  claudePool: () => AccountPoolSettings;
  codexAccounts: { list(): { accounts: CodexAccountView[] }; select(): { accountId: string; label: string } };
  /** Attaches a pool account's Claude profile to the container (accountSwitch's ensureProfile). */
  ensureClaudeProfile?: (container: string, accountId: string) => Promise<void>;
  /** DEVD_* inputs of a proxy profile: SessionManager.proxyEnvFor, the same assembly as a new container's env. */
  proxyInputs: (agent: AgentName) => Promise<Record<string, string>>;
  now: () => number;
  log?: (msg: string) => void;
}

/** A switch the bridge confirmed (or one being sent), kept in memory (the env may hold a proxy token): the session's
 *  current target, sent again after a bridge restart (`bridge.started{awaitingTarget}`) or re-planned after a
 *  failed resume. */
interface LastSwitch {
  profile: AgentName;
  target: SwitchTarget;
  /** The native thread the target is on: the one asked to resume, then whatever the bridge announced for it. */
  resume: string | null;
  /** Undelivered handoff; cleared once a user message took it. */
  handoff: HandoffDelivery | null;
  window: number;
  /** Set by the bridge's `resume-failed` while this switch is being sent. */
  resumeFailed: boolean;
}

interface Resolved { profile: AgentName; target: SwitchTarget; window: number }

const handoffDelivery = (h: Handoff): HandoffDelivery | null => (h.preamble === null ? null : { preamble: h.preamble });
const handoffOf = (t: Transition): Handoff | null => (t.kind === "resume-with-delta" || t.kind === "fresh-with-handoff" ? t.handoff : null);

export class ChatSwitch {
  private inFlight = new Set<string>();
  /** Being sent; becomes `last` once the bridge confirmed it. */
  private pending = new Map<string, LastSwitch>();
  private last = new Map<string, LastSwitch>();
  private log: (msg: string) => void;

  constructor(private d: ChatSwitchDeps) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  /** The session ended or stopped: what was sent to its bridge no longer applies (session ids are reused). */
  drop(sessionId: string): void {
    this.last.delete(sessionId);
  }

  async switch(sessionId: string, req: SwitchRequest): Promise<SwitchResult> {
    const s = getSession(this.d.db, sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (this.inFlight.has(sessionId)) throw new SwitchRefused(409, "switch-in-progress");
    this.inFlight.add(sessionId);
    try {
      return await this.run(s, req);
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async run(s: SessionRow, req: SwitchRequest): Promise<SwitchResult> {
    const store = this.d.threads(s.id);
    const from = agentNameFor(s.agent);
    const profile = this.requestedProfile(from, req);
    // A run or a queued message would be overtaken by the switch: the user stops first.
    if (store.snapshot({ limit: 0 }).runs.some((r) => r.endedSeq === null)) throw new SwitchRefused(409, "run-active");
    const current = this.current(s, store);
    const r = await this.resolve(s, profile, current, req);
    const opts = { window: r.window, reserve: RESERVE_TOKENS, now: this.d.now() };
    const caps = store.providerThread(r.target.harness)?.caps ?? NO_CAPS;
    const plan = planTransition(current, { harness: r.target.harness, account: r.target.account, model: r.target.model }, store, "", caps, opts);
    const same = profile === from && r.target.harness === current.harness && r.target.account === current.account && r.target.model === current.model;
    if (same) return { kind: plan.kind, unchanged: true };

    const h = handoffOf(plan);
    const next: LastSwitch = {
      profile, target: r.target, window: r.window, resumeFailed: false,
      resume: plan.kind === "restart-resume" || plan.kind === "resume-with-delta" ? plan.nativeThreadId : plan.kind === "set-model" ? current.nativeThreadId : null,
      // Same thread (model or restart): a handoff still waiting for the next message stays with it; the bridge replaces
      // its pending handoff with the one a switchTarget carries.
      handoff: h ? handoffDelivery(h) : (this.last.get(s.id)?.handoff ?? null),
    };
    this.pending.set(s.id, next);
    let done: Transition = plan;
    try {
      if (plan.kind === "set-model") {
        await this.d.links.send(s.id, { kind: "setModel", model: plan.model }, SWITCH_TIMEOUT_MS);
      } else {
        await this.sendTarget(s.id, next);
        if (next.resumeFailed) done = await this.replanAfterResumeFailure(s.id, store, next);
        else this.noticeOmitted(store, plan);
      }
    } finally {
      this.pending.delete(s.id);
    }
    this.last.set(s.id, next);
    this.confirmed(s, from, profile, current, r.target, done.kind);
    return { kind: done.kind };
  }

  /** The profile the request switches to; 400 for a request this session cannot take. */
  private requestedProfile(from: AgentName, req: SwitchRequest): AgentName {
    if (req.kind === "model") {
      if (isProxyProfile(from)) throw new SwitchRefused(400, "model-set-by-profile", `the model of ${from} is set in settings.proxyModels`);
      return from;
    }
    if (req.kind === "account") {
      if (!specFor(from).anthropicAccount && specFor(from).runtime !== "codex") throw new SwitchRefused(400, "no-account-pool", `${from} runs on no account pool`);
      return from;
    }
    if (!isAgentName(req.agent)) throw new SwitchRefused(400, "unknown-agent", `unknown agent ${req.agent}`);
    const blocked = chatRuntimeBlock(req.agent, "vps");
    if (blocked) throw new SwitchRefused(400, "unknown-agent", blocked);
    return req.agent;
  }

  /** The session's current target: the last confirmed switch; without one (devd restarted, or never switched) the
   *  announced native thread of the profile's harness, else the launch target. */
  private current(s: SessionRow, store: ThreadStore): Target & { nativeThreadId: string | null } {
    const l = this.last.get(s.id);
    if (l) return { harness: l.target.harness, account: l.target.account, model: l.target.model, nativeThreadId: l.resume };
    const profile = agentNameFor(s.agent);
    const n = store.snapshot({ limit: 0 }).native;
    // A thread of another harness is the one before a switch whose new thread was not announced yet.
    if (n && n.harness === specFor(profile).runtime) return { harness: n.harness, account: n.account, model: n.model, nativeThreadId: n.nativeThreadId };
    // Claude announces its thread with the first turn; until then the account is the one the launch leased.
    const account = specFor(profile).anthropicAccount ? currentAccount(leaseHistory(this.d.db, "devbox", s.id)) : null;
    return { harness: specFor(profile).runtime, account, model: null, nativeThreadId: null };
  }

  private async resolve(s: SessionRow, profile: AgentName, current: Target, req: SwitchRequest): Promise<Resolved> {
    if (isProxyProfile(profile)) return this.proxyTarget(profile);
    const harness = specFor(profile).runtime as Harness;
    // Leaving a proxy profile is not the same Claude: its model and (absent) account do not carry over.
    const keeps = harness === current.harness && !isProxyProfile(agentNameFor(s.agent));
    const model = req.kind === "model" ? req.model : keeps ? current.model : null;
    const window = windowFor(harness, model);
    let account: string | null;
    if (req.kind === "account") account = harness === "claude" ? this.claudeAccount(s, req.accountId) : this.codexAccount(req.accountId);
    else if (keeps) account = current.account;
    else account = harness === "claude" ? this.claudeAccount(s, undefined) : this.codexAccount(undefined);
    if (harness === "codex") {
      if (account === null) throw new SwitchRefused(409, "no-account", "the Codex account of this session is unknown");
      return { profile, target: { harness, account, model, env: {} }, window };
    }
    if (account !== null && account !== current.account) {
      try { await this.d.ensureClaudeProfile?.(s.container, account); }
      catch (e) { throw new SwitchRefused(409, "profile-unavailable", `the Claude account could not be attached to this session: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return { profile, target: { harness, account, model, env: { CLAUDE_CONFIG_DIR: account === null ? CLAUDE_HOME : `${CLAUDE_ACCOUNTS_ROOT}/${account}` } }, window };
  }

  private async proxyTarget(profile: ProxyProfile): Promise<Resolved> {
    const inputs = await this.d.proxyInputs(profile);
    let env: Record<string, string>;
    try { env = proxyProfileEnv(profile, inputs); }
    catch (e) { throw new SwitchRefused(409, "profile-unavailable", e instanceof Error ? e.message : String(e)); }
    const window = Number(inputs.DEVD_AGENT_CTX);
    if (!inputs.DEVD_AGENT_CTX || !Number.isSafeInteger(window) || window <= 0) {
      throw new SwitchRefused(409, "profile-unavailable", `the context window of ${profile}'s model is unknown`);
    }
    // The image's shared Claude home, as agent-launch leaves it for a proxy profile (no pool account).
    return { profile, target: { harness: "claude", account: null, model: inputs.DEVD_AGENT_MODEL, env: { ...env, CLAUDE_CONFIG_DIR: CLAUDE_HOME } }, window };
  }

  /** A usable Anthropic pool account: the requested one, or the pool's choice (as /api/accounts/lease, forced like
   *  a manual `dev switch`). Unknown, disabled, quarantined or permanently failing (expired) is invalid; over the
   *  threshold is unusable. */
  private claudeAccount(s: SessionRow, requested: string | undefined): string {
    const now = this.d.now();
    const settings = this.d.claudePool();
    const candidates = toCandidates(this.d.db);
    let id: string;
    if (requested !== undefined) {
      const c = candidates.find((a) => a.id === requested);
      if (!c || c.disabled || c.quarantined) throw new SwitchRefused(400, "invalid-account", "that account does not exist or is disabled/quarantined");
      id = c.id;
    } else {
      const history = leaseHistory(this.d.db, "devbox", s.id);
      const decision = chooseAccount({
        candidates, current: currentAccount(history), lastSwitchAt: lastSwitchAt(history),
        now, force: true, project: s.project, repo: s.repo, settings,
      });
      if (decision.accountId === null) throw new SwitchRefused(409, "no-account", "no Anthropic account is available");
      id = decision.accountId;
    }
    if (isExhausted(candidates.find((a) => a.id === id)!, now, settings.thresholdPct)) {
      throw new SwitchRefused(409, "account-unusable", `account ${id} is over the usage threshold`);
    }
    return id;
  }

  /** A usable Codex account: the requested one, or the Codex pool's choice. */
  private codexAccount(requested: string | undefined): string {
    let id = requested;
    if (id === undefined) {
      try { id = this.d.codexAccounts.select().accountId; }
      catch (e) { throw new SwitchRefused(409, "no-account", e instanceof Error ? e.message : String(e)); }
    }
    const a = this.d.codexAccounts.list().accounts.find((x) => x.id === id);
    if (!a) throw new SwitchRefused(400, "invalid-account", "that Codex account does not exist");
    if (!codexAccountUsable(a)) throw new SwitchRefused(409, "account-unusable", `Codex account ${a.label} is disabled, signed out or its login was rejected`);
    if (codexLimitLive(a, this.d.now())) throw new SwitchRefused(409, "account-unusable", `Codex account ${a.label} reached its usage limit`);
    return a.id;
  }

  private sendTarget(sessionId: string, l: LastSwitch): Promise<void> {
    return this.d.links.send(sessionId, { kind: "switchTarget", target: l.target, resume: l.resume, handoff: l.handoff }, SWITCH_TIMEOUT_MS);
  }

  /** The bridge could not resume `last.resume`: a fresh thread with the full handoff on the same target. */
  private async replanAfterResumeFailure(sessionId: string, store: ThreadStore, l: LastSwitch): Promise<Transition> {
    if (l.resume === null) throw new Error("the bridge reported a failed resume, but no thread was being resumed");
    const t = planAfterResumeFailure(l.target, l.resume, store, "", { window: l.window, reserve: RESERVE_TOKENS, now: this.d.now() });
    const h = handoffOf(t);
    l.resume = null;
    l.handoff = h ? handoffDelivery(h) : null;
    l.resumeFailed = false;
    await this.sendTarget(sessionId, l);
    return t;
  }

  /** Ruling P5: a handoff that had no room for any history says so in the thread. */
  private noticeOmitted(store: ThreadStore, t: Transition): void {
    const h = handoffOf(t);
    if (h && h.preamble === null && h.omitted > 0) store.addNotice(historyOmittedNotice(h.omitted), this.d.now());
  }

  private confirmed(s: SessionRow, from: AgentName, profile: AgentName, current: Target, target: SwitchTarget, kind: Transition["kind"]): void {
    const now = this.d.now();
    const leases = leaseHistory(this.d.db, "devbox", s.id);
    if (specFor(profile).anthropicAccount && target.account !== null) {
      if (!leases.some((l) => l.released_at === null && l.account_id === target.account)) {
        releaseLeasesForSession(this.d.db, s.id, now);
        insertLease(this.d.db, { account_id: target.account, client: "devbox", session_id: s.id, label: `${s.project}/${s.repo}`, created_at: now, released_at: null });
      }
    } else if (leases.some((l) => l.released_at === null)) {
      // The session no longer runs on the Anthropic pool (Codex or a proxy profile): its lease would count as load.
      releaseLeasesForSession(this.d.db, s.id, now);
    }
    if (profile !== from) {
      setSessionAgent(this.d.db, s.id, profile);
      setRepoAgent(this.d.db, s.folder, s.project, s.solo ? "claudeSolo" : s.repo, profile, now);
    }
    // No env here: it may carry a proxy token.
    logEvent(this.d.db, s.id, "chat-switch", {
      kind, from: { agent: from, harness: current.harness, account: current.account, model: current.model },
      to: { agent: profile, harness: target.harness, account: target.account, model: target.model },
    });
  }

  /** Bridge events that concern a switch (called for every event the store applied). */
  onEvent(sessionId: string, e: LoggedEvent): void {
    const ev = e.event;
    const l = this.last.get(sessionId);
    const p = this.pending.get(sessionId);
    switch (ev.type) {
      case "thread.native":
        for (const x of [l, p]) if (x && ev.harness === x.target.harness) x.resume = ev.nativeThreadId;
        return;
      case "run.queued":
        // The bridge hands the pending handoff to the next user message.
        if (l) l.handoff = null;
        return;
      case "run.failed":
        if (ev.error !== "resume-failed") return;
        if (p) { p.resumeFailed = true; return; }
        // No switch of this devd is waiting for it (devd restarted, or a re-sent target failed): re-plan here.
        void this.recover(sessionId, (store, last) => this.replanAfterResumeFailure(sessionId, store, last).then(() => {}), "resume failure");
        return;
      case "bridge.started":
        if (!ev.awaitingTarget) return;
        void this.recover(sessionId, (_store, last) => this.sendTarget(sessionId, last), "target re-send");
        return;
    }
  }

  private async recover(sessionId: string, act: (store: ThreadStore, l: LastSwitch) => Promise<void>, what: string): Promise<void> {
    try {
      const store = this.d.threads(sessionId);
      const l = this.last.get(sessionId) ?? await this.rebuild(sessionId, store);
      this.last.set(sessionId, l);
      await act(store, l);
    } catch (e) {
      this.log(`chat switch ${sessionId}: ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The target from the DB and the store, for a bridge that waits for it after devd lost its memory (restart). An
   *  undelivered handoff is not known any more: messages queued before the bridge restart already carry theirs. */
  private async rebuild(sessionId: string, store: ThreadStore): Promise<LastSwitch> {
    const s = getSession(this.d.db, sessionId);
    if (!s) throw new Error("unknown session");
    const profile = agentNameFor(s.agent);
    const n = store.snapshot({ limit: 0 }).native;
    const harness = specFor(profile).runtime;
    const resume = n?.harness === harness ? n.nativeThreadId : null;
    if (isProxyProfile(profile)) {
      const r = await this.proxyTarget(profile);
      return { profile, target: r.target, window: r.window, resume, handoff: null, resumeFailed: false };
    }
    const model = n?.harness === harness ? n.model : null;
    const account = harness === "claude" ? currentAccount(leaseHistory(this.d.db, "devbox", sessionId)) : n?.harness === harness ? n.account : null;
    if (harness === "codex" && account === null) throw new Error("the Codex account of this session is unknown");
    const env: Record<string, string> = harness === "claude" ? { CLAUDE_CONFIG_DIR: account === null ? CLAUDE_HOME : `${CLAUDE_ACCOUNTS_ROOT}/${account}` } : {};
    return { profile, target: { harness: harness as Harness, account, model, env }, window: windowFor(harness as Harness, model), resume, handoff: null, resumeFailed: false };
  }
}

/** The window of `model`; a null model is the harness default, planned with the smallest window it offers. */
function windowFor(harness: Harness, model: string | null): number {
  const table = CHAT_MODEL_WINDOWS[harness];
  if (model === null) return Math.min(...Object.values(table));
  const w = table[model];
  if (w === undefined) throw new SwitchRefused(400, "unknown-model", `${model} is not a ${harness} model chat sessions offer`);
  return w;
}
