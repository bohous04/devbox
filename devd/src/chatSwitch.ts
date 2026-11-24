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
// the command (the accountSwitch / agentSwitch rule). A switchTarget carries a switchId and is saved as unconfirmed
// first; the bridge's answer or its target.applied (bridge 1.11.0+, logged once the target is open, also by a bridge
// restarted mid-switch) confirms it, whichever comes first, so a switch whose answer is lost (a timeout, a dropped
// link, a devd restart) still reaches the DB.

import type { Database } from "bun:sqlite";
import type { BridgeCommand, HandoffDelivery, SwitchTarget } from "../../image/agent-bridge/src/protocol";
import { isProxyProfile, proxyProfileEnv, type ProxyProfile } from "../../image/agent-bridge/src/proxyProfile";
import { BRIDGE_VERSION } from "../../image/agent-bridge/src/version";
import { ACP_MIN_BRIDGE_VERSION, versionAtLeast } from "../../shared/bridgeVersion";
import { MODEL_ALIASES, CHAT_MODELS as SHARED_CHAT_MODELS } from "../../shared/chatModels";
import type { Capabilities, LoggedEvent } from "../../shared/thread";
import { currentAccount, lastSwitchAt } from "./accountLease";
import { chooseAccount, isExhausted } from "./accountPolicy";
import { toCandidates } from "./accounts";
import { AGENTS, agentNameFor, chatHarness, chatRuntimeBlock, isAgentName, specFor, type AgentName, type ChatHarness } from "./agents";
import { codexAccountUsable, codexLimitLive, type CodexAccountView } from "./codexAccounts";
import type { AccountPoolSettings } from "./config";
import { AgentDisconnected, CommandFailed, CommandTimeout, type BridgeHandshake } from "./bridgeLink";
import {
  getSession, insertLease, leaseHistory, logEvent, releaseLeasesForSession, saveUnconfirmedSwitch, setRepoAgent, setSessionAgent, takeUnconfirmedSwitch,
  type SessionRow,
} from "./db";
import type { Handoff } from "./handoff";
import { historyOmittedNotice, planAfterResumeFailure, planTransition, resumeFailedNotice, type Target, type Transition } from "./transition";
import type { ThreadStore } from "./threadStore";

type Harness = ChatHarness;

/** The models a chat session can be switched to (the model route refuses anything else with 400); shared with the
 *  dashboard's model menu. */
export const CHAT_MODELS: Record<Harness, readonly string[]> = SHARED_CHAT_MODELS;
/** Context windows (tokens) of the base models. Conservative values: a smaller window only shrinks a handoff. */
const BASE_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 200_000, "claude-sonnet-5-5": 200_000,
  "gpt-6-astra": 272_000, "gpt-6.1-sol": 272_000, "gpt-6-sol": 272_000, "gpt-6-luna": 272_000,
  "gpt-5.6-sol": 272_000, "gpt-5.6-terra": 272_000, "gpt-5.6-luna": 272_000, "gpt-5.5": 272_000,
  "gpt-5.4-mini": 272_000, "gpt-5.3-codex": 272_000,
  // ACP agents, as they reported them live: Grok's session/new `models` `totalContextTokens`, Vibe's and
  // Antigravity's `usage_update` size (Vibe reported 202,144 for Medium 3.5).
  "grok-4.7": 256_000, "grok-4.7-build-fast": 256_000, "grok-4.6": 500_000, "grok-4.5": 500_000,
  "mistral-large-4-0": 400_000, "mistral-medium-3.5": 200_000,
  "gemini-4-neon": 1_048_576,
};
/** Every model id a harness reports (thread.native, run.started) → its base model: the base models themselves and
 *  the shared MODEL_ALIASES (the same ids pricing.ts prices). An id outside this table has no known window and is
 *  refused (409 `unknown-model-window`), never given a default. */
export const MODEL_WINDOW_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.keys(BASE_WINDOWS).map((m) => [m, m])),
  ...MODEL_ALIASES,
};
/** Tokens kept free for the target model's answer when budgeting a handoff. */
export const RESERVE_TOKENS = 32_000;
/** A switch closes one harness and opens another (CLI start, resume check, app-server start). */
export const SWITCH_TIMEOUT_MS = 90_000;
/** Pauses between re-sends of the target to a bridge that awaits it, while its link is up; the last one repeats. */
export const RESEND_DELAYS_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000];
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
/** `unchanged`: the target is the current one, nothing was sent (kind `set-model`, the same-target plan of
 *  transition.ts). `exhausted`: the target account is over its usage threshold (allowed, as for `dev switch`). */
