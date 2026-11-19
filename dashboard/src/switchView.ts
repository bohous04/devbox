// Pure logic of the chat composer's switchers (components/chat/Switchers.tsx): which models, accounts and
// harnesses can be picked and why not. devd decides (devd/src/chatSwitch.ts); these mirror its rules so the
// menus do not offer what it would refuse, and say why.
import type { RunRow } from "../../shared/thread";
import { CHAT_MODELS } from "../../shared/chatModels";
import type { AccountView, ChatSwitchResult, ChatTarget, CodexAccountView } from "./api";
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

/** The models devd accepts for the harness (shared/chatModels.ts). A reported variant (an effort or dated id) marks
 *  nothing: picking its base model is a real switch for devd. */
export function modelOptions(t: ChatTarget): SwitchOption[] {
  const models: readonly string[] = t.harness === "claude" || t.harness === "codex" ? CHAT_MODELS[t.harness] : [];
  return models.map((m) => option(m, m, m === t.model));
}

/** devd: 400 no-account-pool. */
export function accountMenuBlocked(t: ChatTarget): string | null {
  const p = profileFor(t.agent);
  return p.proxy ? `${p.label} runs on no account pool` : null;
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

/** Every profile, the ones chat cannot run disabled with devd's reason (chatRuntimeBlock). */
export function harnessOptions(t: ChatTarget): SwitchOption[] {
  return AGENT_IDS.map((id) => option(id, AGENT_PROFILES[id].label, id === t.agent, { disabled: chatRuntimeBlock(id, "vps") }));
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
