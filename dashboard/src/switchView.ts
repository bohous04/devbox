// Pure logic of the chat composer's switchers (components/chat/Switchers.tsx): which models, accounts and
// harnesses can be picked and why not. devd decides (devd/src/chatSwitch.ts); these mirror its rules so the
// menus do not offer what it would refuse, and say why.
import type { RunRow, ThreadEffort } from "../../shared/thread";
import { CLAUDE_EFFORT_LEVELS } from "../../shared/effort";
import { ACP_MIN_BRIDGE_VERSION, EFFORT_MIN_BRIDGE_VERSION, versionAtLeast } from "../../shared/bridgeVersion";
import { CHAT_MODELS, SAME_MODEL_ALIASES } from "../../shared/chatModels";
import type { AccountView, AgentName, ChatSwitchResult, ChatTarget, CodexAccountView, SessionRuntime } from "./api";
import { AGENT_IDS, AGENT_PROFILES, chatRuntimeBlock, profileFor } from "./newSession";
import { codexWindowLabel } from "./subscriptionsView";

export interface SwitchOption {
  value: string;
  label: string;
  /** Second line, e.g. usage. */
  detail: string | null;
  current: boolean;
  /** Why it cannot be picked; null = it can. */
  disabled: string | null;
  /** Can be picked, but the user should know (an account over its limit). */
  warning: string | null;
}

const option = (value: string, label: string, current: boolean, o: Partial<SwitchOption> = {}): SwitchOption =>
  ({ value, label, detail: null, current, disabled: null, warning: null, ...o });

/** devd refuses a switch with 409 run-active while a run is active or a message is queued: it applies between turns.
 *  Not while the bridge awaits its target: the queued messages wait for exactly that. */
export function switchBlocked(t: { runs: RunRow[] }, target: Pick<ChatTarget, "awaitingTarget">): string | null {
  if (target.awaitingTarget) return null;
  if (t.runs.some((r) => r.status === "running")) return "A run is active: stop it or wait for it to end, then switch";
  if (t.runs.some((r) => r.endedSeq === null)) return "A message is queued: switch after it has run";
  return null;
}

/** Shown while the bridge awaits its target: picking any model, account or agent (also the current one) sends it. */
export function awaitingTargetText(t: Pick<ChatTarget, "awaitingTarget">): string | null {
  return t.awaitingTarget ? "Agent is waiting for a target: pick a model, account or agent to continue" : null;
}

/** A proxy profile's model is set in settings.proxyModels (devd: 400 model-set-by-profile). */
export function modelMenuBlocked(t: ChatTarget): string | null {
  const p = profileFor(t.agent);
  return p.proxy ? `The model of ${p.label} is set in settings` : null;
}

/** The models devd accepts for the harness (shared/chatModels.ts). A reported id in SAME_MODEL_ALIASES marks the
 *  model it runs; a reported variant (an effort or dated id) marks nothing: picking its base model is a real switch
 *  for devd. */
export function modelOptions(t: ChatTarget): SwitchOption[] {
  const models: readonly string[] = Object.hasOwn(CHAT_MODELS, t.harness) ? CHAT_MODELS[t.harness as keyof typeof CHAT_MODELS] : [];
  const current = t.model !== null && Object.hasOwn(SAME_MODEL_ALIASES, t.model) ? SAME_MODEL_ALIASES[t.model] : t.model;
  return models.map((m) => option(m, m, m === current));
}

const FAMILY_PREFIX: Readonly<Record<string, string | null>> = { claude: null, gpt: "GPT-", grok: "Grok ", mistral: "Mistral ", gemini: "Gemini " };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** Display name of a model id for the composer ("claude-opus-5-5-high" → "Opus 5.5 High"). Display only: switches
 *  and devd keep the id. An id of an unknown family or shape stays the raw id, so nothing is guessed. */
export function modelLabel(id: string): string {
  const resolved = Object.hasOwn(SAME_MODEL_ALIASES, id) ? SAME_MODEL_ALIASES[id] : id;
  const [family, ...rest] = resolved.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "").split("-");
  if (!Object.hasOwn(FAMILY_PREFIX, family) || rest.length === 0 || rest.some((t) => !/^[a-z0-9.]+$/.test(t))) return id;
  // Version parts split by dashes ("5-5") join with dots; words are capitalised.
  const parts: string[] = [];
  for (const t of rest) {
    const prev = parts[parts.length - 1];
    if (/^\d+$/.test(t) && prev !== undefined && /^\d+$/.test(prev)) parts[parts.length - 1] = `${prev}.${t}`;
    else parts.push(t);
  }
  const prefix = FAMILY_PREFIX[family];
  if (prefix === null) return parts.map(cap).join(" ");
  const [first, ...more] = parts;
  return prefix === "GPT-" ? [`GPT-${first}`, ...more.map(cap)].join(" ") : `${prefix}${parts.map(cap).join(" ")}`;
}