export interface SwitchResult { kind: Transition["kind"]; unchanged?: true; exhausted?: true }
const UNCHANGED: SwitchResult = { kind: "set-model", unchanged: true };
/** GET .../thread/target: the profile and the target devd plans the next switch from. `awaitingTarget`: the bridge
 *  holds no harness until it gets a target (devd keeps sending it; a switch is allowed despite queued messages). */
/** `bridgeVersion`: from the bridge's latest handshake; null before one, or for a 1.0.0 bridge (it sends none). */
/** `bridgeOutdated`: the bridge's latest handshake named a version older than this devd's, or none (1.0.0); it lacks
 *  the newer fixes until the session's container is recreated. False before a handshake. */
export interface CurrentTarget extends Target { agent: AgentName; awaitingTarget: boolean; bridgeVersion: string | null; bridgeOutdated: boolean }

export interface ChatSwitchDeps {
  db: Database;
  links: { send(sessionId: string, cmd: BridgeCommand, timeoutMs?: number): Promise<void> };
  threads: (sessionId: string) => ThreadStore;
  claudePool: () => AccountPoolSettings;
  codexAccounts: { list(): { accounts: CodexAccountView[] }; select(): { accountId: string; label: string } };
  /** Attaches a pool account's Claude profile to the container (accountSwitch's ensureProfile). */
  ensureClaudeProfile?: (container: string, accountId: string) => Promise<void>;
  /** Whether the container has the Codex account's home mounted (mounts are fixed at container creation). */
  codexAccountMounted?: (container: string, accountId: string) => Promise<boolean>;
  /** DEVD_* inputs of a proxy profile: SessionManager.proxyEnvFor, the same assembly as a new container's env. */
  proxyInputs: (agent: AgentName) => Promise<Record<string, string>>;
  now: () => number;
  log?: (msg: string) => void;
  /** RESEND_DELAYS_MS; tests shorten them. */
  resendDelaysMs?: readonly number[];
}

/** Re-sending the target to a bridge that awaits it (ruling P24): one notice per episode, however many attempts. */
interface Resend {
  attempt: number;
  noticed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** The bridge reported a failed resume and no switch was being sent: the next attempt re-plans a fresh thread. */
  replan: boolean;
}

/** A switch the bridge confirmed (or one being sent), kept in memory (the env may hold a proxy token): the session's
 *  current target, sent again while the bridge awaits it (handshake `awaitingTarget`) or re-planned after a failed
 *  resume. */
interface LastSwitch {
  profile: AgentName;
  target: SwitchTarget;
  /** The native thread the target is on: the one asked to resume, then whatever the bridge announced for it. */
  resume: string | null;
  /** Undelivered handoff; cleared once a user message took it. The bridge owns it once confirmed: a re-send without
   *  one (devd lost it, e.g. a restart) keeps the bridge's. */
  handoff: HandoffDelivery | null;
  window: number;
  /** Set by the bridge's `resume-failed` while this switch is being sent. */
  resumeFailed: boolean;
  /** The switchId it was first sent with; null for a setModel or a target devd rebuilt. */
  switchId: string | null;
}

interface Resolved { profile: AgentName; target: SwitchTarget; window: number; exhausted: boolean }

/** A sent switch the DB does not follow yet (table chat_switches_unconfirmed): what `confirmed` needs, without env. */
interface Unconfirmed { from: AgentName; profile: AgentName; kind: Transition["kind"]; current: Target; target: Target }

const handoffDelivery = (h: Handoff): HandoffDelivery | null => (h.preamble === null ? null : { preamble: h.preamble });
const handoffOf = (t: Transition): Handoff | null => (t.kind === "resume-with-delta" || t.kind === "fresh-with-handoff" ? t.handoff : null);

export class ChatSwitch {
  private inFlight = new Set<string>();
  /** Being sent; becomes `last` once the bridge confirmed it. */
  private pending = new Map<string, LastSwitch>();
  private last = new Map<string, LastSwitch>();
  /** The bridge version of the session's latest handshake. */
  private bridgeVersions = new Map<string, string | null>();
  /** Sessions whose bridge holds no harness until devd sends its target (handshake, or a reported failed resume). */
  private awaiting = new Set<string>();
  private resends = new Map<string, Resend>();
  private log: (msg: string) => void;

