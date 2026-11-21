import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Asterisk, Check, ChevronDown, Hexagon, LoaderCircle, Orbit, Wind, Zap } from "lucide-react";
import type { ThreadSnapshot } from "../../../../shared/thread";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, ApiError, type ChatSwitchResult, type ChatTarget } from "../../api";
import { profileFor } from "../../newSession";
import {
  accountMenuBlocked, awaitingTargetText, claudeAccountOptions, codexAccountOptions, effortChipLabel, effortFooter, effortMenuBlocked, effortOptions, harnessOptions,
  modelLabel, modelMenuBlocked, modelOptions, switchBlocked, switchErrorText, switchResultText, type SwitchOption,
} from "../../switchView";

type Which = "harness" | "model" | "account" | "effort";
const errorText = (e: unknown) => (e instanceof ApiError ? switchErrorText(e.status, e.body) : (e as Error).message);

/** Model, effort, account and harness menus of a chat session. devd applies a switch between turns and records it in the
 *  thread as a notice, which arrives over the stream. The menus show the target devd plans the next switch from
 *  (GET thread/target), re-read when the thread announces a new native thread or a run ends.
 *  Rendered through `children` in two parts: the menus sit inside the composer box, the status lines above it. */
export function Switchers({ sessionId, thread, children }: {
  sessionId: string;
  thread: ThreadSnapshot;
  children: (parts: { menus: ReactNode; status: ReactNode }) => ReactNode;
}) {
  const [target, setTarget] = useState<ChatTarget | null>(null);
  const [targetErr, setTargetErr] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SwitchOption[] | null>(null);
  const [accountsErr, setAccountsErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Which | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const n = thread.native;
  const ended = thread.runs.filter((r) => r.endedSeq !== null).length;
  // A queued message or a devd notice (a bridge restart, a failed resume) may mean the bridge now awaits its target.
  const notices = thread.items.filter((i) => i.kind === "notice").length;
  const runCount = thread.runs.length;
  const loadTarget = useCallback(() => api.chatTarget(sessionId).then(
    (t) => { setTarget(t); setTargetErr(null); },
    (e) => setTargetErr(`Could not read the current agent: ${errorText(e)}`),
  ), [sessionId]);
  useEffect(() => { void loadTarget(); }, [loadTarget, n?.harness, n?.nativeThreadId, n?.model, n?.account, ended, runCount, notices]);
  // A result note belongs to the last switch; the next message the user sends is a new action.
  const runs = thread.runs.length;
  useEffect(() => { setNote(null); }, [runs]);

  const loadAccounts = useCallback(async (t: ChatTarget) => {
    setAccounts(null); setAccountsErr(null);
    try {
      if (t.harness === "codex") {
        const r = await api.codexAccounts();
        setAccounts(codexAccountOptions(r.accounts, Date.now(), t));
      } else {
        const r = await api.accounts();
        setAccounts(claudeAccountOptions(r.accounts, r.pool.thresholdPct, Date.now(), t));
      }
    } catch (e) { setAccountsErr(errorText(e)); }
  }, []);

  async function doSwitch(which: Which, value: string, call: () => Promise<ChatSwitchResult>) {
    setBusy(which); setErr(null); setNote(null);
    try { setNote(switchResultText(await call())); }
    catch (e) {
      setErr(`${which === "harness" ? "Agent" : which === "model" ? "Model" : "Account"} switch to ${value} failed: ${errorText(e)}`);
    }
    // Also after a timeout: the bridge may have switched, and the triggers should say where it is.
    await loadTarget();
    setBusy(null);
  }

  // The level arrives back as the bridge's effort.state over the stream; no target to reload.
  async function setEffort(level: string | null, label: string) {
    setBusy("effort"); setErr(null); setNote(null);
    try { await api.setChatEffort(sessionId, level); }
    catch (e) { setErr(`Effort change to ${label} failed: ${errorText(e)}`); }
    setBusy(null);
  }

  if (!target) {
    const status = targetErr ? (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        {targetErr}
        <Button type="button" variant="outline" size="xs" onClick={() => void loadTarget()}>Retry</Button>
      </p>
    ) : null;
    return children({ menus: null, status });
  }
  const blocked = switchBlocked(thread, target);
  const awaiting = awaitingTargetText(target);
  const profile = profileFor(target.agent);

  // A readable name only for a model the menu ticks; any other id (a dated or effort variant) shows as reported.
  const model = target.model === null ? "Default model"
    : modelOptions(target).some((o) => o.current) ? modelLabel(target.model) : target.model;
  const accountBlocked = accountMenuBlocked(target);
  const accountTitle = target.harness === "codex" ? "Codex account" : "Claude account";
  const effort = effortChipLabel(thread.effort, target);
  const effortBlocked = effortMenuBlocked(thread.effort, target);
  // Model and agent only: the account (an email, a plan) is shown inside the menu, never in the chip's label or tooltip.
  const summary = `Model: ${model}${effort === null ? "" : `, effort ${effort}`}, agent ${profile.label}`;
  // One chip with the agent and model; the menu holds agent, model and account. It opens also while switching is
  // blocked, so the current account stays visible; the items are then disabled and the reason is shown.
  const menus = (
    <DropdownMenu onOpenChange={(open) => { if (open && accountBlocked === null) void loadAccounts(target); }}>
      <DropdownMenuTrigger asChild disabled={busy !== null}>
        <Button
          type="button" variant="ghost" size="sm" aria-label={summary} title={summary}
          className="h-8 min-w-0 max-w-56 shrink gap-1.5 rounded-full px-2.5 font-medium text-foreground/90 hover:bg-accent hover:text-foreground has-[>svg]:px-2.5 data-[state=open]:bg-accent data-[state=open]:text-foreground sm:max-w-64"
        >
          {busy !== null ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <AgentGlyph agent={target.agent} />}
          {/* On a phone's one-row composer with text, only the agent mark and the chevron (the box sets data-chip). */}
          <span className="truncate max-sm:group-data-[chip=mark]/box:hidden">
            {model}{effort !== null && <><span className="text-muted-foreground"> · </span><span className="font-semibold">{effort}</span></>}
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" sideOffset={8} collisionPadding={16} className="w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
        {/* Shown in the menu, where switching is tried: visible text, not a tooltip (touch has no hover). */}
        {blocked && <p className="px-2 pb-1 pt-1.5 text-xs text-muted-foreground">{blocked}</p>}
        <Section
          title="Agent" nameTooltip blocked={blocked} options={harnessOptions(target)}
          render={(o) => <span className="flex items-center gap-2"><AgentGlyph agent={o.value as ChatTarget["agent"]} />{o.label}</span>}
          onPick={(o) => void doSwitch("harness", o.label, () => api.switchChatHarness(sessionId, o.value as ChatTarget["agent"]))}
        />
        <DropdownMenuSeparator />
        <Section
          title="Model" nameTooltip blocked={blocked ?? modelMenuBlocked(target)} options={modelOptions(target)}
          render={(o) => <span className="flex min-w-0 items-baseline gap-2"><span className="truncate">{modelLabel(o.label)}</span>
            {modelLabel(o.label) !== o.label && <span className="truncate font-mono text-[11px] text-muted-foreground">{o.label}</span>}</span>}
          onPick={(o) => void doSwitch("model", o.label, () => api.switchChatModel(sessionId, o.value))}
        />
        <DropdownMenuSeparator />
        {/* Not blocked by a run: the bridge applies the level from the next message. */}
        <Section
          title="Effort" blocked={effortBlocked} options={effortBlocked === null && thread.effort ? effortOptions(thread.effort) : null}
          render={(o) => <span className="truncate">{o.label}</span>}
          onPick={(o) => void setEffort(o.value === "" ? null : o.value, o.label)}
        />
        {effortBlocked === null && thread.effort && <p className="px-2 pb-1.5 text-xs text-muted-foreground">{effortFooter(thread.effort)}</p>}
        <DropdownMenuSeparator />
        <Section
          title={accountTitle} blocked={blocked ?? accountBlocked}
          // Loaded when the menu opens; a list loaded for another agent is not shown while this one has no pool.
          options={accountBlocked === null ? accounts : null} loadErr={accountBlocked === null ? accountsErr : null}
          current={accountBlocked === null ? null : target.account}
          render={(o) => <span className="truncate">{o.label}</span>}
          onPick={(o) => void doSwitch("account", o.label, () => api.switchChatAccount(sessionId, o.value))}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const lines = [
    awaiting && <p key="awaiting" role="status" className="text-xs text-muted-foreground">{awaiting}</p>,
    note && <p key="note" role="status" className="text-xs text-amber-700 dark:text-amber-300">{note}</p>,
    err && <p key="err" role="alert" className="text-xs text-destructive">{err}</p>,
    targetErr && <p key="targetErr" role="alert" className="text-xs text-destructive">{targetErr}</p>,
  ].filter(Boolean);
  return children({ menus, status: lines.length > 0 ? <div className="flex flex-col gap-1">{lines}</div> : null });
}

/** One section of the menu. Disabled options show their reason inline (a disabled menu item gets no hover, and touch
 *  has none); a blocked section shows its reason under the title, unless it is the menu-wide block shown at the top. */
function Section({ title, options, loadErr, blocked, current, render, onPick, nameTooltip = false }: {
  title: string;
  /** null = loading. */
  options: SwitchOption[] | null;
  loadErr?: string | null;
  blocked: string | null;
  /** Shown when the section has no options to list (no account pool): what runs now. */
  current?: string | null;
  render: (o: SwitchOption) => ReactNode;
  onPick: (o: SwitchOption) => void;
  /** The full name as a tooltip on truncated names: agents and models only, never account identifiers. */
  nameTooltip?: boolean;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">{title}</DropdownMenuLabel>
      {current != null && <p className="px-2 pb-1 text-sm">{current}</p>}
      {loadErr ? <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{loadErr}</p>
        : options === null ? (blocked ? <p className="px-2 pb-1.5 text-xs text-muted-foreground">{blocked}</p> : <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>)
        : options.length === 0 ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing to switch to</p>
        : options.map((o) => (
          // A disabled option dims only its name: the reason under it stays readable.
          <DropdownMenuItem key={o.value} disabled={blocked !== null || o.disabled !== null} onSelect={() => { if (!o.current) onPick(o); }} className="items-start data-[disabled]:opacity-100">
            <Check className={o.current ? "mt-0.5" : "invisible mt-0.5"} aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span title={nameTooltip ? o.label : undefined} className={blocked || o.disabled ? "block min-w-0 truncate opacity-50" : "block min-w-0 truncate"}>{render(o)}</span>
              {o.detail && <span className={o.disabled ? "text-xs text-muted-foreground opacity-50" : "text-xs text-muted-foreground"}>{o.detail}</span>}
              {o.warning && <span className="text-xs font-medium text-amber-700 dark:text-amber-300">{o.warning}</span>}
              {o.disabled && <span className="text-xs text-muted-foreground">{o.disabled}</span>}
            </span>
          </DropdownMenuItem>
        ))}
    </DropdownMenuGroup>
  );
}

/** A small tinted mark per agent runtime, so the chip says which agent runs without spelling it out. */
export function AgentGlyph({ agent }: { agent: ChatTarget["agent"] }) {
  const runtime = profileFor(agent).runtime;
  const [Icon, tint] = runtime === "claude" ? [Asterisk, "text-orange-600 dark:text-orange-400"]
    : runtime === "codex" ? [Hexagon, "text-sky-600 dark:text-sky-400"]
    : runtime === "grok" ? [Zap, "text-foreground"]
    : runtime === "agy" ? [Orbit, "text-violet-600 dark:text-violet-400"]
    : [Wind, "text-amber-600 dark:text-amber-400"];
  return <Icon className={`size-4 shrink-0 ${tint}`} strokeWidth={2.5} aria-hidden="true" />;
}