/** devd: 400 no-account-pool. Proxy profiles and ACP agents (their own CLI login) have no account pool. */
export function accountMenuBlocked(t: ChatTarget): string | null {
  const p = profileFor(t.agent);
  return p.proxy || (p.runtime !== "claude" && p.runtime !== "codex") ? `${p.label} runs on no account pool` : null;
}

const pctText = (pct: number | null) => (pct === null ? "—" : `${Math.round(pct)}%`);
/** devd accountPolicy windowOver: over the threshold and not reset yet (an unknown reset counts as not yet). */
const overWindow = (pct: number | null, resetsAt: number | null, now: number, threshold: number) =>
  pct !== null && pct >= threshold && (resetsAt === null || resetsAt > now);

/** Claude pool accounts, accountSwitch parity (ruling P15): quarantined, disabled and permanently unmeasured
 *  (expired: an error and no numbers at all, devd's permanentlyUnmeasured) cannot be picked; an account over the
 *  threshold can, with a warning. */
export function claudeAccountOptions(accounts: AccountView[], thresholdPct: number, now: number, t: ChatTarget): SwitchOption[] {
  return accounts.map((a) => {
    const disabled = a.quarantined ? "Quarantined: sign in again on the Auth page"
      : a.disabled ? "Disabled"
      : a.error !== null && a.fiveHourPct === null && a.sevenDayPct === null ? `Login expired or unusable (${a.error})`
      : null;
    const over = [[a.fiveHourPct, a.fiveHourResetsAt], [a.sevenDayPct, a.sevenDayResetsAt]] as const;
    const overPct = over.filter(([p, r]) => overWindow(p, r, now, thresholdPct)).map(([p]) => p!);
    return option(a.id, a.label, a.id === t.account, {
      detail: `5h ${pctText(a.fiveHourPct)} · 7d ${pctText(a.sevenDayPct)}`,
      disabled,
      warning: overPct.length ? `over limit (${pctText(Math.max(...overPct))})` : null,
    });
  });
}

/** Codex accounts, devd's codexAccountUsable / codexLimitLive: disabled, signed out or a rejected login cannot be
 *  picked; a reached limit whose window has not reset can, with a warning. */
export function codexAccountOptions(accounts: CodexAccountView[], now: number, t: ChatTarget): SwitchOption[] {
  return accounts.map((a) => {
    const u = a.usage;
    const disabled = a.disabled ? "Disabled"
      : u?.state === "signed-out" ? "Signed out: sign in on the Subscriptions page"
      : u?.state === "error" && /HTTP (401|402|403)|deactivated|invalid_grant/i.test(u.error ?? "") ? `Login rejected (${u.error})`
      : null;
    const measured = u?.windows.filter((w) => w.usedPct !== null) ?? [];
    const live = !!u?.limitReached && (!measured.length || measured.some((w) => w.resetsAt === null || w.resetsAt > now));
    const livePct = measured.filter((w) => w.resetsAt === null || w.resetsAt > now).map((w) => w.usedPct!);
    return option(a.id, a.label, a.id === t.account, {
      detail: measured.length ? measured.map((w) => `${codexWindowLabel(w.windowMinutes)} ${pctText(w.usedPct)}`).join(" · ") : null,
      disabled,
      warning: live ? (livePct.length ? `over limit (${pctText(Math.max(...livePct))})` : "over limit") : null,
    });
  });
}

/** Every profile, the ones chat cannot run disabled with devd's reason (chatRuntimeBlock, or an ACP agent on a bridge older
 *  than ACP_MIN_BRIDGE_VERSION). */
export function harnessOptions(t: ChatTarget): SwitchOption[] {
  const oldBridge = t.bridgeVersion !== null && !versionAtLeast(t.bridgeVersion, ACP_MIN_BRIDGE_VERSION);
  return AGENT_IDS.map((id) => {
    const p = AGENT_PROFILES[id];
    // devd: 409 bridge-too-old, same text.
    const disabled = chatRuntimeBlock(id, "vps") ?? (oldBridge && p.acp !== undefined ? `recreate the container to use ${p.label}` : null);
    return option(id, p.label, id === t.agent, { disabled });
  });
}

/** What the switchers show when devd refused or the bridge did not confirm. The code stays visible when there is no
 *  sentence for it, so the problem can be traced. */