  constructor(private d: ChatSwitchDeps) {
    this.log = d.log ?? ((msg) => console.error(msg));
  }

  /** The session ended or stopped: what was sent to its bridge no longer applies (session ids are reused). */
  drop(sessionId: string): void {
    this.last.delete(sessionId);
    this.bridgeVersions.delete(sessionId);
    this.settled(sessionId);
  }

  /** Every handshake of the session's bridge (BridgeLinks.onHandshake): a bridge awaiting its target gets it now and,
   *  while that fails, again with backoff (ruling P24). */
  onHandshake(sessionId: string, h: BridgeHandshake): void {
    this.bridgeVersions.set(sessionId, h.version);
    if (!h.awaitingTarget) {
      this.settled(sessionId);
      return;
    }
    this.awaiting.add(sessionId);
    this.resend(sessionId);
  }

  /** The bridge version of the session's latest handshake; null before one, or for a 1.0.0 bridge. */
  bridgeVersion(sessionId: string): string | null {
    return this.bridgeVersions.get(sessionId) ?? null;
  }

  /** The target the next switch is planned from (see `current`), for the dashboard's switchers. */
  target(sessionId: string): CurrentTarget {
    const s = getSession(this.d.db, sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    const { harness, account, model } = this.current(s, this.d.threads(sessionId));
    const bridgeVersion = this.bridgeVersions.get(sessionId) ?? null;
    // A handshake seen without a version is a 1.0.0 bridge; before any handshake nothing is claimed.
    const handshaken = this.bridgeVersions.has(sessionId);
    return {
      agent: agentNameFor(s.agent), harness, account, model, awaitingTarget: this.awaiting.has(sessionId), bridgeVersion,
      bridgeOutdated: handshaken && (bridgeVersion === null || !versionAtLeast(bridgeVersion, BRIDGE_VERSION)),
    };
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
    // A 1.0.0 bridge (no version in its handshake) does not know setModel/switchTarget and would drop the link.
    if (this.bridgeVersions.get(s.id) === null) {
      throw new SwitchRefused(409, "bridge-too-old", "the agent bridge in this container predates switching; recreate the session's container first");
    }
    // An older bridge's parseTarget throws on an ACP harness and drops the whole link: refuse before sending.
    const version = this.bridgeVersions.get(s.id);
    if (req.kind === "harness" && specFor(profile).acp !== undefined && typeof version === "string" && !versionAtLeast(version, ACP_MIN_BRIDGE_VERSION)) {
      throw new SwitchRefused(409, "bridge-too-old", `recreate the container to use ${specFor(profile).label}`);
    }
    // A run or a queued message would be overtaken by the switch: the user stops first. Not while the bridge awaits
    // its target: its queued messages wait for exactly that, and picking a target is how the user gets them going.
    const awaiting = this.awaiting.has(s.id);
    if (!awaiting && store.snapshot({ limit: 0 }).runs.some((r) => r.endedSeq === null)) throw new SwitchRefused(409, "run-active");
    const current = this.current(s, store);
    // The current target again: nothing to check or send, unless the bridge awaits it.
    if (!awaiting && req.kind === "harness" && profile === from) return UNCHANGED;
    if (!awaiting && req.kind === "account" && req.accountId !== undefined && req.accountId === current.account) return UNCHANGED;
    if (!awaiting && req.kind === "model" && req.model === current.model) return UNCHANGED;
    const r = await this.resolve(s, profile, current, req);
    const same = profile === from && r.target.harness === current.harness && r.target.account === current.account && r.target.model === current.model;
    if (same && !awaiting) return r.exhausted ? { ...UNCHANGED, exhausted: true } : UNCHANGED;
    if (r.target.account !== null && r.target.account !== current.account) await this.attachProfile(s, r.target);
    const opts = { window: r.window, reserve: RESERVE_TOKENS, now: this.d.now() };
    const threadCaps = store.providerThread(r.target.harness)?.caps ?? NO_CAPS;
    // Another profile on the same harness (a proxy profile and back) is another env (upstream, key, ANTHROPIC_MODEL):
    // a live setModel would keep the old one, so the harness restarts on the target's env.
    const caps = profile === from ? threadCaps : { ...threadCaps, liveModelSwitch: false };
    const plan = planTransition(current, { harness: r.target.harness, account: r.target.account, model: r.target.model }, store, "", caps, opts);

    const h = handoffOf(plan);
    // A bridge awaiting its target has no harness to set a model on: it gets the target.
    const viaSetModel = plan.kind === "set-model" && !awaiting;
    const switchId = viaSetModel ? null : crypto.randomUUID();
    const next: LastSwitch = {
      profile, target: r.target, window: r.window, resumeFailed: false, switchId,
      resume: plan.kind === "restart-resume" || plan.kind === "resume-with-delta" ? plan.nativeThreadId : plan.kind === "set-model" ? current.nativeThreadId : null,
      // Same thread (model or restart): a handoff still waiting for the next message stays with it; the bridge replaces
      // its pending handoff with the one a switchTarget carries.
      handoff: h ? handoffDelivery(h) : (this.last.get(s.id)?.handoff ?? null),
    };
    this.pending.set(s.id, next);
    if (switchId !== null) {
      const t = (x: Target): Target => ({ harness: x.harness, account: x.account, model: x.model });
      const u: Unconfirmed = { from, profile, kind: plan.kind, current: t(current), target: t(r.target) };
      saveUnconfirmedSwitch(this.d.db, s.id, switchId, u, this.d.now());
    }
    try {
      if (viaSetModel) await this.d.links.send(s.id, { kind: "setModel", model: plan.model }, SWITCH_TIMEOUT_MS);
      else await this.sendTarget(s.id, next, switchId ?? undefined);
    } catch (e) {
      // The bridge answered that it is back where it was: nothing to confirm later. Without an answer (a timeout, a
      // dropped link) the switch stays unconfirmed: the bridge may have opened the target all the same.
      if (e instanceof CommandFailed && switchId !== null) takeUnconfirmedSwitch(this.d.db, s.id, switchId);
      // The bridge answered: it could not open the new agent (e.g. its CLI is not signed in) and is back where it was.
      if (e instanceof CommandFailed && req.kind === "harness") {
        const after = awaiting ? "The agent still waits for its target." : `The session stays on ${specFor(from).label}.`;
        store.addNotice(`Switching to ${specFor(profile).label} failed: ${e.message}. ${after}`, this.d.now(), "warn");
      }
      throw e;
    } finally {
      this.pending.delete(s.id);
    }
    // The bridge is on the target now (also after a failed resume: it then holds no thread and no handoff and awaits
    // the fresh target), so the DB follows before the re-plan, which may fail on its own.
    const done = next.resumeFailed ? this.replan(store, next) : null;
    this.last.set(s.id, next);
    // Already confirmed when the bridge's target.applied came before its answer.
    if (switchId === null || takeUnconfirmedSwitch(this.d.db, s.id, switchId) !== null) this.confirmed(s, from, profile, current, r.target, plan.kind);
    const exhausted = r.exhausted ? { exhausted: true as const } : {};
    if (done === null) {
      this.settled(s.id);
      store.addNotice(switchNotice(req, profile, r.target, plan), this.d.now());
      this.noticeOmitted(store, plan);
      return { kind: plan.kind, ...exhausted };
    }
    store.addNotice(switchNotice(req, profile, r.target, done, true), this.d.now());
    try {
      await this.sendTarget(s.id, next);
    } catch (e) {
      // The bridge awaits the fresh target: devd keeps sending it.
      this.awaiting.add(s.id);
      this.retryLater(s.id, store, e);
      throw e;
    }
    this.settled(s.id);
    return { kind: done.kind, ...exhausted };
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
    const harness = harnessOf(profile);
    const n = store.snapshot({ limit: 0 }).native;
    // A thread of another harness is the one before a switch whose new thread was not announced yet.
    if (n && n.harness === harness) return { harness: n.harness, account: n.account, model: n.model, nativeThreadId: n.nativeThreadId };
    // Claude announces its thread with the first turn; until then the account is the one the launch leased.
    const account = specFor(profile).anthropicAccount ? currentAccount(leaseHistory(this.d.db, "devbox", s.id)) : null;
    return { harness, account, model: null, nativeThreadId: null };
  }

  /** The requested target with its env and window. Accounts are checked as accountSwitch.ts does; the profile is
   *  attached only once the target is known to differ (attachProfile). */
  private async resolve(s: SessionRow, profile: AgentName, current: Target, req: SwitchRequest): Promise<Resolved> {
    if (isProxyProfile(profile)) return this.proxyTarget(profile);
    const harness = harnessOf(profile);
    // Leaving a proxy profile is not the same Claude: its model and (absent) account do not carry over.
    const keeps = harness === current.harness && !isProxyProfile(agentNameFor(s.agent));
    let model: string | null;
    if (req.kind === "model") {
      if (!CHAT_MODELS[harness].includes(req.model)) throw new SwitchRefused(400, "unknown-model", `${req.model} is not a ${harness} model chat sessions offer`);
      model = req.model;
    } else model = keeps ? current.model : null;
    const window = windowFor(harness, model);
    // An ACP agent runs on its own CLI login in its volume: no account to choose.
    if (harness !== "claude" && harness !== "codex") return { profile, target: { harness, account: null, model, env: {} }, window, exhausted: false };
    let choice: { account: string | null; exhausted: boolean };
    if (req.kind === "account") choice = harness === "claude" ? this.claudeAccount(s, req.accountId) : this.codexAccount(req.accountId);
    else if (keeps) choice = { account: current.account, exhausted: false };
    else choice = harness === "claude" ? this.claudeAccount(s, undefined) : this.codexAccount(undefined);
    const { account, exhausted } = choice;
    if (harness === "codex") {
      if (account === null) throw new SwitchRefused(409, "no-account", "the Codex account of this session is unknown");
      return { profile, target: { harness, account, model, env: {} }, window, exhausted };
    }
    return { profile, target: { harness, account, model, env: { CLAUDE_CONFIG_DIR: account === null ? CLAUDE_HOME : `${CLAUDE_ACCOUNTS_ROOT}/${account}` } }, window, exhausted };
  }

  /** A Claude pool account's profile must be attached to the container before the bridge can use it. The cause is
   *  logged here only: it may carry host paths or docker output. */
  private async attachProfile(s: SessionRow, t: SwitchTarget): Promise<void> {
    if (t.harness === "codex" && t.account !== null && this.d.codexAccountMounted) {
      let mounted: boolean;
      try { mounted = await this.d.codexAccountMounted(s.container, t.account); }
      catch (e) {
        this.log(`chat switch ${s.id}: checking the mount of Codex account ${t.account} failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new SwitchRefused(409, "profile-unavailable", "could not check whether the Codex account is mounted in this session");
      }
      // A Codex account home is mounted when the container is created; one added later needs a recreate.
      if (!mounted) throw new SwitchRefused(409, "account-not-mounted", `Codex account ${t.account} is not mounted in this session's container; recreate the container first`);
      return;
    }
    if (t.harness !== "claude" || t.account === null || !this.d.ensureClaudeProfile) return;
    try { await this.d.ensureClaudeProfile(s.container, t.account); }
    catch (e) {
      this.log(`chat switch ${s.id}: attaching Claude account ${t.account} failed: ${e instanceof Error ? e.message : String(e)}`);
      throw new SwitchRefused(409, "profile-unavailable", "the Claude account could not be attached to this session");
    }
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
    return { profile, target: { harness: "claude", account: null, model: inputs.DEVD_AGENT_MODEL, env: { ...env, CLAUDE_CONFIG_DIR: CLAUDE_HOME } }, window, exhausted: false };
  }

  /** accountSwitch.ts parity: a requested account is refused only when unknown, disabled, quarantined or permanently
   *  failing (expired, absent from toCandidates); without one the pool chooses as /api/accounts/lease does for a
   *  manual switch (force), including its all-exhausted branch. Over the threshold is allowed and reported. */
  private claudeAccount(s: SessionRow, requested: string | undefined): { account: string; exhausted: boolean } {
    const now = this.d.now();
    const settings = this.d.claudePool();
    const candidates = toCandidates(this.d.db);
    if (requested !== undefined) {
      const c = candidates.find((a) => a.id === requested);
      if (!c || c.disabled || c.quarantined) throw new SwitchRefused(400, "invalid-account", "that account does not exist or is disabled/quarantined");
      return { account: c.id, exhausted: isExhausted(c, now, settings.thresholdPct) };
    }
    const history = leaseHistory(this.d.db, "devbox", s.id);
    const decision = chooseAccount({
      candidates, current: currentAccount(history), lastSwitchAt: lastSwitchAt(history),
      now, force: true, project: s.project, repo: s.repo, settings,
    });
    if (decision.accountId === null) throw new SwitchRefused(409, "no-account", "no Anthropic account is available");
    return { account: decision.accountId, exhausted: decision.exhausted };
  }

  /** The same rule for Codex: disabled, signed out or a rejected login is refused; a reached limit is reported. */
  private codexAccount(requested: string | undefined): { account: string; exhausted: boolean } {
    let id = requested;
    if (id === undefined) {
      try { id = this.d.codexAccounts.select().accountId; }
      catch (e) { throw new SwitchRefused(409, "no-account", e instanceof Error ? e.message : String(e)); }
    }
    const a = this.d.codexAccounts.list().accounts.find((x) => x.id === id);
    if (!a || !codexAccountUsable(a)) throw new SwitchRefused(400, "invalid-account", "that Codex account does not exist, is disabled, signed out or its login was rejected");
    return { account: a.id, exhausted: codexLimitLive(a, this.d.now()) };
  }

  /** `switchId` only for a user's switch (run): a re-send of the same target is not a switch to confirm. */
  private sendTarget(sessionId: string, l: LastSwitch, switchId?: string): Promise<void> {
    const cmd: BridgeCommand = { kind: "switchTarget", target: l.target, resume: l.resume, handoff: l.handoff };
    if (switchId !== undefined) cmd.switchId = switchId;
    return this.d.links.send(sessionId, cmd, SWITCH_TIMEOUT_MS);
  }

  /** The bridge could not resume the thread `l` asked for: a fresh thread with the full handoff on the same target.
   *  devd may not know that thread (`l.resume` null: rebuilt after a devd restart from a store that never saw it
   *  announced); the bridge still awaits a fresh target, so it gets one, with nothing to mark as failed. */
  private replan(store: ThreadStore, l: LastSwitch): Transition {
    const t = planAfterResumeFailure(l.target, l.resume, store, "", { window: l.window, reserve: RESERVE_TOKENS, now: this.d.now() });
    const h = handoffOf(t);
    l.resume = null;
    l.handoff = h ? handoffDelivery(h) : null;
    l.resumeFailed = false;
    return t;
  }

  /** Ruling P5: a handoff that had no room for any history says so in the thread. */
  private noticeOmitted(store: ThreadStore, t: Transition): void {
    const h = handoffOf(t);
    if (h && h.preamble === null && h.omitted > 0) store.addNotice(historyOmittedNotice(h.omitted), this.d.now());
  }

  /** The bridge's target.applied: confirms the switch if the DB does not follow it yet (idempotent: the row goes with
   *  the first confirmation). A switch devd stopped waiting for (it is not the one being sent) was answered with an
   *  error: devd plans from the DB again from now on, and the thread says it went through. */
  private appliedByBridge(sessionId: string, switchId: string): void {
    const u = takeUnconfirmedSwitch(this.d.db, sessionId, switchId) as Unconfirmed | null;
    if (u === null) return;
    const s = getSession(this.d.db, sessionId);
    if (!s) return;
    this.confirmed(s, u.from, u.profile, u.current, u.target, u.kind);
    if (this.pending.get(sessionId)?.switchId === switchId) return;
    this.last.delete(sessionId);
    const what = u.profile !== u.from ? AGENTS[u.profile].label
      : u.target.account !== u.current.account ? `account ${u.target.account}` : `model ${u.target.model}`;
    this.d.threads(sessionId).addNotice(`The switch to ${what} went through after all: the agent confirmed it after devd stopped waiting.`, this.d.now());
  }

  private confirmed(s: SessionRow, from: AgentName, profile: AgentName, current: Target, target: Target, kind: Transition["kind"]): void {
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
      case "run.started":
        // A user message that started at once took it without a run.queued.
        if (l && ev.origin === "user") l.handoff = null;
        return;
      case "run.failed": {
        if (ev.error === "open-failed") {
          // The bridge could not open its persisted target at start (e.g. an ACP agent's login is gone) and awaits
          // one: devd sends it again with backoff, and the failure's own text lands in the thread (retryLater); the
          // user can switch away meanwhile. The thread itself is fine: no re-plan.
          this.awaiting.add(sessionId);
          this.resend(sessionId);
          return;
        }
        if (ev.error !== "resume-failed") return;
        // The bridge now awaits a fresh target (also at its start, e.g. a thread from before the shared Codex home).
        this.awaiting.add(sessionId);
        if (p) { p.resumeFailed = true; return; }
        // No target is being sent: the next attempt re-plans.
        this.resendState(sessionId).replan = true;
        this.resend(sessionId);
        return;
      }
      case "target.applied":
        this.appliedByBridge(sessionId, ev.switchId);
        return;
      case "bridge.started":
        // The bridge opened its own persisted or launch target (a recreated container may have leased another
        // account): devd plans from what it announces, not from its memory. An awaiting bridge says so in the handshake.
        if (!ev.awaitingTarget) this.last.delete(sessionId);
        return;
    }
  }

  private resendState(sessionId: string): Resend {
    let r = this.resends.get(sessionId);
    if (!r) {
      r = { attempt: 0, noticed: false, timer: null, running: false, replan: false };
      this.resends.set(sessionId, r);
    }
    return r;
  }

  /** Sends the awaited target now, unless an attempt is already under way (it decides what follows). */
  private resend(sessionId: string): void {
    const r = this.resendState(sessionId);
    if (r.running) return;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = null;
    void this.attempt(sessionId, r);
  }

  /** The bridge has a target: no more re-sends, and the next failure episode gets its own notice. */
  private settled(sessionId: string): void {
    this.awaiting.delete(sessionId);
    const r = this.resends.get(sessionId);
    if (r?.timer) clearTimeout(r.timer);
    this.resends.delete(sessionId);
  }

  private async attempt(sessionId: string, r: Resend): Promise<void> {
    // A user switch being sent sets the target itself; if it fails, this tries again later.
    if (this.inFlight.has(sessionId)) {
      this.schedule(sessionId, r);
      return;
    }
    r.running = true;
    this.inFlight.add(sessionId);
    let store: ThreadStore | null = null;
    try {
      store = this.d.threads(sessionId);
      const l = this.last.get(sessionId) ?? await this.rebuild(sessionId, store);
      this.last.set(sessionId, l);
      if (r.replan) {
        r.replan = false;
        l.resumeFailed = true;
      }
      if (l.resumeFailed) store.addNotice(freshThreadNotice(l.target.harness, this.replan(store, l)), this.d.now());
      this.pending.set(sessionId, l);
      try {
        await this.sendTarget(sessionId, l);
      } finally {
        this.pending.delete(sessionId);
      }
      // The thread the target named could not be resumed either.
      if (l.resumeFailed) {
        store.addNotice(freshThreadNotice(l.target.harness, this.replan(store, l)), this.d.now());
        await this.sendTarget(sessionId, l);
      }
      if (this.resends.get(sessionId) === r) this.settled(sessionId);
    } catch (e) {
      if (this.resends.get(sessionId) === r) this.retryLater(sessionId, store, e, r);
    } finally {
      this.inFlight.delete(sessionId);
      r.running = false;
    }
  }

  /** A failed send of the awaited target: said once in the thread per episode, tried again with backoff while the
   *  link is up; a link that is down tries again on its next handshake. */
  private retryLater(sessionId: string, store: ThreadStore | null, e: unknown, r = this.resendState(sessionId)): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.log(`chat switch ${sessionId}: sending the awaited target failed: ${msg}`);
    if (!r.noticed && store !== null) {
      r.noticed = true;
      store.addNotice(`The agent waits for its target (model, account, agent) and devd could not send it (${msg}); devd keeps trying. Picking a model, account or agent also sets it.`, this.d.now());
    }
    if (e instanceof AgentDisconnected && !(e instanceof CommandTimeout)) return;
    this.schedule(sessionId, r);
  }

  private schedule(sessionId: string, r: Resend): void {
    const delays = this.d.resendDelaysMs ?? RESEND_DELAYS_MS;
    const ms = delays[Math.min(r.attempt, delays.length - 1)]!;
    r.attempt++;
    if (r.timer !== null) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.timer = null;
      if (this.resends.get(sessionId) === r) this.resend(sessionId);
    }, ms);
  }

  /** The target from the DB and the store, for a bridge that waits for it after devd lost its memory (restart). An
   *  undelivered handoff is not known any more: the re-send carries none and the bridge keeps its own. */
  private async rebuild(sessionId: string, store: ThreadStore): Promise<LastSwitch> {
    const s = getSession(this.d.db, sessionId);
    if (!s) throw new Error("unknown session");
    const profile = agentNameFor(s.agent);
    const n = store.snapshot({ limit: 0 }).native;
    const harness = harnessOf(profile);
    const resume = n?.harness === harness ? n.nativeThreadId : null;
    if (isProxyProfile(profile)) {
      const r = await this.proxyTarget(profile);
      return { profile, target: r.target, window: r.window, resume, handoff: null, resumeFailed: false, switchId: null };
    }
    const model = n?.harness === harness ? n.model : null;
    const account = harness === "claude" ? currentAccount(leaseHistory(this.d.db, "devbox", sessionId)) : harness === "codex" && n?.harness === harness ? n.account : null;
    if (harness === "codex" && account === null) throw new Error("the Codex account of this session is unknown");
    const env: Record<string, string> = harness === "claude" ? { CLAUDE_CONFIG_DIR: account === null ? CLAUDE_HOME : `${CLAUDE_ACCOUNTS_ROOT}/${account}` } : {};
    return { profile, target: { harness, account, model, env }, window: windowFor(harness, model), resume, handoff: null, resumeFailed: false, switchId: null };
  }
}

/** The thread's record of a confirmed switch: what it switched to and how the conversation came along. Counts are
 *  handoff items (messages, commands, file changes, plans); a handoff with no room for history says so here and in
 *  the P5 notice that follows. */
function switchNotice(req: SwitchRequest, profile: AgentName, t: SwitchTarget, plan: Transition, resumeFailed = false): string {
  const what = req.kind === "harness" ? `Switched to ${AGENTS[profile].label}`
    : req.kind === "account" ? `Switched account to ${t.account}` : `Switched model to ${t.model}`;
  if (resumeFailed) return [what, "resume failed, started a fresh thread", freshHandoffText(plan)].filter((p) => p !== null).join(" · ");
  const resumed = plan.kind === "restart-resume" || plan.kind === "resume-with-delta" ? "resumed" : null;
  return [what, resumed, handedOver(plan)].filter((p) => p !== null).join(" · ");
}

/** The one notice of a failed resume devd re-planned without a switch of its own. */
function freshThreadNotice(harness: string, plan: Transition): string {
  return [resumeFailedNotice(harness), freshHandoffText(plan)].filter((p) => p !== null).join(" · ");
}

/** What a fresh thread after a failed resume got: the handoff, or (no room for any history) the P5 sentence, so the
 *  failed resume stays one notice. */