export function switchErrorText(status: number, body: unknown): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as { error?: unknown; message?: unknown };
  const msg = typeof b.message === "string" ? b.message : null;
  switch (b.error) {
    case "run-active": return "A run is active or a message is queued: switch after it ends";
    case "switch-in-progress": return "Another switch is already in progress";
    case "agent-disconnected": return "Agent not connected: nothing was switched";
    case "agent-timeout": return "No reply from the agent: the switch may have happened, check the thread before retrying";
  }
  if (typeof b.error === "string") return msg ? `${msg} (${b.error})` : b.error;
  return `HTTP ${status}`;
}

/** A confirmed switch says itself in the thread (devd's notice); this is only what the notice does not say. */
export function switchResultText(r: ChatSwitchResult): string | null {
  if (r.unchanged) return r.exhausted ? "Already on that account; it is over its usage limit" : "Already on that: nothing was switched";
  if (r.exhausted) return "Switched, but the account is over its usage limit";
  return null;
}

const EFFORT_LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
/** A level as the agent names it; one this list does not know shows as reported. */
export const effortLabel = (level: string): string => EFFORT_LABELS[level] ?? level;

const effortBridge = (t: Pick<ChatTarget, "bridgeVersion">) => t.bridgeVersion !== null && versionAtLeast(t.bridgeVersion, EFFORT_MIN_BRIDGE_VERSION);

/** The level part of the composer's chip ("Opus 5.5 · High"): the level the agent reported running at (it may lower a
 *  choice), else the choice not yet run, else "Default" (Claude says its level only with a reply). null = no level part: an agent without levels, levels
 *  not reported yet, or a bridge that cannot report them. */
export function effortChipLabel(e: ThreadEffort | null, t: Pick<ChatTarget, "bridgeVersion">): string | null {
  if (!effortBridge(t) || e === null || (e.supported !== null && e.supported.length === 0)) return null;
  const level = e.effective ?? e.chosen;
  return level === null ? "Default" : effortLabel(level);
}

/** Why the Effort section cannot be used (devd answers 409 bridge-too-old, the bridge refuses unknown levels). Not
 *  blocked by a run: the level applies from the next message. */
export function effortMenuBlocked(e: ThreadEffort | null, t: Pick<ChatTarget, "bridgeVersion">): string | null {
  if (!effortBridge(t)) return `This session's agent bridge (${t.bridgeVersion ?? "unknown version"}) cannot change the effort: recreate the session's container`;
  if (e === null) return "The agent has not reported its effort levels yet";
  // Before the model names its levels the bridge (1.8.0) may take unchecked ones (effortFooter says when they are checked).
  if (e.supported === null && e.unchecked) return null;
  if (e.supported === null) return `The agent has not reported the effort levels of ${e.model ?? "this model"}`;
  if (e.supported.length === 0) return `${e.model ?? "This model"} has no effort levels`;
  return null;
}

/** "Default" (value "": the model's own level, sent as null) and the levels the model lists, or before it does, the
 *  unchecked ones the agent takes. */
export function effortOptions(e: ThreadEffort): SwitchOption[] {
  const detail = e.chosen === null && e.effective !== null ? `${effortLabel(e.effective)} for ${e.model ?? "this model"}`
    : e.chosen === null ? "The level shows after the agent's first reply" : null;
  const levels = e.supported !== null ? e.supported : e.unchecked ?? [];
  return [option("", "Default", e.chosen === null, { detail }), ...levels.map((l) => option(l, effortLabel(l), e.chosen === l))];
}

/** The line under the Effort section: when a pick applies, and for unchecked levels, that the next message checks it
 *  (a level the model lacks goes back to its default, said in the thread). */
export const effortFooter = (e: ThreadEffort): string =>
  e.supported === null && e.unchecked ? "Applies from your next message, which checks it against the model." : "Applies from your next message.";

/** The Effort section /new offers (the agent chip's menu): Claude's levels in a chat session, unchecked like a thread's
 *  before its first reply, so the first message checks them against the model. null = not offered: another agent has
 *  no levels before its session reports them (Codex's come from its model list, inside the container). */
export function newSessionEffort(agent: AgentName, runtime: SessionRuntime | null, chosen: string | null = null): SwitchOption[] | null {
  if (agent !== "claude" || runtime !== "chat") return null;
  return effortOptions({ model: null, supported: null, effective: null, chosen, unchecked: [...CLAUDE_EFFORT_LEVELS] });
}

/** devd sets the effort with the first message (POST /api/sessions refuses it without one): said before the press. */
export const newSessionEffortBlock = (prompt: string, effort: string | null): string | null =>
  effort !== null && prompt === "" ? "Effort is set with your first message: type one, or set it back to Default." : null;