function freshHandoffText(plan: Transition): string | null {
  const h = handoffOf(plan);
  if (h && h.preamble === null && h.omitted > 0) return historyOmittedNotice(h.omitted);
  return handedOver(plan);
}

function handedOver(plan: Transition): string | null {
  const h = handoffOf(plan);
  if (h === null) return null;
  if (h.preamble === null) return h.omitted > 0 ? "no history handed over" : null;
  return `context handed over (${h.includedItemSeqs.length} items${h.omitted > 0 ? `, ${h.omitted} omitted` : ""})`;
}

/** The chat harness of a chat session's profile; chatRuntimeBlock keeps profiles without one out of chat sessions. */
function harnessOf(profile: AgentName): Harness {
  const h = chatHarness(profile);
  if (h === null) throw new Error(`${profile} has no chat harness`);
  return h;
}

/** The window of `model` (any id a harness reports, see MODEL_WINDOW_ALIASES); a null model is the harness
 *  default, planned with the smallest window of the models it offers. */
function windowFor(harness: Harness, model: string | null): number {
  if (model === null) return Math.min(...CHAT_MODELS[harness].map((m) => BASE_WINDOWS[m]!));
  const base = MODEL_WINDOW_ALIASES[model];
  if (base === undefined) throw new SwitchRefused(409, "unknown-model-window", `the context window of model ${model} is unknown to devd (MODEL_WINDOW_ALIASES)`);
  return BASE_WINDOWS[base]!;
}
